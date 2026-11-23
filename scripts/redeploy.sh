#!/usr/bin/env bash
# Fresh program id for every build: the private rollup caches program binaries by id.
# usage: scripts/redeploy.sh <new-keypair-name>
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="$1"
OLD=$(grep -oE 'declare_id!\("[^"]+"\)' programs/penlight/src/lib.rs | sed -E 's/declare_id!\("([^"]+)"\)/\1/')
[ -f "keys/$NAME.json" ] || solana-keygen new --no-bip39-passphrase -s -o "keys/$NAME.json" >/dev/null
NEW=$(solana-keygen pubkey "keys/$NAME.json")
echo "old $OLD -> new $NEW"
sed -i "s/$OLD/$NEW/g" programs/penlight/src/lib.rs Anchor.toml
cp "keys/$NAME.json" target/deploy/penlight-keypair.json
cargo build-sbf --manifest-path programs/penlight/Cargo.toml 2>&1 | grep -E "^error|stack offset" -A5 || true
anchor idl build -p penlight -o target/idl/penlight.json -t target/types/penlight.ts >/dev/null
cp target/idl/penlight.json packages/sdk/src/idl/penlight.json
cp target/types/penlight.ts packages/sdk/src/idl/penlight.ts
solana program close "$OLD" --bypass-warning -u devnet >/dev/null 2>&1 || true
solana program deploy target/deploy/penlight.so --program-id "keys/$NAME.json" -u devnet --with-compute-unit-price 50000
solana balance -u devnet
