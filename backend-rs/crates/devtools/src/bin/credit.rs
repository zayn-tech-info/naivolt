//! Put naira in an account nobody paid for, so a flow can be tested end to end.
//!
//! ```sh
//! DATABASE_URL=... APP_ENV=staging \
//!   cargo run -p naivolt-devtools --bin credit -- someone@example.com 2000
//! ```
//!
//! ## What this breaks, on purpose
//!
//! `ARCHITECTURE.md` §2 says `sum(custody) >= sum(user liabilities)`: every naira
//! a user can spend is a naira sitting in the float behind it. This credits the
//! float without any money arriving, so it opens a hole exactly the size of the
//! credit. That is a fine thing to do on staging to walk a purchase, and a
//! catastrophic thing to do on a system holding real customer money.
//!
//! So it refuses to run unless `APP_ENV` says staging or development, and it
//! posts as `Adjustment` -- the kind reserved for manual corrections -- rather
//! than `NgnDeposit`. Booking it as a deposit would put it in front of the
//! funding reconciler as a card charge that never happened, and leave nothing in
//! the ledger to say a human typed it.
//!
//! Every credit carries `{"source": "manual-test-credit"}`, which is how you
//! find them again:
//!
//! ```sql
//! SELECT reference, created_at, metadata FROM ledger_journals
//!  WHERE kind = 'adjustment' AND metadata->>'source' = 'manual-test-credit';
//! ```
//!
//! Reverse one by posting its mirror; never by deleting rows.

use anyhow::{bail, Context, Result};
use naivolt_core::Asset;
use naivolt_ledger::account::AccountKind;
use naivolt_ledger::journal::{JournalBuilder, JournalKind};
use rust_decimal::Decimal;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Postgres, Transaction};
use std::str::FromStr;
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let (email, amount) = match (args.next(), args.next()) {
        (Some(email), Some(amount)) => (email, amount),
        _ => bail!("usage: credit <email> <amount-ngn>"),
    };

    // Staging only, and it says so rather than assuming. An unset APP_ENV is
    // read as production: the safe reading of silence on a tool that moves money.
    let env = std::env::var("APP_ENV").unwrap_or_else(|_| "production".into());
    if !matches!(env.to_lowercase().as_str(), "staging" | "development" | "dev") {
        bail!("refusing to credit an unpaid balance with APP_ENV={env}");
    }

    let amount = Decimal::from_str(amount.trim()).context("amount must be a number")?;
    if amount <= Decimal::ZERO {
        bail!("amount must be positive - reverse a credit by posting its mirror");
    }

    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is not set")?;
    let pool = PgPoolOptions::new().max_connections(2).connect(&database_url).await?;

    // Resolved from `identities`, never from `users.email` -- that one is
    // self-asserted through `PATCH /me` and proves nothing about who holds it.
    let email = email.trim().to_lowercase();
    let user_id: Uuid = sqlx::query_scalar(
        "SELECT user_id FROM identities
          WHERE lower(email) = $1 AND provider = 'google' AND verified_at IS NOT NULL",
    )
    .bind(&email)
    .fetch_optional(&pool)
    .await?
    .with_context(|| format!("no verified Google identity for {email} - sign in once first"))?;

    let mut tx = pool.begin().await?;

    let float = account_id(&mut tx, AccountKind::NgnFloat, None).await?;
    let user = account_id(&mut tx, AccountKind::UserNgn, Some(user_id)).await?;

    let reference =
        format!("TESTCR-{}", &Uuid::new_v4().simple().to_string()[..10].to_uppercase());

    JournalBuilder::new(JournalKind::Adjustment, reference.clone(), reference.clone())
        .entry(float, AccountKind::NgnFloat, Asset::Ngn, amount)
        .entry(user, AccountKind::UserNgn, Asset::Ngn, -amount)
        .metadata(serde_json::json!({
            "source": "manual-test-credit",
            "email": email,
            "note": "no money was received for this credit",
        }))
        .build()?
        .post(&mut tx)
        .await?;

    tx.commit().await?;

    // Read back through the ledger rather than trusting what we just wrote.
    let raw: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE account_id = $1",
    )
    .bind(user)
    .fetch_one(&pool)
    .await?;

    println!("credited NGN {amount} to {email}");
    println!("  user id    {user_id}");
    println!("  reference  {reference}");
    println!("  balance    NGN {}", AccountKind::UserNgn.user_facing_balance(raw));
    println!();
    println!("the float is now NGN {amount} short of the money behind it");

    Ok(())
}

async fn account_id(
    tx: &mut Transaction<'_, Postgres>,
    kind: AccountKind,
    user_id: Option<Uuid>,
) -> Result<Uuid> {
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM ledger_accounts
          WHERE kind = $1 AND asset = $2 AND user_id IS NOT DISTINCT FROM $3",
    )
    .bind(kind.as_str())
    .bind(Asset::Ngn.as_str())
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?
    {
        return Ok(id);
    }

    let id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO ledger_accounts (kind, user_id, asset) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(kind.as_str())
    .bind(user_id)
    .bind(Asset::Ngn.as_str())
    .fetch_one(&mut **tx)
    .await?;
    Ok(id)
}
