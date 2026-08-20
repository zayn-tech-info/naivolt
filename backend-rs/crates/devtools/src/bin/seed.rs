//! Seed test accounts you can actually log in as.
//!
//! Creates users through the *real* code paths — identity resolution, OTP
//! hashing, PIN hashing, HD derivation, double-entry journals — so a successful
//! run is evidence the auth and ledger stack works end to end, not just that the
//! rows exist.
//!
//! ```sh
//! createdb naivolt_dev
//! for f in migrations/0*.sql; do psql -d naivolt_dev -f "$f"; done
//! DATABASE_URL=postgres://localhost/naivolt_dev cargo run -p naivolt-devtools --bin seed
//! ```

use anyhow::{bail, Context, Result};
use chrono::Utc;
use naivolt_auth::identifier::{parse_identifier, Identifier};
use naivolt_auth::identity::{ExistingMatches, IdentityClaim, Provider, Resolution};
use naivolt_auth::{hash_pin, otp::OtpChallenge, tier::KycTier};
use naivolt_core::{Asset, Chain};
use naivolt_ledger::account::AccountKind;
use naivolt_ledger::journal::{JournalBuilder, JournalKind};
use naivolt_wallet::{derive_address, MasterSeed};
use rust_decimal::Decimal;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

/// The standard BIP-39 test mnemonic. Its keys are public knowledge — which is
/// exactly why it must never be used anywhere real.
const DEV_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon \
                            abandon abandon abandon abandon about";

/// Fixed OTP so you can log in without wiring up SMS.
const DEV_OTP: &str = "000000";
/// Fixed PIN. Passes the strength rules, unlike 000000 or 123456.
const DEV_PIN: &str = "428193";

#[tokio::main]
async fn main() -> Result<()> {
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://localhost/naivolt_dev".to_string());

    refuse_to_run_against_production(&database_url)?;

    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .with_context(|| format!("could not connect to {database_url}"))?;

    let seed = MasterSeed::from_mnemonic(DEV_MNEMONIC, "")?;

    println!("\n\x1b[1mSeeding test accounts\x1b[0m  →  {database_url}\n");

    // A brand-new user: no KYC, holds crypto, cannot withdraw yet.
    let tier0 = seed_user(
        &pool,
        &seed,
        UserSpec {
            label: "Tier 0 — fresh signup, phone",
            provider: Provider::Phone,
            phone: Some("08000000001"),
            email: None,
            tier: KycTier::Tier0,
            usdt: Some(Decimal::from(250)),
            ngn: None,
        },
    )
    .await?;

    // A verified user with naira ready to withdraw, signing in by email.
    let tier1 = seed_user(
        &pool,
        &seed,
        UserSpec {
            label: "Tier 1 — email signup, BVN verified",
            provider: Provider::Email,
            phone: None,
            email: Some("ada@example.com"),
            tier: KycTier::Tier1,
            usdt: Some(Decimal::from(100)),
            ngn: Some(Decimal::from(45_000)),
        },
    )
    .await?;

    print_login_card(&tier0);
    print_login_card(&tier1);

    println!("\x1b[1mSign in with\x1b[0m");
    println!("  OTP  {DEV_OTP}   (fixed in dev — no SMS needed)");
    println!("  PIN  {DEV_PIN}   (authorises withdrawals)\n");

    verify_balances(&pool, &tier0, &tier1).await?;

    Ok(())
}

/// Hard stop against seeding known-compromised keys into anything real.
///
/// The dev mnemonic's private keys are published in the BIPs. Deriving deposit
/// addresses from it on a production database would mean handing users addresses
/// that anybody on the internet can already sweep.
fn refuse_to_run_against_production(url: &str) -> Result<()> {
    let lowered = url.to_lowercase();

    let looks_local = lowered.contains("localhost")
        || lowered.contains("127.0.0.1")
        || lowered.contains("@db:")   // docker-compose service name
        || lowered.contains("/naivolt_dev")
        || lowered.contains("/naivolt_test");

    let looks_dangerous = ["prod", "live", "rds.amazonaws", "supabase", "neon.tech", "railway"]
        .iter()
        .any(|needle| lowered.contains(needle));

    if looks_dangerous || !looks_local {
        bail!(
            "refusing to seed {url}\n\n\
             This seeder derives wallets from the public BIP-39 test mnemonic — anyone \
             can spend from those addresses. It only runs against an obviously local \
             database (localhost / 127.0.0.1 / naivolt_dev / naivolt_test)."
        );
    }
    Ok(())
}

