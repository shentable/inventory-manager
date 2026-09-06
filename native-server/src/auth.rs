use base64::{Engine, engine::general_purpose::URL_SAFE};
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

const PIN_ITERATIONS: u32 = 200_000;
const TOKEN_TTL: u64 = 30 * 24 * 3600;

pub fn hash_pin(pin: &str) -> String {
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let mut out = [0u8; 32];
    pbkdf2_hmac::<Sha256>(pin.as_bytes(), &salt, PIN_ITERATIONS, &mut out);
    format!(
        "pbkdf2_sha256${}${}${}",
        PIN_ITERATIONS,
        hex(&salt),
        hex(&out)
    )
}

pub fn verify_pin(pin: &str, stored: &str) -> bool {
    let parts: Vec<_> = stored.split('$').collect();
    if parts.len() != 4 || parts[0] != "pbkdf2_sha256" {
        return false;
    }
    let Ok(iterations) = parts[1].parse::<u32>() else {
        return false;
    };
    let (Some(salt), Some(expected)) = (unhex(parts[2]), unhex(parts[3])) else {
        return false;
    };
    let mut out = vec![0u8; expected.len()];
    pbkdf2_hmac::<Sha256>(pin.as_bytes(), &salt, iterations, &mut out);
    constant_time_eq(&out, &expected)
}

#[derive(Serialize, Deserialize)]
struct Claims {
    uid: i64,
    ver: i64,
    exp: u64,
}

pub fn create_token(secret: &[u8], uid: i64, ver: i64) -> String {
    let exp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + TOKEN_TTL;
    let raw = URL_SAFE.encode(serde_json::to_vec(&Claims { uid, ver, exp }).expect("claims"));
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("hmac key");
    mac.update(raw.as_bytes());
    format!("{raw}.{}", URL_SAFE.encode(mac.finalize().into_bytes()))
}

pub fn decode_token(secret: &[u8], token: &str) -> Option<(i64, i64)> {
    let (raw, sig) = token.split_once('.')?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).ok()?;
    mac.update(raw.as_bytes());
    mac.verify_slice(&URL_SAFE.decode(sig).ok()?).ok()?;
    let claims: Claims = serde_json::from_slice(&URL_SAFE.decode(raw).ok()?).ok()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    (claims.exp >= now).then_some((claims.uid, claims.ver))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn python_compatible_pin_and_token_roundtrip() {
        let hash = hash_pin("1234");
        assert!(verify_pin("1234", &hash));
        assert!(!verify_pin("0000", &hash));
        let token = create_token(b"0123456789abcdef", 7, 2);
        assert_eq!(decode_token(b"0123456789abcdef", &token), Some((7, 2)));
    }
}
