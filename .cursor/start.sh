#!/usr/bin/env bash
# Per-boot service reconciliation for Naivolt. Idempotent: safe to run on every
# start. Brings PostgreSQL up, ensures the dev database, schema and test accounts
# exist, then returns so the terminals (API + apps) can start.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATABASE_URL="postgres://localhost/naivolt_dev"

echo "==> Starting PostgreSQL"
sudo pg_ctlcluster 16 main start 2>/dev/null || true
for _ in $(seq 1 30); do
  pg_isready -h localhost -q && break
  sleep 1
done

echo "==> Ensuring local trust auth + login role"
HBA="$(sudo -u postgres psql -tAc 'SHOW hba_file')"
if ! sudo grep -qE '^\s*local\s+all\s+all\s+trust' "$HBA"; then
  sudo sed -i -E 's/^(local\s+all\s+all\s+)peer/\1trust/' "$HBA"
  sudo sed -i -E 's#^(host\s+all\s+all\s+127\.0\.0\.1/32\s+)scram-sha-256#\1trust#' "$HBA"
  sudo sed -i -E 's#^(host\s+all\s+all\s+::1/128\s+)scram-sha-256#\1trust#' "$HBA"
  sudo pg_ctlcluster 16 main reload || true
fi
# A login role matching the OS user lets the documented postgres://localhost/...
# connection string (no user) authenticate.
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$(whoami)'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE \"$(whoami)\" LOGIN SUPERUSER"

echo "==> Ensuring dev database, schema and seed data"
createdb naivolt_dev 2>/dev/null || true
( cd "$REPO_ROOT/backend-rs" && DATABASE_URL="$DATABASE_URL" sqlx migrate run --source migrations )
# Seeds two loginable test accounts through the real code paths. Idempotent: it
# reuses existing accounts instead of duplicating them.
( cd "$REPO_ROOT/backend-rs" && DATABASE_URL="$DATABASE_URL" cargo run -q -p naivolt-devtools --bin seed ) || true

echo "==> start.sh complete"
