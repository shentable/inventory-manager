mod api;
mod auth;
mod backup;
mod db;
mod quantity;

use anyhow::{Context, Result, bail};
use axum_server::tls_rustls::RustlsConfig;
use clap::{Parser, Subcommand};
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Parser)]
#[command(
    name = "sandwich-server",
    version,
    about = "门店库存 Android 原生后端与迁移工具"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long)]
        db: PathBuf,
        #[arg(long)]
        secret_file: Option<PathBuf>,
        #[arg(long)]
        bootstrap_pin_file: Option<PathBuf>,
        #[arg(long, default_value = "127.0.0.1:8000")]
        listen: SocketAddr,
        /// 可选公网 IPv6 HTTPS 监听；必须同时提供证书和私钥。
        #[arg(long)]
        public_listen: Option<SocketAddr>,
        #[arg(long, requires = "public_listen")]
        tls_cert: Option<PathBuf>,
        #[arg(long, requires = "public_listen")]
        tls_key: Option<PathBuf>,
        #[arg(long,default_value=env!("CARGO_PKG_VERSION"))]
        app_version: String,
        /// 健康接口中的部署类型；Android 保持默认值，Linux 部署显式传 linux_native。
        #[arg(long, default_value = "android_native", value_parser = ["android_native", "linux_native"])]
        backend_kind: String,
    },
    Migrate {
        #[arg(long)]
        db: PathBuf,
    },
    Backup {
        #[arg(long)]
        db: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long)]
        passphrase_file: Option<PathBuf>,
    },
    InspectBackup {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        passphrase_file: Option<PathBuf>,
    },
    Restore {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        db: PathBuf,
        #[arg(long)]
        passphrase_file: Option<PathBuf>,
    },
}

fn private_text(path: &PathBuf) -> Result<String> {
    Ok(std::fs::read_to_string(path)
        .with_context(|| format!("无法读取 {}", path.display()))?
        .trim()
        .to_owned())
}

fn private_input(path: Option<&PathBuf>, env_name: &str) -> Result<String> {
    if let Some(path) = path {
        return private_text(path);
    }
    std::env::var(env_name)
        .with_context(|| format!("必须提供文件参数或仅对子进程设置 {env_name}"))
        .map(|value| value.trim().to_owned())
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Migrate { db: path } => {
            db::open(&path)?;
            println!("{}", db::DB_SCHEMA);
        }
        Command::Backup {
            db,
            output,
            passphrase_file,
        } => backup::export(
            &db,
            &output,
            &private_input(passphrase_file.as_ref(), "SANDWICH_RECOVERY_PASSPHRASE")?,
        )?,
        Command::InspectBackup {
            input,
            passphrase_file,
        } => println!(
            "{}",
            serde_json::to_string_pretty(&backup::inspect(
                &input,
                &private_input(passphrase_file.as_ref(), "SANDWICH_RECOVERY_PASSPHRASE")?
            )?)?
        ),
        Command::Restore {
            input,
            db,
            passphrase_file,
        } => backup::restore(
            &input,
            &db,
            &private_input(passphrase_file.as_ref(), "SANDWICH_RECOVERY_PASSPHRASE")?,
        )?,
        Command::Serve {
            db: path,
            secret_file,
            bootstrap_pin_file,
            listen,
            public_listen,
            tls_cert,
            tls_key,
            app_version,
            backend_kind,
        } => {
            if !listen.ip().is_loopback() {
                bail!("安全限制：原生后端只能监听回环地址");
            }
            if let Some(public) = public_listen {
                if !public.ip().is_ipv6() || !public.ip().is_unspecified() || public.port() < 1024 {
                    bail!("公网 HTTPS 只能监听 [::] 的非特权端口");
                }
                if tls_cert.is_none() || tls_key.is_none() {
                    bail!("公网 HTTPS 必须同时提供 --tls-cert 和 --tls-key");
                }
            }
            let secret = private_input(secret_file.as_ref(), "SANDWICH_TOKEN_SECRET")?;
            if secret.len() < 16 {
                bail!("Token 密钥至少 16 字节");
            }
            let conn = db::open(&path)?;
            let pin = bootstrap_pin_file
                .as_ref()
                .map(private_text)
                .transpose()?
                .or_else(|| std::env::var("SANDWICH_BOOTSTRAP_PIN").ok());
            db::bootstrap_admin(&conn, pin.as_deref())?;
            let state = api::AppState {
                db: Arc::new(Mutex::new(conn)),
                db_path: Arc::new(path),
                secret: Arc::new(secret.into_bytes()),
                app_version: Arc::new(app_version),
                backend_kind: Arc::new(backend_kind),
            };
            let listener = tokio::net::TcpListener::bind(listen).await?;
            println!("sandwich native backend listening on http://{listen}");
            let local = axum::serve(
                listener,
                api::router(state.clone()).into_make_service_with_connect_info::<SocketAddr>(),
            );
            if let Some(public) = public_listen {
                let tls = RustlsConfig::from_pem_file(
                    tls_cert.expect("checked tls cert"),
                    tls_key.expect("checked tls key"),
                )
                .await
                .context("无法读取公网 HTTPS 证书/私钥")?;
                println!("sandwich public backend listening on https://{public}");
                let public_server = axum_server::bind_rustls(public, tls)
                    .serve(api::router(state).into_make_service_with_connect_info::<SocketAddr>());
                tokio::select! {
                    result = local => result?,
                    result = public_server => result?,
                    _ = shutdown() => {},
                }
            } else {
                local.with_graceful_shutdown(shutdown()).await?;
            }
        }
    }
    Ok(())
}

async fn shutdown() {
    let ctrl_c = async { tokio::signal::ctrl_c().await.expect("ctrl-c") };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("signal")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {_=ctrl_c=>{},_=terminate=>{}}
}
