//! Per-chain address derivation.
//!
//! secp256k1 chains (Bitcoin, EVM, TRON) use standard BIP-32. Solana uses
//! SLIP-0010 over ed25519, which supports hardened derivation only and is
//! implemented here directly since the BIP-32 machinery does not apply.

use crate::{seed::MasterSeed, DerivedAddress};
use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::secp256k1::{PublicKey, Secp256k1, SecretKey};
use bitcoin::{CompressedPublicKey, Network};
use hmac::{Hmac, Mac};
use naivolt_core::{Chain, Curve};
use sha2::Sha512;
use sha3::{Digest, Keccak256};
use zeroize::Zeroize;

type HmacSha512 = Hmac<Sha512>;

/// Derive the deposit address for `chain` at `index`.
///
/// `index` is the user's `address_index`. The same (seed, chain, index) always
/// produces the same address, on any machine, forever.
pub fn derive_address(
    seed: &MasterSeed,
    chain: Chain,
    index: u32,
) -> Result<DerivedAddress, DeriveError> {
    if index >= 0x8000_0000 {
        return Err(DeriveError::IndexTooLarge(index));
    }

    let derivation_path = chain.derivation_path(index);

    let address = match chain.curve() {
        Curve::Secp256k1 => {
            let mut key = derive_secp256k1(seed, &derivation_path)?;
            let addr = match chain {
                Chain::Bitcoin => bitcoin_address(&key)?,
                Chain::Evm => evm_address(&key),
                Chain::Tron => tron_address(&key),
                Chain::Solana => unreachable!("solana is ed25519"),
            };
            // The secret has done its job; do not let it linger.
            key.zeroize_secret();
            addr
        }
        Curve::Ed25519 => {
            let mut key = derive_ed25519(seed, &derivation_path)?;
            let addr = solana_address(&key);
            key.zeroize();
            addr
        }
    };

    Ok(DerivedAddress {
        chain,
        index,
        address,
        derivation_path,
    })
}

// ---------------------------------------------------------------------------
// secp256k1 (BIP-32)
// ---------------------------------------------------------------------------

/// A derived secp256k1 key. Kept small and short-lived.
struct Secp256k1Key {
    secret: SecretKey,
    public: PublicKey,
}

impl Secp256k1Key {
    /// Overwrite the secret. `SecretKey` has no `Zeroize` impl, so we replace it
    /// with a throwaway value rather than leaving the real one in place.
    fn zeroize_secret(&mut self) {
        let mut filler = [1u8; 32];
        if let Ok(dummy) = SecretKey::from_slice(&filler) {
            self.secret = dummy;
        }
        filler.zeroize();
    }
}

fn derive_secp256k1(seed: &MasterSeed, path: &str) -> Result<Secp256k1Key, DeriveError> {
    let secp = Secp256k1::new();
    let path: DerivationPath = path
        .parse()
        .map_err(|e| DeriveError::BadPath(format!("{e}")))?;

    // Network only affects xpriv serialization prefixes, not the derived keys.
    let master = Xpriv::new_master(Network::Bitcoin, seed.as_bytes())
        .map_err(|e| DeriveError::Derivation(e.to_string()))?;
    let child = master
        .derive_priv(&secp, &path)
        .map_err(|e| DeriveError::Derivation(e.to_string()))?;

    let secret = child.private_key;
    let public = PublicKey::from_secret_key(&secp, &secret);
    Ok(Secp256k1Key { secret, public })
}

fn bitcoin_address(key: &Secp256k1Key) -> Result<String, DeriveError> {
    let compressed = CompressedPublicKey(key.public);
    Ok(bitcoin::Address::p2wpkh(&compressed, Network::Bitcoin).to_string())
}

/// Keccak-256 of the uncompressed public key, minus its `0x04` prefix; the
/// address is the last 20 bytes. Shared by Ethereum and TRON.
fn keccak_address_bytes(key: &Secp256k1Key) -> [u8; 20] {
    let uncompressed = key.public.serialize_uncompressed();
    let hash = Keccak256::digest(&uncompressed[1..]);
    let mut out = [0u8; 20];
    out.copy_from_slice(&hash[12..]);
    out
}

fn evm_address(key: &Secp256k1Key) -> String {
    to_eip55(&keccak_address_bytes(key))
}

