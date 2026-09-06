use age::secrecy::SecretString;
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, backup::Backup};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
struct Envelope {
    format: String,
    db_schema: String,
    store_id: String,
    created_at: String,
    sha256: String,
    database_base64: String,
}

fn sha256(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

pub fn export(db_path: &Path, output: &Path, passphrase: &str) -> Result<()> {
    if passphrase.chars().count() < 12 {
        bail!("恢复口令至少 12 位");
    }
    let src = Connection::open(db_path)?;
    src.execute_batch("PRAGMA busy_timeout=5000")?;
    let snapshot = temp_path(output, "snapshot");
    if snapshot.exists() {
        std::fs::remove_file(&snapshot)?;
    }
    {
        let mut dst = Connection::open(&snapshot)?;
        Backup::new(&src, &mut dst)?.run_to_completion(
            64,
            std::time::Duration::from_millis(10),
            None,
        )?;
    }
    let bytes = std::fs::read(&snapshot)?;
    let (store_id, schema): (String, String) = src.query_row(
        "SELECT store_id,schema_version FROM store_meta WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let envelope = Envelope {
        format: "swinv-age-v1".into(),
        db_schema: schema,
        store_id,
        created_at: chrono::Utc::now().to_rfc3339(),
        sha256: sha256(&bytes),
        database_base64: STANDARD.encode(&bytes),
    };
    let plaintext = serde_json::to_vec(&envelope)?;
    // A fixed factor keeps backups portable between a fast phone/Mac and a very small VPS.
    // The recovery passphrase is high-entropy, so log_n=16 remains appropriate while
    // avoiding device-calibrated files that another machine rejects as excessive work.
    let mut recipient = age::scrypt::Recipient::new(SecretString::from(passphrase.to_owned()));
    recipient.set_work_factor(16);
    let encryptor =
        age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))?;
    let file = File::create(output).with_context(|| format!("无法创建 {}", output.display()))?;
    let mut writer = encryptor.wrap_output(file)?;
    writer.write_all(&plaintext)?;
    writer.finish()?;
    let _ = std::fs::remove_file(snapshot);
    Ok(())
}

pub fn inspect(path: &Path, passphrase: &str) -> Result<serde_json::Value> {
    let envelope = decrypt(path, passphrase)?;
    Ok(
        serde_json::json!({"format":envelope.format,"db_schema":envelope.db_schema,"store_id":envelope.store_id,"created_at":envelope.created_at,"sha256":envelope.sha256}),
    )
}

pub fn restore(input: &Path, db_path: &Path, passphrase: &str) -> Result<()> {
    let envelope = decrypt(input, passphrase)?;
    if envelope.format != "swinv-age-v1" {
        bail!("不支持的备份格式");
    }
    let bytes = STANDARD.decode(&envelope.database_base64)?;
    if sha256(&bytes) != envelope.sha256 {
        bail!("备份 SHA-256 校验失败");
    }
    let candidate = temp_path(db_path, "restore");
    if candidate.exists() {
        std::fs::remove_file(&candidate)?;
    }
    std::fs::write(&candidate, &bytes)?;
    {
        let conn = crate::db::open(&candidate)?;
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if integrity != "ok" {
            bail!("SQLite 完整性校验失败: {integrity}");
        }
        let store: String =
            conn.query_row("SELECT store_id FROM store_meta WHERE id=1", [], |r| {
                r.get(0)
            })?;
        if store != envelope.store_id {
            bail!("备份清单与数据库 store_id 不一致");
        }
        conn.execute("UPDATE users SET token_version=token_version+1", [])?;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", db_path.display()));
        if sidecar.exists() {
            std::fs::remove_file(sidecar)?;
        }
    }
    std::fs::rename(&candidate, db_path).context("原子替换数据库失败")?;
    Ok(())
}

fn decrypt(path: &Path, passphrase: &str) -> Result<Envelope> {
    let mut encrypted = Vec::new();
    File::open(path)?.read_to_end(&mut encrypted)?;
    let decryptor = age::Decryptor::new(&encrypted[..])?;
    let identity = age::scrypt::Identity::new(SecretString::from(passphrase.to_owned()));
    let mut reader = decryptor.decrypt(std::iter::once(&identity as &dyn age::Identity))?;
    let mut plaintext = Vec::new();
    reader.read_to_end(&mut plaintext)?;
    Ok(serde_json::from_slice(&plaintext)?)
}

fn temp_path(base: &Path, label: &str) -> PathBuf {
    let mut name = base.as_os_str().to_owned();
    name.push(format!(".{label}.tmp"));
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_backup_roundtrip() {
        let d = tempfile::tempdir().unwrap();
        let db = d.path().join("a.db");
        let conn = crate::db::open(&db).unwrap();
        conn.execute("INSERT INTO items(name,category,unit,shelf_life_days,min_stock,active,sort_order,created_at) VALUES('x','','个',7,0,1,0,CURRENT_TIMESTAMP)",[]).unwrap();
        drop(conn);
        let file = d.path().join("a.swinv.age");
        export(&db, &file, "correct horse battery").unwrap();
        let restored = d.path().join("b.db");
        restore(&file, &restored, "correct horse battery").unwrap();
        let c = Connection::open(restored).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM items", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
