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

echo "== dashboard =="
DASH_PORT="${DASH_PORT:-$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')}"
DASH_LOG="$SCRATCH/dashboard.log"

GUILDSIGHT_DATA_DIR="$SCRATCH" node "$ROOT/bin/guildsight.js" dashboard --port "$DASH_PORT" >"$DASH_LOG" 2>&1 &
DASH_PID=$!
# shellcheck disable=SC2064
trap "kill $DASH_PID 2>/dev/null || true" EXIT

wait_for_dash() {
  local i=0
  while [ "$i" -lt 100 ]; do
    if ! kill -0 "$DASH_PID" 2>/dev/null; then
      echo "smoke FAIL: dashboard exited early" >&2
      cat "$DASH_LOG" >&2 || true
      return 1
    fi
    if curl -sf "http://127.0.0.1:$DASH_PORT/api/health" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 0.1
  done
  return 1
}

if ! wait_for_dash; then
  echo "smoke FAIL: dashboard /api/health did not respond within 10s" >&2
  cat "$DASH_LOG" >&2 || true
  exit 1
fi

# Loopback-only: the listener socket must be bound to 127.0.0.1 (ground truth via ss;
# a TCP connect test is unreliable here because the sandbox egress proxy intercepts
# outbound connections).
BOUND="$(ss -ltn "sport = :$DASH_PORT" 2>/dev/null | awk 'NR>1 {print $4}' | head -1)"
if [ -z "$BOUND" ]; then echo "smoke FAIL: no listener found on port $DASH_PORT" >&2; exit 1; fi
echo "$BOUND" | grep -q "^127\.0\.0\.1:" \
  || { echo "smoke FAIL: dashboard bound to $BOUND (expected 127.0.0.1)" >&2; exit 1; }
echo "loopback-only: verified ($BOUND)"

HEALTH="$(curl -sf "http://127.0.0.1:$DASH_PORT/api/health")"
echo "health: $HEALTH"
echo "$HEALTH" | grep -q '"ok":true' || { echo "smoke FAIL: /api/health body" >&2; exit 1; }

MEMBERS="$(curl -sf "http://127.0.0.1:$DASH_PORT/api/members")"
echo "$MEMBERS" | node -e '
let raw = ""; process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  const d = JSON.parse(raw);
  if (!Array.isArray(d.members) || d.members.length === 0) { console.error("smoke FAIL: /api/members empty"); process.exit(1); }
  if (!d.members.some((m) => m.user_id === "u_alice")) { console.error("smoke FAIL: /api/members missing u_alice"); process.exit(1); }
});' || exit 1
echo "members: non-empty, contains u_alice"

CHANNELS="$(curl -sf "http://127.0.0.1:$DASH_PORT/api/channels")"
echo "$CHANNELS" | node -e '
let raw = ""; process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  const d = JSON.parse(raw);
  if (!Array.isArray(d.channels) || d.channels.length === 0) { console.error("smoke FAIL: /api/channels empty"); process.exit(1); }
  if (!d.channels.some((c) => c.kind === "help")) { console.error("smoke FAIL: /api/channels missing help channel"); process.exit(1); }
});' || exit 1
echo "channels: non-empty, contains help channel"

curl -sf "http://127.0.0.1:$DASH_PORT/archive?q=password" | grep -q "guildsight" \
  || { echo "smoke FAIL: /archive HTML" >&2; exit 1; }
echo "archive: HTML served"

kill "$DASH_PID" 2>/dev/null || true
wait "$DASH_PID" 2>/dev/null || true

echo "smoke OK"
