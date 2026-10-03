#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/guildsight-smoke.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

export GUILDSIGHT_DATA_DIR="$SCRATCH"

echo "== ingest =="
node "$ROOT/bin/guildsight.js" ingest --fixture "$ROOT/fixtures/demo.jsonl"

echo "== report =="
node "$ROOT/bin/guildsight.js" report --guild demo

echo "== search =="
node "$ROOT/bin/guildsight.js" search "help me"

echo "smoke OK"
