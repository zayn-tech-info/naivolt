# Deploying the API

One box, one binary, nginx in front. The files here are the real ones from the
staging host — copied out of it, not written from memory.

```
deploy/naivolt-api.service           systemd unit
deploy/nginx/api.naivolt.com.conf    reverse proxy, TLS added by certbot
```

## What it runs as

**`APP_ENV=staging`, not production** — and not by preference. Production refuses
to boot without `SIGNER_URL`, and there is no signer service in this workspace
yet (`crates/` has `api`, `watcher`, `devtools`). That check exists so the public
HTTP surface can never hold key material (ARCHITECTURE.md §4), and until the
signer is built, the API derives addresses in-process from `DEV_MNEMONIC`.

**So no crypto deposits.** Every address this deployment shows is derived from a
mnemonic sitting on the same box as the web server. Card top-ups and number
orders are safe; anything sent to a deposit address is not.

Production additionally requires `TERMII_API_KEY`, `RESEND_API_KEY` and
`FIVESIM_API_KEY`. Without the first two, OTP codes are logged rather than sent —
Google sign-in still works, phone sign-up does not.

## Steps

```sh
# 1. Source, minus build output and secrets
rsync -az --exclude target/ --exclude '.env*' --exclude .git/ \
      backend-rs/ root@HOST:/opt/naivolt/backend-rs/

# 2. Toolchain (once)
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
apt-get install -y pkg-config libssl-dev build-essential

# 3. Build on the host. -j 1 on a 1-vCPU box shared with other services;
#    ~9 minutes for 266 crates.
cd /opt/naivolt/backend-rs && cargo build --release -p naivolt-api -j 1

# 4. Database
sudo -u postgres createuser naivolt --pwprompt
sudo -u postgres createdb -O naivolt naivolt
# Migrations run at boot — the API owns them.

# 5. Config. Never in git; the unit reads it as an EnvironmentFile.
#    Secrets go up from the developer's machine without being printed:
grep -E '^(PAYSTACK_SECRET_KEY|DEV_MNEMONIC)=' backend-rs/.env.local \
  | ssh root@HOST 'cat >> /opt/naivolt/backend-rs/.env'
chmod 600 /opt/naivolt/backend-rs/.env

# 6. Service + proxy
scp deploy/naivolt-api.service root@HOST:/etc/systemd/system/
scp deploy/nginx/api.naivolt.com.conf root@HOST:/etc/nginx/sites-available/naivolt-api
ssh root@HOST 'ln -sf /etc/nginx/sites-available/naivolt-api /etc/nginx/sites-enabled/ \
  && nginx -t && systemctl reload nginx \
  && systemctl daemon-reload && systemctl enable --now naivolt-api \
  && certbot --nginx -d api.naivolt.com'
```

Then point the web app at it: `VITE_API_URL=https://api.naivolt.com` on Vercel,
and set `WEB_APP_URL` here to wherever the dashboard actually lives — Paystack
returns the payer to a URL under it, so a stale value strands someone who has
already been charged.

## Two firewalls, and only one of them is yours

The thing that cost the most time. `certbot` failed with *"Timeout during connect
(likely firewall problem)"* while nginx was listening perfectly well, because
**there are two layers**:

1. **ufw on the host** — `ufw allow 80/tcp && ufw allow 443/tcp`.
2. **The provider's firewall** (Hostinger hPanel → VPS → Firewall) — invisible
   from inside the machine. `ss` shows the port bound, ufw shows it allowed, and
   packets still never arrive.

Diagnose from outside, not in: if `nc -z HOST 22` succeeds while `nc -z HOST 80`
does not, the host is fine and the provider is dropping it.

**Allow 22, 80 and 443 — all three.** These firewalls are default-deny once any
rule exists, so a rule set naming only the web ports silently removes SSH and
locks you out of your own box. Recovering needs the provider's browser console.

Do **not** allow 5432. ufw on this host allows Postgres from anywhere, and the
provider's firewall is the only thing currently hiding it.

## Checking it

```sh
systemctl status naivolt-api
journalctl -u naivolt-api -f
curl https://api.naivolt.com/health          # -> ok
```

`Error: configuration` on start means `Config::load` rejected the environment —
usually a blank `PAYSTACK_SECRET_KEY` or `DEV_MNEMONIC`. It fails at boot rather
than serving in a broken state, which is the point.
