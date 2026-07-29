//! Master seed handling.
//!
//! The seed is the single secret behind every user wallet. It is held in memory
//! only, wrapped so it cannot be printed, cloned casually, or left in freed
//! memory.

use bip39::Mnemonic;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// A BIP-39 master seed.
///
/// `Debug` is implemented to redact, there is no `Display`, no `Clone`, no
/// `Serialize`, and the bytes are zeroed on drop. The only way to get at the
/// material is [`MasterSeed::as_bytes`], which callers should keep as short-lived
/// as possible.
#[derive(ZeroizeOnDrop)]
pub struct MasterSeed {
    bytes: [u8; 64],
}

impl MasterSeed {
    /// Derive the seed from a BIP-39 mnemonic and optional passphrase.
    ///
    /// The passphrase is the "25th word": with it, possession of the mnemonic
    /// alone is not enough to reconstruct the wallets.
    pub fn from_mnemonic(phrase: &str, passphrase: &str) -> Result<Self, SeedError> {
        let mnemonic = Mnemonic::parse_normalized(phrase.trim())
            .map_err(|e| SeedError::InvalidMnemonic(e.to_string()))?;
        Ok(Self {
            bytes: mnemonic.to_seed(passphrase),
        })
    }

    /// Build directly from 64 seed bytes, e.g. after KMS decryption.
    pub fn from_bytes(bytes: [u8; 64]) -> Self {
        Self { bytes }
    }

    pub fn as_bytes(&self) -> &[u8; 64] {
        &self.bytes
    }
}

impl std::fmt::Debug for MasterSeed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never let the seed reach a log line or a panic message.
        f.write_str("MasterSeed(<redacted>)")
    }
}

/// Generate a fresh 24-word mnemonic. For one-time platform setup only — the
/// output must be written to offline backup and never persisted by the process.
pub fn generate_mnemonic() -> Result<String, SeedError> {
    let mut entropy = [0u8; 32];
    // OS CSPRNG directly — no userspace PRNG state to seed badly or fork-share.
    getrandom::getrandom(&mut entropy).map_err(|e| SeedError::Entropy(e.to_string()))?;
    let mnemonic = Mnemonic::from_entropy(&entropy)
        .map_err(|e| SeedError::InvalidMnemonic(e.to_string()))?;
    entropy.zeroize();
    Ok(mnemonic.to_string())
}

#[derive(Debug, thiserror::Error)]
pub enum SeedError {
    #[error("invalid mnemonic: {0}")]
    InvalidMnemonic(String),
    #[error("could not gather entropy: {0}")]
    Entropy(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The canonical BIP-39 test vector: this exact seed is what every other
    /// wallet implementation produces for these words, so address tests built on
    /// it are cross-checkable against MetaMask, Phantom, TronLink, etc.
    const TREZOR_VECTOR: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon about";

    #[test]
    fn matches_bip39_reference_seed() {
        // Empty passphrase — the value every wallet uses by default.
        let plain = MasterSeed::from_mnemonic(TREZOR_VECTOR, "").unwrap();
        assert_eq!(
            hex::encode(plain.as_bytes()),
            "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1\
             9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4"
        );

        // The BIP-39 spec's own vector for this mnemonic uses the passphrase
        // "TREZOR"; asserting both proves the passphrase is actually fed into
        // PBKDF2 rather than silently ignored.
        let with_passphrase = MasterSeed::from_mnemonic(TREZOR_VECTOR, "TREZOR").unwrap();
        assert_eq!(
            hex::encode(with_passphrase.as_bytes()),
            "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e5349553\
             1f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04"
        );
    }

    #[test]
    fn passphrase_changes_the_seed() {
        let a = MasterSeed::from_mnemonic(TREZOR_VECTOR, "").unwrap();
        let b = MasterSeed::from_mnemonic(TREZOR_VECTOR, "correct horse").unwrap();
        assert_ne!(a.as_bytes(), b.as_bytes());
    }

    #[test]
    fn debug_does_not_leak() {
        let seed = MasterSeed::from_mnemonic(TREZOR_VECTOR, "").unwrap();
        let rendered = format!("{seed:?}");
        assert_eq!(rendered, "MasterSeed(<redacted>)");
        assert!(!rendered.contains("c55257"));
    }

    #[test]
    fn rejects_bad_checksum() {
        let bad = "abandon abandon abandon abandon abandon abandon abandon \
                   abandon abandon abandon abandon abandon";
        assert!(MasterSeed::from_mnemonic(bad, "").is_err());
    }

    #[test]
    fn generated_mnemonics_are_24_words_and_unique() {
        let a = generate_mnemonic().unwrap();
        let b = generate_mnemonic().unwrap();
        assert_eq!(a.split_whitespace().count(), 24);
        assert_ne!(a, b);
        assert!(MasterSeed::from_mnemonic(&a, "").is_ok());
    }
}
