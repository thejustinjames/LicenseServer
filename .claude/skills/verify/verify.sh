#!/usr/bin/env bash
# Verify the licence server end to end: Prisma client, type-check/build,
# unit tests, and optionally sync the schema to the local dev database and
# smoke-test a built server.
#
# Usage: .claude/skills/verify/verify.sh [--db] [--smoke]
#   --db     also run `prisma db push` against DATABASE_URL from .env
#   --smoke  also start dist/index.js on a spare port and hit a few endpoints
set -euo pipefail
cd "$(dirname "$0")/../../.."

DO_DB=0; DO_SMOKE=0
for arg in "$@"; do
  case "$arg" in
    --db) DO_DB=1 ;;
    --smoke) DO_SMOKE=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s ==\n' "$1"; }

if [ ! -d node_modules ]; then
  step "npm ci"
  npm ci
fi

step "prisma generate"
npx prisma generate >/dev/null
echo ok

step "build (tsc)"
npm run build

step "unit tests"
npm test

if [ "$DO_DB" = 1 ]; then
  step "prisma db push (local dev DB)"
  npx prisma db push --skip-generate
fi

if [ "$DO_SMOKE" = 1 ]; then
  step "smoke test"
  PORT_SMOKE="${SMOKE_PORT:-3999}"
  LOG="$(mktemp -t license-server-smoke.XXXXXX)"
  PORT="$PORT_SMOKE" LOG_LEVEL=warn node dist/index.js >"$LOG" 2>&1 &
  PID=$!
  trap 'kill $PID 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do
    sleep 1
    curl -sf "http://localhost:$PORT_SMOKE/health" >/dev/null && break
  done
  fail=0
  check() { # check <label> <expected-status> <curl args...>
    local label="$1" want="$2"; shift 2
    local got; got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
    if [ "$got" = "$want" ]; then echo "ok   $label ($got)"; else echo "FAIL $label (got $got, want $want)"; fail=1; fi
  }
  B="http://localhost:$PORT_SMOKE"
  check "liveness"                     200 "$B/health"
  check "readiness"                    200 "$B/health/ready"
  check "unknown API path is JSON 404" 404 "$B/api/does-not-exist"
  check "deployments need API key"     401 "$B/api/deployments"
  check "validate rejects bad key"     400 -X POST "$B/api/v1/validate" -H 'content-type: application/json' -d '{"licenseKey":"AAAA-BBBB-CCCC-DDDD"}'
  check "malformed JSON is 400"        400 -X POST "$B/api/v1/validate" -H 'content-type: application/json' -d '{bad'
  check "idle-config reachable"        200 "$B/api/auth/idle-config"
  check "admin needs auth"             401 "$B/api/admin/licenses"
  if grep -qi error "$LOG"; then echo "server log contains errors:"; grep -i error "$LOG" | head -20; fail=1; fi
  kill $PID 2>/dev/null || true
  rm -f "$LOG"
  [ "$fail" = 0 ] || { echo "smoke test failed"; exit 1; }
fi

step "done"
