//! Operator TOTP secrets and session tokens.

use crate::error::{ApiError, ApiResult};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use sha2::{Digest, Sha256};
use totp_rs::{Algorithm, Secret, TOTP};

const ISSUER: &str = "Naivolt";

fn aes_key(key: &[u8]) -> ApiResult<&[u8]> {
    if key.len() < 32 {
        return Err(ApiError::Internal(anyhow::anyhow!(
            "OPERATOR_TOTP_KEY must be at least 32 bytes"
        )));
    }
    Ok(&key[..32])
}

pub fn encrypt_totp_secret(key: &[u8], plaintext: &[u8]) -> ApiResult<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(aes_key(key)?)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("OPERATOR_TOTP_KEY must be 32 bytes")))?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|err| ApiError::Internal(anyhow::anyhow!(err)))?;
    let mut packed = nonce_bytes.to_vec();
    packed.extend_from_slice(&ciphertext);
    Ok(packed)
}

pub fn decrypt_totp_secret(key: &[u8], packed: &[u8]) -> ApiResult<Vec<u8>> {
    if packed.len() < 13 {
        return Err(ApiError::Internal(anyhow::anyhow!("totp secret blob is too short")));
    }
    let cipher = Aes256Gcm::new_from_slice(aes_key(key)?)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("OPERATOR_TOTP_KEY must be 32 bytes")))?;
    cipher
        .decrypt(Nonce::from_slice(&packed[..12]), &packed[12..])
        .map_err(|err| ApiError::Internal(anyhow::anyhow!(err)))
}

pub fn new_totp(email: &str) -> ApiResult<(Vec<u8>, String)> {
    let secret = Secret::generate_secret();
    let bytes = secret
        .to_bytes()
        .map_err(|err| ApiError::Internal(anyhow::anyhow!(err)))?;
    let totp = TOTP::new(Algorithm::SHA1, 6, 1, 30, bytes.clone(), Some(ISSUER.into()), email.to_string())
        .map_err(|err| ApiError::Internal(anyhow::anyhow!(err)))?;
    Ok((bytes, totp.get_url()))
}

pub fn totp_code(secret: &[u8], email: &str) -> ApiResult<String> {
    let totp = TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        secret.to_vec(),
        Some(ISSUER.into()),
        email.to_string(),
    )
    .map_err(|err| ApiError::Internal(anyhow::anyhow!(err)))?;
    totp.generate_current()
        .map_err(|err| ApiError::Internal(anyhow::anyhow!(err)))
}

pub fn totp_ok(secret: &[u8], email: &str, code: &str) -> bool {
    let Ok(totp) = TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        secret.to_vec(),
        Some(ISSUER.into()),
        email.to_string(),
    ) else {
        return false;
    };
    totp.check_current(code).unwrap_or(false)
}

pub fn hash_session_token(raw: &[u8]) -> Vec<u8> {
    Sha256::digest(raw).to_vec()
}

pub fn new_session_token() -> (String, Vec<u8>) {
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let encoded = hex::encode(raw);
    (encoded.clone(), hash_session_token(encoded.as_bytes()))
}

pub fn audit_hash(
    prev: Option<&str>,
    actor_type: &str,
    actor_id: &str,
    action: &str,
    target: &str,
    before: &str,
    after: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prev.unwrap_or("").as_bytes());
    hasher.update(actor_type.as_bytes());
    hasher.update(actor_id.as_bytes());
    hasher.update(action.as_bytes());
    hasher.update(target.as_bytes());
    hasher.update(before.as_bytes());
    hasher.update(after.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn mask_phone(phone: Option<&str>) -> Option<String> {
    let phone = phone.filter(|value| !value.is_empty())?;
    let digits: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() <= 4 {
        return Some("*".repeat(digits.len()));
    }
    let keep = &digits[digits.len() - 4..];
    Some(format!("{}{keep}", "*".repeat(digits.len() - 4)))
}
