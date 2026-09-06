#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for Naivolt.
#
# Prepares the base image so the Rust core, the Expo mobile app and the Next.js
# admin panel are all buildable. Per-boot service startup lives in start.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> [1/5] System packages (PostgreSQL)"
# The Rust core stores its ledger in PostgreSQL. Redis is mentioned in docs but
# is not used by any crate, so it is intentionally not installed.
if ! command -v psql >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql postgresql-client
fi

echo "==> [2/5] Rust toolchain (stable)"
# The committed Cargo.lock pulls transitive crates that require the edition2024
# feature (Cargo >= 1.85); the image's default 1.83 cannot parse them.
rustup toolchain install stable --profile minimal
rustup default stable
rustc --version

echo "==> [3/5] Node dependencies"
# jest-expo pins a react peer that conflicts with the app's react version, so the
# mobile app install needs --legacy-peer-deps. The admin panel installs cleanly.
npm ci --legacy-peer-deps
( cd admin && npm ci )

# The marketing site (naivolt-website) is a sibling repo pulled in via
# repositoryDependencies. It uses pnpm and consumes the Rust API at VITE_API_URL.
WEBSITE_DIR="$(cd "$REPO_ROOT/.." && pwd)/naivolt-website"
if [ -d "$WEBSITE_DIR" ]; then
  echo "==> [3b/5] Website dependencies (pnpm)"
  ( cd "$WEBSITE_DIR" && pnpm install --frozen-lockfile )
else
  echo "==> [3b/5] naivolt-website not present; skipping website deps"
fi

echo "==> [4/5] sqlx-cli (runs DB migrations outside the API process)"
if ! command -v sqlx >/dev/null 2>&1; then
  cargo install sqlx-cli --version '^0.8' --no-default-features --features rustls,postgres
fi

echo "==> [5/5] Warm the Rust build cache"
# No database is needed to compile: the API embeds migrations at build time and
# uses runtime (not compile-time-checked) queries.
( cd backend-rs && cargo build --workspace )

echo "==> install.sh complete"
