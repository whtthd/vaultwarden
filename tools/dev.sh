#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

usage() {
    cat <<'EOF'
Usage: bash tools/dev.sh <command> [extra cargo arguments]

  init     Create .env, data/dev, and a local HTTPS certificate
  check    Check the SQLite backend
  build    Build with full debug symbols
  test     Run existing SQLite backend tests
  run      Start the server and web vault
  api      Start the server with the web vault disabled
  web      Prepare vault improvements and the local Never timeout option
  fmt      Check Rust formatting without changing files
  clippy   Check SQLite backend lints

The run and api commands load .env through Vaultwarden itself.
EOF
}

create_dev_certificate() {
    local cert="data/dev/tls/localhost.pem"
    local key="data/dev/tls/localhost-key.pem"
    local ca="data/dev/tls/local-ca.pem"
    local ca_key="data/dev/tls/local-ca-key.pem"
    if [[ -f "$cert" && -f "$key" && -f "$ca" && -f "$ca_key" ]]; then
        return
    fi
    if [[ -e "$cert" || -e "$key" || -e "$ca" || -e "$ca_key" ]]; then
        printf '%s\n' 'The local HTTPS certificate set is incomplete. Restore it first.' >&2
        exit 1
    fi
    if ! command -v openssl >/dev/null 2>&1; then
        printf '%s\n' 'OpenSSL is required to create the local HTTPS certificate.' >&2
        exit 1
    fi
    mkdir -p data/dev/tls
    chmod 700 data/dev/tls
    (
        umask 077
        openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -noenc \
            -days 3650 -sha256 -subj '/CN=Vaultwarden Local Development CA' \
            -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
            -addext 'keyUsage=critical,keyCertSign,cRLSign' \
            -addext 'nameConstraints=critical,permitted;DNS:localhost,permitted;IP:127.0.0.1/255.255.255.255,permitted;IP:::1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff' \
            -keyout "$ca_key" -out "$ca"
        openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -noenc \
            -subj '/CN=127.0.0.1' -out data/dev/tls/localhost.csr \
            -keyout "$key"
        openssl x509 -req -in data/dev/tls/localhost.csr -CA "$ca" -CAkey "$ca_key" \
            -CAcreateserial -days 365 -sha256 \
            -extfile tools/dev-tls.cnf -extensions server -out "$cert"
        openssl verify -CAfile "$ca" -purpose sslserver -verify_ip 127.0.0.1 "$cert"
    )
    printf '%s\n' 'Created the local HTTPS certificate. Trust local-ca.pem before opening the web vault.'
}

command="${1:-help}"
if [[ $# -gt 0 ]]; then
    shift
fi

case "$command" in
    init)
        mkdir -p data/dev
        create_dev_certificate
        if [[ -e .env ]]; then
            printf '%s\n' 'Keeping the existing .env.'
        else
            (umask 077; cp tools/dev.env.example .env)
            printf '%s\n' 'Created .env for local development.'
        fi
        exit 0
        ;;
    help|-h|--help)
        usage
        exit 0
        ;;
    web)
        exec python3 tools/prepare_dev_web_vault.py "$@"
        ;;
    check|build|test|run|api|fmt|clippy)
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac

export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
if ! command -v cargo >/dev/null 2>&1; then
    printf '%s\n' 'Cargo is missing. Install the toolchain in rust-toolchain.toml first.' >&2
    exit 1
fi

# The repository default only includes line tables; local variables need full symbols.
export CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-2}"
export RUST_BACKTRACE="${RUST_BACKTRACE:-1}"

if [[ "$(uname -s)" == Darwin && -z "${OPENSSL_DIR:-}" ]]; then
    for openssl_dir in /opt/homebrew/opt/openssl@3 /usr/local/opt/openssl@3; do
        if [[ -d "$openssl_dir" ]]; then
            export OPENSSL_DIR="$openssl_dir"
            break
        fi
    done
fi

case "$command" in
    run|api)
        if [[ ! -f "${ENV_FILE:-.env}" ]]; then
            printf '%s\n' 'No environment file found. Run: bash tools/dev.sh init' >&2
            exit 1
        fi
        if [[ "$command" == api ]]; then
            export WEB_VAULT_ENABLED=false
        else
            python3 tools/prepare_dev_web_vault.py
        fi
        exec cargo run --locked --features sqlite "$@"
        ;;
    fmt)
        exec cargo fmt --all -- --check "$@"
        ;;
    *)
        exec cargo "$command" --locked --features sqlite "$@"
        ;;
esac
