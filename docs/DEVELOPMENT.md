# Local development

The local baseline uses the Rust toolchain pinned in `rust-toolchain.toml`,
the bundled SQLite backend, and the web-vault release pinned in
`docker/DockerSettings.yaml`. For end-user workflows and permission cautions,
see [the feature guide](FEATURE_GUIDE.md).

## Prerequisites

- Install Rust through rustup, including `rustfmt`, `clippy`, and `rust-src`.
  Running Cargo in this repository selects the pinned toolchain.
- Install a C compiler and OpenSSL development libraries.
  On macOS, the development helper detects Homebrew OpenSSL in
  `/opt/homebrew/opt/openssl@3` or `/usr/local/opt/openssl@3`.
  Set `OPENSSL_DIR` explicitly for other locations.
- Put the matching web-vault release under `web-vault/`, with
  `web-vault/index.html` present. The enhancement hooks support `v2026.10.1`;
  verify the release archive against SHA-256:
  `354de9056c871e48db84975985e7d57c111ac6537bd4e4720488019e8638060f`.

Docker is required for the existing multi-service Playwright suite.
See `playwright/README.md` for that setup.

## Start and stop

From the repository root:

```bash
bash tools/dev.sh init
bash tools/dev.sh run
```

Open `https://127.0.0.1:8001`. Stop the foreground server with Ctrl+C.
For backend work without downloaded web assets:

```bash
bash tools/dev.sh api
```

`init` preserves an existing `.env`. Review `tools/dev.env.example` when
updating local settings. The provided configuration binds to the loopback
address and uses these ignored local paths:

| Path | Purpose |
| --- | --- |
| `.env` | Local configuration and optional admin token hash |
| `data/dev/db.sqlite3` | Development database; migrations run on startup |
| `data/dev/vaultwarden.log` | Server logs |
| `data/dev/rsa_key*` | Keys generated on first startup |
| `data/dev/tls/` | Local HTTPS certificate and private key |
| `web-vault/` | Downloaded web client |
| `target/` | Build output |
| `.vscode/` | Local editor configuration |

The server requires the data directory to exist. If you change `DATA_FOLDER`,
create that directory before starting. Settings saved through `/admin` in
`data/dev/config.json` can override `.env`; check both when debugging
configuration.

Use a separate development database for future schema changes. Do not point
this configuration at an existing deployment.

## Isolated experience database

Use a new, empty data directory for permission checks or destructive UI tests.
Do not reuse an imported production snapshot for these tests. If the example
profile paths already exist, choose new names rather than overwriting them:

```bash
bash tools/dev.sh init
mkdir -p data/dev/experience
cp tools/dev.env.example data/dev/experience.env
```

Edit `data/dev/experience.env` before starting the server:

```dotenv
DATA_FOLDER=data/dev/experience
DATABASE_URL=sqlite://data/dev/experience/db.sqlite3
LOG_FILE=data/dev/experience/vaultwarden.log
```

Keep the loopback HTTPS URL, port 8001 and certificate settings from the template.
Stop any other local instance before starting this profile:

```bash
ENV_FILE=data/dev/experience.env bash tools/dev.sh run --offline
```

The application creates and migrates this separate database. Create fake accounts,
an organization, ordinary members, nested collections and dummy logins through
the UI. Use synthetic passwords only; invite, accept and confirm members before
testing their effective access in separate browser profiles. The helper does not
seed accounts or copy data from another database. Keep all fixtures,
credentials, screenshots and walkthrough notes local. `docs/UX_REVIEW.md` is
explicitly ignored, as are the data directory and environment files under it.

## Local HTTPS

The downloaded web client rejects HTTP API URLs during login with
`Insecure URL not allowed. All URLs must use HTTPS.` Use HTTPS for both
the page URL and `DOMAIN`, including local debugging.

