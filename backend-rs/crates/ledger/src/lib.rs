//! Double-entry ledger — the source of truth for what Naivolt owes each user.
//!
//! See `docs/ARCHITECTURE.md` §2. The rule this crate exists to enforce: a
//! journal's entries sum to zero per asset, and nothing ever mutates an entry
//! after it is written. Corrections are reversing journals.

#![forbid(unsafe_code)]

pub mod account;
pub mod journal;

pub use account::{AccountKind, LedgerAccount};
pub use journal::{Entry, Journal, JournalKind, LedgerError};