struct UserSpec {
    label: &'static str,
    provider: Provider,
    phone: Option<&'static str>,
    email: Option<&'static str>,
    tier: KycTier,
    usdt: Option<Decimal>,
    ngn: Option<Decimal>,
}

struct SeededUser {
    label: &'static str,
    id: Uuid,
    address_index: i64,
    phone: Option<String>,
    email: Option<String>,
    tier: KycTier,
    wallets: Vec<(Chain, String)>,
}

async fn seed_user(pool: &PgPool, seed: &MasterSeed, spec: UserSpec) -> Result<SeededUser> {
    let mut tx = pool.begin().await?;

    // Normalise exactly as the API would, so the seeded identity is byte-identical
    // to what a real sign-in produces. A mismatch here would mean the seeded user
    // could never actually log in.
    // Parse through the same path the API uses, so the seeded identity is
    // byte-identical to what a real sign-in produces. A mismatch here would mean
    // the seeded user could never actually log in.
    let raw = match spec.provider {
        Provider::Phone => spec.phone.context("phone provider needs a phone")?,
        Provider::Email => spec.email.context("email provider needs an email")?,
        // Deliberately unsupported. Every identity here is built through the OTP
        // path, which proves ownership of a channel. A Google identity is proved
        // by a token from Google, and its subject is Google's `sub` — inventing
        // one would seed an account that no real sign-in could ever match.
        Provider::Google => {
            anyhow::bail!("seed cannot mint a Google identity; sign in through the API instead")
        }
    };
    let identifier = parse_identifier(raw)?;
    let claim = IdentityClaim::from_verified_otp(&identifier);

    let phone = match &identifier {
        Identifier::Phone(p) => Some(p.clone()),
        Identifier::Email(_) => None,
    };
    let email = match &identifier {
        Identifier::Email(e) => Some(e.clone()),
        Identifier::Phone(_) => None,
    };

    // Run the real resolver against what's already in the database.
    let existing = lookup_matches(&mut tx, &claim).await?;
    let user_id = match naivolt_auth::identity::resolve(&claim, &existing) {
        Resolution::Existing(id) | Resolution::LinkTo(id) => {
            println!("  \x1b[33m↻\x1b[0m {} already seeded, reusing", spec.label);
            tx.commit().await?;
            return load_user(pool, id, spec).await;
        }
        Resolution::Conflict { .. } => bail!("seed data conflicts with existing identities"),
        Resolution::CreateNew => {
            let pin_hash = hash_pin(DEV_PIN)?;
            sqlx::query_scalar::<_, Uuid>(
                "INSERT INTO users (phone, email, pin_hash) VALUES ($1, $2, $3) RETURNING id",
            )
            .bind(&phone)
            .bind(&email)
            .bind(&pin_hash)
            .fetch_one(&mut *tx)
            .await?
        }
    };

    let address_index: i64 =
        sqlx::query_scalar("SELECT address_index FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;

    sqlx::query(
        "INSERT INTO identities (user_id, provider, subject, email, phone, verified_at)
         VALUES ($1, $2, $3, $4, $5, now())",
    )
    .bind(user_id)
    .bind(claim.provider.as_str())
    .bind(&claim.subject)
    .bind(&claim.verified_email)
    .bind(&claim.verified_phone)
    .execute(&mut *tx)
    .await?;

    // Derive a permanent address per chain — the same call the API makes at signup.
    let index = u32::try_from(address_index).context("address index out of range")?;
    let mut wallets = Vec::new();
    for chain in Chain::ALL {
        let derived = derive_address(seed, chain, index)?;
        sqlx::query(
            "INSERT INTO wallets (user_id, chain, address, derivation_path)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(user_id)
        .bind(chain.as_str())
        .bind(&derived.address)
        .bind(&derived.derivation_path)
        .execute(&mut *tx)
        .await?;
        wallets.push((chain, derived.address));
    }

    if spec.tier != KycTier::Tier0 {
        grant_tier(&mut tx, user_id, spec.tier).await?;
    }

    if let Some(amount) = spec.usdt {
        credit_deposit(&mut tx, user_id, Asset::Usdt, amount).await?;
    }
    if let Some(amount) = spec.ngn {
        credit_ngn(&mut tx, user_id, amount).await?;
    }

    // A live OTP challenge so the sign-in screen works immediately, on whichever
    // channel this account uses.
    {
        let challenge = OtpChallenge::new(&identifier, DEV_OTP, Utc::now())?;
        sqlx::query(
            "INSERT INTO otp_challenges (destination, channel, code_hash, expires_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (destination) WHERE consumed_at IS NULL DO NOTHING",
        )
        .bind(&challenge.destination)
        .bind(match challenge.channel {
            naivolt_auth::Channel::Sms => "sms",
            naivolt_auth::Channel::Email => "email",
        })
        .bind(&challenge.code_hash)
        // Long expiry: a dev challenge that times out mid-session is just annoying.
        .bind(Utc::now() + chrono::Duration::days(365))
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    println!("  \x1b[32m✓\x1b[0m {}", spec.label);

    Ok(SeededUser {
        label: spec.label,
        id: user_id,
        address_index,
        phone,
        email,
        tier: spec.tier,
        wallets,
    })
}

async fn lookup_matches(
    tx: &mut Transaction<'_, Postgres>,
    claim: &IdentityClaim,
) -> Result<ExistingMatches> {
    let by_subject = sqlx::query_scalar::<_, Uuid>(
        "SELECT user_id FROM identities WHERE provider = $1 AND subject = $2",
    )
    .bind(claim.provider.as_str())
    .bind(&claim.subject)
    .fetch_optional(&mut **tx)
    .await?;

    // Only verified rows are eligible — the same restriction resolve() relies on.
    let by_verified_email = match &claim.verified_email {
        Some(email) => {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT user_id FROM identities
                  WHERE email = $1 AND verified_at IS NOT NULL LIMIT 1",
            )
            .bind(email)
            .fetch_optional(&mut **tx)
            .await?
        }
        None => None,
    };

    let by_verified_phone = match &claim.verified_phone {
        Some(phone) => {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT user_id FROM identities
                  WHERE phone = $1 AND verified_at IS NOT NULL LIMIT 1",
            )
            .bind(phone)
            .fetch_optional(&mut **tx)
            .await?
        }
        None => None,
    };

    Ok(ExistingMatches {
        by_subject,
        by_verified_email,
        by_verified_phone,
    })
}

async fn load_user(pool: &PgPool, id: Uuid, spec: UserSpec) -> Result<SeededUser> {
    let (address_index, phone, email): (i64, Option<String>, Option<String>) =
        sqlx::query_as("SELECT address_index, phone, email FROM users WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await?;

    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT chain, address FROM wallets WHERE user_id = $1 ORDER BY chain")
            .bind(id)
            .fetch_all(pool)
            .await?;

    let wallets = rows
        .into_iter()
        .filter_map(|(c, a)| c.parse::<Chain>().ok().map(|c| (c, a)))
        .collect();

    Ok(SeededUser {
        label: spec.label,
        id,
        address_index,
        phone,
        email,
        tier: spec.tier,
        wallets,
    })
}

/// The schema refuses to raise a tier without an approved verification, so seed
/// one rather than working around the guard.
async fn grant_tier(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    tier: KycTier,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO kyc_verifications
            (user_id, target_tier, provider, status, bvn_last4, full_name, reviewed_at)
         VALUES ($1, $2, 'dev-seed', 'approved', '4321', 'Ada Lovelace', now())",
    )
    .bind(user_id)
    .bind(tier.as_i16())
    .execute(&mut **tx)
    .await?;

    sqlx::query("UPDATE users SET kyc_tier = $1 WHERE id = $2")
        .bind(tier.as_i16())
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn account_id(
    tx: &mut Transaction<'_, Postgres>,
    kind: AccountKind,
    user_id: Option<Uuid>,
    asset: Asset,
) -> Result<Uuid> {
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM ledger_accounts
          WHERE kind = $1 AND asset = $2 AND user_id IS NOT DISTINCT FROM $3",
    )
    .bind(kind.as_str())
    .bind(asset.as_str())
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
    .bind(asset.as_str())
    .fetch_one(&mut **tx)
    .await?;
    Ok(id)
}

/// Credit a deposit the same way the watcher will: custody debit, user credit.
async fn credit_deposit(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    asset: Asset,
    amount: Decimal,
) -> Result<()> {
    let custody = account_id(tx, AccountKind::CustodyDepositAddrs, None, asset).await?;
    let user = account_id(tx, AccountKind::UserCrypto, Some(user_id), asset).await?;

    JournalBuilder::new(
        JournalKind::DepositCredit,
        format!("dev-seed-deposit-{user_id}"),
        format!("dev-seed:{user_id}:{asset}"),
    )
    .entry(custody, AccountKind::CustodyDepositAddrs, asset, amount)
    .entry(user, AccountKind::UserCrypto, asset, -amount)
    .metadata(serde_json::json!({ "source": "dev-seed" }))
    .build()?
    .post(tx)
    .await?;
    Ok(())
}

async fn credit_ngn(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    amount: Decimal,
) -> Result<()> {
    let float = account_id(tx, AccountKind::NgnFloat, None, Asset::Ngn).await?;
    let user = account_id(tx, AccountKind::UserNgn, Some(user_id), Asset::Ngn).await?;

    JournalBuilder::new(
        JournalKind::Sell,
        format!("dev-seed-ngn-{user_id}"),
        format!("dev-seed-ngn:{user_id}"),
    )
    .entry(float, AccountKind::NgnFloat, Asset::Ngn, amount)
    .entry(user, AccountKind::UserNgn, Asset::Ngn, -amount)
    .metadata(serde_json::json!({ "source": "dev-seed" }))
    .build()?
    .post(tx)
    .await?;
    Ok(())
}

fn print_login_card(user: &SeededUser) {
    println!("\n\x1b[1m{}\x1b[0m", user.label);
    println!("  user id        {}", user.id);
    println!("  address index  {}", user.address_index);
    if let Some(p) = &user.phone {
        println!("  phone          {p}");
    }
    if let Some(e) = &user.email {
        println!("  email          {e}");
    }
    println!(
        "  tier           {:?}  ({})",
        user.tier,
        match user.tier.daily_payout_cap() {
            Some(cap) => format!("withdraw up to ₦{cap}/day"),
            None => "cannot withdraw — KYC required".to_string(),
        }
    );
    println!("  deposit addresses");
    for (chain, address) in &user.wallets {
        println!("    {:<8} {address}", chain.as_str());
    }
}

/// Read balances back through the ledger view, so the printed numbers come from
/// the same place the API will read them — not from what we just inserted.
async fn verify_balances(pool: &PgPool, a: &SeededUser, b: &SeededUser) -> Result<()> {
    println!("\x1b[1mBalances (read back from the ledger)\x1b[0m");
    for user in [a, b] {
        let rows: Vec<(String, String, Decimal)> = sqlx::query_as(
            "SELECT kind, asset, balance FROM ledger_balances
              WHERE user_id = $1 ORDER BY asset",
        )
        .bind(user.id)
        .fetch_all(pool)
        .await?;

        print!("  {:<40}", user.label);
        let mut parts = Vec::new();
        for (kind, asset, raw) in rows {
            let kind = match kind.as_str() {
                "user_crypto" => AccountKind::UserCrypto,
                "user_ngn" => AccountKind::UserNgn,
                _ => continue,
            };
            // Liabilities are stored negative; flip for display.
            let shown = kind.user_facing_balance(raw);
            parts.push(format!("{} {}", shown.normalize(), asset));
        }
        println!("{}", parts.join("  ·  "));
    }
    println!();
    Ok(())
}