`init` creates a local development CA and a server certificate valid for one
year, with SAN entries for `127.0.0.1`, `localhost`, and `::1`. The CA has
name constraints limiting it to those loopback names and addresses and cannot
issue intermediate CAs. The server certificate is only for server
authentication. Both private keys stay under the ignored `data/dev/tls/`
directory with owner-only permissions. `ROCKET_TLS` in `.env` enables HTTPS
directly on port 8001.

On macOS, trust the local CA for SSL connections in the current user's
keychain:

```bash
security add-trusted-cert -r trustRoot -p ssl \
  -k "$HOME/Library/Keychains/login.keychain-db" data/dev/tls/local-ca.pem
```

This step may request macOS authorization. Check the installed certificate
without bypassing verification:

```bash
security verify-cert -c data/dev/tls/localhost.pem -p ssl -n 127.0.0.1 -L
curl --cacert data/dev/tls/local-ca.pem https://127.0.0.1:8001/alive
```

Other operating systems need the equivalent local certificate trust setup.
Existing `.env` files are preserved by `init`; update `DOMAIN` and
`ROCKET_TLS` to match `tools/dev.env.example` before restarting an older setup.

## Keep the local vault unlocked

The 2026.10.1 release web client hides its existing `Never` session timeout
option outside development builds. `bash tools/dev.sh run` prepares a local
copy of that bundle which exposes `Never` only on HTTPS loopback pages
(`127.0.0.1`, `localhost`, or `[::1]`) using port 8001. On these origins it also
uses the upstream development build's session-backed auto-unlock key storage;
the release build otherwise discards that key on refresh. It leaves the rest
of the client's development checks unchanged. The helper verifies the original
bundle's SHA-256 and uses a new asset URL to avoid stale browser caches.

To apply this preparation to an already running server:

```bash
bash tools/dev.sh web
```

Reload the page, unlock if prompted, then open Settings > Security > Session
timeout and choose `Never`. Confirm the client's dialog. This preference is
saved automatically for that account in the current browser; other browsers
and profiles have their own settings. The timeout action can remain `Lock`.
Choosing `Never` uses the client's built-in local auto-unlock behavior. The
key remains in the current tab's session storage across page refreshes;
closing the browser session may require unlocking again. After applying a
client update, unlock once so the client can save its auto-unlock key.

The downloaded original JavaScript stays intact. To restore its index
reference, run `bash tools/dev.sh web --restore` and reload the page.
The next `run` command reapplies local preparation. A new web-vault release
requires reviewing and updating the pinned patch before using this helper.

## Checks

Vault scrolling, search navigation, descendant access selection and subtree
renaming are prepared by the same `web` and `run` commands. See
[WEB_VAULT_ENHANCEMENTS.md](WEB_VAULT_ENHANCEMENTS.md) for behavior, version
constraints, the atomic update API and the additional frontend checks, or
[FEATURE_GUIDE.md](FEATURE_GUIDE.md) for usage instructions.

```bash
bash tools/dev.sh check
bash tools/dev.sh build
bash tools/dev.sh test
bash tools/dev.sh fmt
bash tools/dev.sh clippy
```

The helper selects `--locked --features sqlite` for build and test commands,
and enables full development debug symbols without changing `Cargo.toml`.
Additional Cargo arguments can be appended, for example:

```bash
bash tools/dev.sh test storage::tests
```

With the server running, verify the database connection and public API:

```bash
curl --fail --cacert data/dev/tls/local-ca.pem https://127.0.0.1:8001/alive
curl --fail --cacert data/dev/tls/local-ca.pem https://127.0.0.1:8001/api/alive
curl --fail --cacert data/dev/tls/local-ca.pem https://127.0.0.1:8001/api/config
```

## Breakpoint debugging

For VS Code, install Rust Analyzer and CodeLLDB, then create a local launch
configuration for `target/debug/vaultwarden` with the repository root as its
working directory. Build with `bash tools/dev.sh build` before launching, and
set `ENV_FILE` if using an isolated profile. Editor configuration is ignored and
is not supplied by the repository. Stop any running instance first to free
port 8001.

