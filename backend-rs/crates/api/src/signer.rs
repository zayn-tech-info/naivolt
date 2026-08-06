//! The API's view of address derivation.
//!
//! Deriving an address needs the master seed, and the seed must never live in a
//! process exposed to the internet — compromising the public HTTP surface would
//! then mean losing every user's funds (ARCHITECTURE.md §4).
//!
//! So the API does not derive. It *asks*, over mTLS, and gets back only the
//! public address. [`crate::config::Config::validate_for_environment`] refuses to
//! start in production unless `SIGNER_URL` is set, so the in-process fallback
//! below cannot be reached there.

use anyhow::{Context, Result};
use naivolt_core::Chain;
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DerivedAddress {
    pub chain: Chain,
    pub address: String,
    pub derivation_path: String,
}

#[allow(async_fn_in_trait)]
pub trait AddressProvider: Send + Sync {
    /// Every chain's address for one user index, in a single call.
    ///
    /// Batched deliberately: signup derives all four, and four round trips to a
    /// mTLS service on the signup path is latency the user feels.
    async fn derive_all(&self, index: u32) -> Result<Vec<DerivedAddress>>;
}

/// Calls the isolated signer. The production path.
pub struct RemoteSigner {
    client: reqwest::Client,
    base_url: String,
}

impl RemoteSigner {
    pub fn new(base_url: String) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("reqwest client"),
            base_url,
        }
    }
}

impl AddressProvider for RemoteSigner {
    async fn derive_all(&self, index: u32) -> Result<Vec<DerivedAddress>> {
        let url = format!("{}/derive/{index}", self.base_url.trim_end_matches('/'));
        let response = self
            .client
            .get(&url)
            .send()
            .await
            .context("signer unreachable")?;

        if !response.status().is_success() {
            anyhow::bail!("signer returned {}", response.status());
        }

        response
            .json::<Vec<DerivedAddress>>()
            .await
            .context("signer returned an unreadable response")
    }
}

/// Derives in-process from a mnemonic. **Development only.**
pub struct LocalSigner {
    seed: naivolt_wallet::MasterSeed,
}

impl LocalSigner {
    pub fn from_mnemonic(phrase: &str) -> Result<Self> {
        Ok(Self {
            seed: naivolt_wallet::MasterSeed::from_mnemonic(phrase, "")?,
        })
    }
}

impl AddressProvider for LocalSigner {
    async fn derive_all(&self, index: u32) -> Result<Vec<DerivedAddress>> {
        Chain::ALL
            .into_iter()
            .map(|chain| {
                let derived = naivolt_wallet::derive_address(&self.seed, chain, index)?;
                Ok(DerivedAddress {
                    chain,
                    address: derived.address,
                    derivation_path: derived.derivation_path,
                })
            })
            .collect()
    }
}

pub enum AnyAddressProvider {
    Remote(RemoteSigner),
    Local(LocalSigner),
}

impl AddressProvider for AnyAddressProvider {
    async fn derive_all(&self, index: u32) -> Result<Vec<DerivedAddress>> {
        match self {
            AnyAddressProvider::Remote(s) => s.derive_all(index).await,
            AnyAddressProvider::Local(s) => s.derive_all(index).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon \
                                 abandon abandon abandon abandon about";

    #[tokio::test]
    async fn local_derivation_covers_every_chain_once() {
        let signer = LocalSigner::from_mnemonic(TEST_MNEMONIC).unwrap();
        let addresses = signer.derive_all(0).await.unwrap();

        assert_eq!(addresses.len(), Chain::ALL.len());
        for chain in Chain::ALL {
            assert_eq!(
                addresses.iter().filter(|a| a.chain == chain).count(),
                1,
                "{chain} appeared other than exactly once"
            );
        }
    }

    #[tokio::test]
    async fn derivation_matches_the_pinned_vectors() {
        // Same golden values as crates/wallet. If the API ever derived something
        // different from the signer, users would be shown addresses nobody can
        // sign for.
        let signer = LocalSigner::from_mnemonic(TEST_MNEMONIC).unwrap();
        let addresses = signer.derive_all(0).await.unwrap();
        let find = |c: Chain| {
            addresses
                .iter()
                .find(|a| a.chain == c)
                .unwrap()
                .address
                .clone()
        };

        assert_eq!(find(Chain::Evm), "0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
        assert_eq!(find(Chain::Tron), "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH");
        assert_eq!(
            find(Chain::Bitcoin),
            "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
        );
    }

    #[tokio::test]
    async fn different_users_get_different_addresses() {
        let signer = LocalSigner::from_mnemonic(TEST_MNEMONIC).unwrap();
        let a = signer.derive_all(1).await.unwrap();
        let b = signer.derive_all(2).await.unwrap();
        for (x, y) in a.iter().zip(b.iter()) {
            assert_eq!(x.chain, y.chain);
            assert_ne!(x.address, y.address, "{} collided across users", x.chain);
        }
    }
}
