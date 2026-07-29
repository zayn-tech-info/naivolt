//! Shared domain types for Naivolt.
//!
//! Deliberately dependency-light so every other crate can depend on it.

#![forbid(unsafe_code)]

pub mod asset;
pub mod chain;

pub use asset::{Asset, AssetKind};
pub use chain::{Chain, Curve};
