//! Deterministic wallet derivation for Naivolt custody.
//!
//! # Security model
//!
//! This crate is the *only* place private key material is materialised, and it is
//! intended to be linked into the isolated `signer` binary — never into the public
//! API. Nothing here writes to disk, logs, or the network.
//!
//! Every user gets a permanent address per chain, derived from one master seed at
//! the user's `address_index`. Nothing is stored per-user beyond that index: the
//! full set of addresses is reproducible from the seed alone.

#![forbid(unsafe_code)]

pub mod address;
pub mod seed;

pub use address::{derive_address, DeriveError};
pub use seed::MasterSeed;

use naivolt_core::Chain;

/// A derived deposit address, ready to be stored and shown to a user.
///
/// Deliberately contains no key material — see [`crate::seed::MasterSeed`] for
/// signing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedAddress {
    pub chain: Chain,
    pub index: u32,
    pub address: String,
    pub derivation_path: String,
}