/// EIP-55 mixed-case checksum. Wallets reject or warn on addresses without it.
fn to_eip55(bytes: &[u8; 20]) -> String {
    let lower = hex::encode(bytes);
    let hash = Keccak256::digest(lower.as_bytes());
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (i, ch) in lower.chars().enumerate() {
        // Each hex char is checksummed by the corresponding nibble of the hash.
        let nibble = if i % 2 == 0 {
            hash[i / 2] >> 4
        } else {
            hash[i / 2] & 0x0f
        };
        if ch.is_ascii_alphabetic() && nibble >= 8 {
            out.push(ch.to_ascii_uppercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// TRON reuses Ethereum's 20-byte account hash, prefixed with `0x41` and
/// rendered as base58check — which is why TRON addresses all start with `T`.
fn tron_address(key: &Secp256k1Key) -> String {
    let mut payload = Vec::with_capacity(21);
    payload.push(0x41);
    payload.extend_from_slice(&keccak_address_bytes(key));
    bs58::encode(payload).with_check().into_string()
}

// ---------------------------------------------------------------------------
// ed25519 (SLIP-0010)
// ---------------------------------------------------------------------------

/// SLIP-0010 ed25519 derivation.
///
/// Unlike BIP-32, every step must be hardened: ed25519 has no public-key
/// derivation, so a non-hardened index is undefined rather than merely unsafe.
fn derive_ed25519(seed: &MasterSeed, path: &str) -> Result<[u8; 32], DeriveError> {
    let mut mac = HmacSha512::new_from_slice(b"ed25519 seed")
        .map_err(|e| DeriveError::Derivation(e.to_string()))?;
    mac.update(seed.as_bytes());
    let result = mac.finalize().into_bytes();

    let mut key = [0u8; 32];
    let mut chain_code = [0u8; 32];
    key.copy_from_slice(&result[..32]);
    chain_code.copy_from_slice(&result[32..]);

    for index in parse_hardened_path(path)? {
        let mut mac = HmacSha512::new_from_slice(&chain_code)
            .map_err(|e| DeriveError::Derivation(e.to_string()))?;
        mac.update(&[0u8]); // ed25519 child data is 0x00 || key, not the pubkey
        mac.update(&key);
        mac.update(&index.to_be_bytes());
        let result = mac.finalize().into_bytes();
        key.copy_from_slice(&result[..32]);
        chain_code.copy_from_slice(&result[32..]);
    }

    chain_code.zeroize();
    Ok(key)
}

/// Parse `m/44'/501'/0'/0'` into hardened child indices.
fn parse_hardened_path(path: &str) -> Result<Vec<u32>, DeriveError> {
    let mut indices = Vec::new();
    for segment in path.trim_start_matches("m/").split('/') {
        if segment.is_empty() || segment == "m" {
            continue;
        }
        let hardened = segment.ends_with('\'') || segment.ends_with('h');
        if !hardened {
            return Err(DeriveError::BadPath(format!(
                "ed25519 requires hardened derivation, got '{segment}' in '{path}'"
            )));
        }
        let raw: u32 = segment
            .trim_end_matches(['\'', 'h'])
            .parse()
            .map_err(|_| DeriveError::BadPath(format!("bad index '{segment}'")))?;
        if raw >= 0x8000_0000 {
            return Err(DeriveError::IndexTooLarge(raw));
        }
        indices.push(raw | 0x8000_0000);
    }
    Ok(indices)
}

fn solana_address(key: &[u8; 32]) -> String {
    let signing = ed25519_dalek::SigningKey::from_bytes(key);
    bs58::encode(signing.verifying_key().to_bytes()).into_string()
}

#[derive(Debug, thiserror::Error)]
pub enum DeriveError {
    #[error("address index {0} is out of range (must be < 2^31)")]
    IndexTooLarge(u32),
    #[error("invalid derivation path: {0}")]
    BadPath(String),
    #[error("derivation failed: {0}")]
    Derivation(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seed::MasterSeed;

    /// The standard BIP-39 test mnemonic. Addresses derived from it are published
    /// in the BIPs and reproduced by every major wallet, so these assertions
    /// cross-check us against the rest of the ecosystem.
    const VECTOR: &str = "abandon abandon abandon abandon abandon abandon abandon \
                          abandon abandon abandon abandon about";

    fn seed() -> MasterSeed {
        MasterSeed::from_mnemonic(VECTOR, "").unwrap()
    }

    #[test]
    fn bitcoin_matches_bip84_vector() {
        // Published in BIP-84 itself.
        let a = derive_address(&seed(), Chain::Bitcoin, 0).unwrap();
        assert_eq!(a.address, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
        let b = derive_address(&seed(), Chain::Bitcoin, 1).unwrap();
        assert_eq!(b.address, "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
    }

    #[test]
    fn evm_matches_metamask_vector() {
        let a = derive_address(&seed(), Chain::Evm, 0).unwrap();
        assert_eq!(a.address, "0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
    }

    #[test]
    fn evm_address_is_eip55_checksummed() {
        let a = derive_address(&seed(), Chain::Evm, 3).unwrap();
        assert!(a.address.starts_with("0x"));
        assert_eq!(a.address.len(), 42);
        // A checksummed address has mixed case; an all-lower one would mean the
        // checksum was never applied.
        let body = &a.address[2..];
        assert!(body.chars().any(|c| c.is_ascii_uppercase()));
    }

    #[test]
    fn tron_address_is_base58check_with_0x41_prefix() {
        let a = derive_address(&seed(), Chain::Tron, 0).unwrap();
        assert!(a.address.starts_with('T'), "got {}", a.address);
        let decoded = bs58::decode(&a.address).with_check(None).into_vec().unwrap();
        assert_eq!(decoded.len(), 21);
        assert_eq!(decoded[0], 0x41);
    }

    #[test]
    fn tron_and_evm_share_the_hashing_but_not_the_path() {
        // Both are keccak(pubkey)[12..], so a path collision would make them
        // equal — this guards against accidentally reusing coin type 60 for TRON.
        let tron = derive_address(&seed(), Chain::Tron, 0).unwrap();
        let evm = derive_address(&seed(), Chain::Evm, 0).unwrap();
        let tron_bytes = bs58::decode(&tron.address).with_check(None).into_vec().unwrap();
        let evm_bytes = hex::decode(&evm.address[2..]).unwrap();
        assert_ne!(&tron_bytes[1..], &evm_bytes[..]);
    }

    #[test]
    fn solana_address_is_32_bytes_base58() {
        let a = derive_address(&seed(), Chain::Solana, 0).unwrap();
        let decoded = bs58::decode(&a.address).into_vec().unwrap();
        assert_eq!(decoded.len(), 32);
        assert!((43..=44).contains(&a.address.len()));
    }

    #[test]
    fn ed25519_rejects_non_hardened_path() {
        // m/44'/501'/0'/0 (last segment soft) is undefined for ed25519.
        let err = parse_hardened_path("m/44'/501'/0'/0").unwrap_err();
        assert!(matches!(err, DeriveError::BadPath(_)));
    }

    #[test]
    fn derivation_is_deterministic_across_calls() {
        for chain in Chain::ALL {
            let a = derive_address(&seed(), chain, 99).unwrap();
            let b = derive_address(&seed(), chain, 99).unwrap();
            assert_eq!(a, b, "{chain} derivation is not deterministic");
        }
    }

    #[test]
    fn every_index_yields_a_distinct_address() {
        for chain in Chain::ALL {
            let mut seen = std::collections::HashSet::new();
            for i in 0..50 {
                let a = derive_address(&seed(), chain, i).unwrap();
                assert!(seen.insert(a.address.clone()), "{chain} collided at {i}");
            }
        }
    }

    #[test]
    fn a_different_passphrase_gives_entirely_different_wallets() {
        let other = MasterSeed::from_mnemonic(VECTOR, "second-factor").unwrap();
        for chain in Chain::ALL {
            let a = derive_address(&seed(), chain, 0).unwrap();
            let b = derive_address(&other, chain, 0).unwrap();
            assert_ne!(a.address, b.address, "{chain} ignored the passphrase");
        }
    }

    #[test]
    fn rejects_index_in_hardened_range() {
        let err = derive_address(&seed(), Chain::Evm, 0x8000_0000).unwrap_err();
        assert!(matches!(err, DeriveError::IndexTooLarge(_)));
    }

    /// Golden vectors.
    ///
    /// These are frozen deliberately. A change to derivation that alters any of
    /// these addresses means every existing user's deposit address moves while
    /// the funds already sent to the old ones become unsignable. If this test
    /// fails, the derivation change is wrong — not the test.
    ///
    /// Bitcoin and EVM are asserted against published external vectors above;
    /// these lock in TRON and Solana too.
    #[test]
    fn golden_vectors_are_frozen() {
        let cases = [
            (Chain::Bitcoin, 0, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"),
            (Chain::Evm, 0, "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"),
            (Chain::Evm, 1, "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0"),
            (Chain::Tron, 0, "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH"),
            (Chain::Tron, 1, "TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK"),
            (Chain::Solana, 0, "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"),
            (Chain::Solana, 1, "Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb"),
        ];
        for (chain, index, expected) in cases {
            let got = derive_address(&seed(), chain, index).unwrap();
            assert_eq!(got.address, expected, "{chain} index {index} drifted");
        }
    }

    /// Prints the first few addresses per chain so they can be pasted into
    /// TronLink / Phantom / MetaMask for an independent cross-check.
    #[test]
    fn print_reference_addresses() {
        for chain in Chain::ALL {
            for i in 0..3 {
                let a = derive_address(&seed(), chain, i).unwrap();
                println!("{:8} {:24} {}", chain.as_str(), a.derivation_path, a.address);
            }
        }
    }
}