Useful first breakpoints:

- `src/main.rs`: startup, database initialization, and route registration.
- `src/api/core/mod.rs`: `/api/config` and health endpoints.
- `src/api/identity.rs`: identity and token requests.
- `src/auth.rs`: request authentication and authorization.

For command-line debugging:

```bash
bash tools/dev.sh build
lldb target/debug/vaultwarden
```

Then set a source breakpoint and start the process from LLDB:

```text
breakpoint set --name vaultwarden::check_web_vault
run
```

Alternatively, set a file/line breakpoint at the current location of
`check_web_vault` in `src/main.rs`. Inspect local variables after the breakpoint
is reached. Rust expression support varies by debugger; use CodeLLDB if the
system debugger cannot display the required values.

To enable the admin panel, run `target/debug/vaultwarden hash` and store the
result as a single-quoted `ADMIN_TOKEN` in `.env`, then restart the server.
For an isolated profile, use its environment file instead. Keep any plaintext
credential only in an ignored, owner-readable local file; never commit it.

## Importing a PostgreSQL backup for debugging

Keep exports under the ignored `db_backup/` directory. Initialize a SQLite
database with the current application first to supply the target schema and its
SQLite migration history. Convert a compatible plain SQL export to a **new**
database:

```bash
python3 tools/import_postgres_sqlite.py db_backup/source.sql \
  --schema data/dev/db.sqlite3 \
  --output data/dev/next-import.sqlite3 \
  --report data/dev/next-import.report.json
```

This command reads the existing SQLite database's schema without copying its
business data. It requires new output and report paths and leaves the source
export and live database untouched. The importer supports the literal INSERT
format handled by its parser and rejects unsupported SQL rather than skipping
data; it is not a general PostgreSQL-to-SQLite converter.

The import verifies converted source fields, source foreign keys, SQLite
integrity and foreign keys, then writes a local JSON report. It preserves the
target's SQLite migration records rather than copying PostgreSQL migration
history. Newly added columns use the current schema defaults; organization policy
revision dates are backfilled with the import time where required. Review the
report and compatibility with the export before activation.

Stop Vaultwarden and other SQLite connections before activating an import or
restoring a snapshot. Use SQLite's backup API or checkpoint the database first
so that committed data in the WAL is retained, and keep a recoverable backup of
the database and local configuration. Point a separate local environment file at
the converted database rather than overwriting the original. Keep
`JOB_POLL_INTERVAL_MS=0` for snapshot debugging to pause automatic background
cleanup. This is a debugging setting, not a production recommendation.

SQL exports include attachment metadata, not the encrypted attachment files.
Those files must be copied separately into the configured attachment directory
to test downloads. Database contents remain sensitive even when encrypted;
never commit exports, databases, reports, credentials, certificates, private keys
or runtime logs. Use the empty isolated profile above for routine UI testing.

Importer checks use synthetic records and can be run with:

```bash
python3 -m unittest discover -s tools -p 'test_import_postgres_sqlite.py' -v
```

## Source map

| Area | Entry points |
| --- | --- |
| Startup and routes | `src/main.rs`, `src/api/mod.rs` |
| Runtime configuration | `src/config.rs`, `.env.template` |
| Accounts and vault items | `src/api/core/accounts.rs`, `src/api/core/ciphers.rs` |
| Organizations and collections | `src/api/core/organizations.rs`, `src/db/models/` |
| Authentication, two-factor, SSO | `src/api/identity.rs`, `src/auth.rs`, `src/api/core/two_factor/`, `src/sso.rs` |
| Database models and migrations | `src/db/`, `migrations/sqlite/`, `migrations/mysql/`, `migrations/postgresql/` |
| Admin UI | `src/api/admin.rs`, `src/static/templates/admin/`, `src/static/scripts/admin*` |
| Web client | Separate web-vault build; this repository serves the downloaded assets |
| Browser integration tests | `playwright/` |
