#!/usr/bin/env bash
# Deploy a commit of the licence server (thejustinjames/LicenseServer) to the lab.
#
# Runs on the lab server (docker-dev-01) as labadmin. Jenkins calls it over SSH
# (deploy/jenkins/Jenkinsfile.lab-deploy, through deploy-gate.py); it works the
# same by hand:
#
#   printf '%s\n' "$PAT" | /opt/docker-projects/licenseserver-ci/deploy-licenseserver-lab.sh --ref main
#   ... --ref <commit>        # a branch, a tag or a commit (default main)
#   ... --dry-run             # say what would happen, change nothing
#   ... --force               # build even if this commit is already deployed
#   ... --skip-check          # no typecheck and tests (only when they just passed elsewhere)
#
# The GitHub token (a PAT with Contents read-only on the repository) comes on
# stdin, one line, when stdin is a pipe: a 0600 file for the fetch, removed on
# exit, never on a command line or in a log. Without one the fetch works if the
# checkout can fetch on its own.
#
# The stack is the compose project license-server-silo, run from
# /opt/docker-projects/licenseserver with docker-compose.silo.yml: the container
# license-server on the silo-lab network, behind silo-nginx as
# https://licenseserver.lab.silo.red. The database is license_server_db from the
# other compose file there, and is never restarted here.
#
# What it does, in order:
#   1. fetch the ref into the checkout (/opt/docker-projects/src/LicenseServer)
#   2. stop if the stamp names this commit and the server answers
#   3. npm ci, prisma generate, tsc, vitest in a node:20 container (exit 4 if
#      it fails)
#   4. copy the files git tracks into the deploy directory. Nothing is deleted
#      there; .env, keys/ and backups/ are never touched (git does not track them)
#   5. tag the running image :previous, then build the new one (exit 8 if it fails)
#   6. dump the database into backups/ (exit 9 if the dump fails): the container
#      runs prisma db push as it starts, so a schema change applies on restart
#   7. compose up -d --no-build app
#   8. wait for /health to answer ok; if not, put :previous back and exit 7
#      (the schema is not rolled back; the dump from step 6 is there for that)
#   9. write the stamp (.lab-deployed-commit), keep the newest backups, trim the
#      build cache
#
# Exit codes: 2 usage, 3 another deploy holds the lock, 4 the check failed,
# 7 not healthy after the restart (rolled back), 8 the build failed,
# 9 the database dump failed (nothing restarted).
set -euo pipefail

SRC=${LICENSESERVER_LAB_SRC:-/opt/docker-projects/src/LicenseServer}
DEST=${LICENSESERVER_LAB_DEST:-/opt/docker-projects/licenseserver}
REMOTE=${LICENSESERVER_LAB_REMOTE:-https://github.com/thejustinjames/LicenseServer.git}
LOCK=${LICENSESERVER_LAB_LOCK:-/tmp/licenseserver-lab-deploy.lock}
NODE_IMAGE=${LICENSESERVER_LAB_NODE_IMAGE:-node:20-bookworm}
CHECK_TIMEOUT=${LICENSESERVER_LAB_CHECK_TIMEOUT:-1200}
HEALTH_TIMEOUT=${LICENSESERVER_LAB_HEALTH_TIMEOUT:-180}
KEEP_BACKUPS=${LICENSESERVER_LAB_KEEP_BACKUPS:-30}
CACHE_BUDGET=${LICENSESERVER_LAB_CACHE_BUDGET:-20GB}
CONTAINER=license-server
DB_CONTAINER=license_server_db
IMAGE=license-server-silo-app:latest
STAMP=$DEST/.lab-deployed-commit
BACKUPS=$DEST/backups

REF=main
DRY_RUN=0
FORCE=0
SKIP_CHECK=0

usage() { sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    --skip-check) SKIP_CHECK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '[licenseserver %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
run() { if [ "$DRY_RUN" = 1 ]; then say "would run: $*"; else "$@"; fi; }

# --- the token ----------------------------------------------------------------
TOKEN_FILE=
cleanup() { [ -n "$TOKEN_FILE" ] && rm -f "$TOKEN_FILE"; return 0; }
trap cleanup EXIT
if [ ! -t 0 ]; then
  IFS= read -r token || true
  if [ -n "${token:-}" ]; then
    TOKEN_FILE=$(mktemp "${TMPDIR:-/tmp}/licenseserver-lab-token.XXXXXX")
    chmod 600 "$TOKEN_FILE"
    printf 'https://x-access-token:%s@github.com\n' "$token" > "$TOKEN_FILE"
  fi
  unset token
fi
gitc() {
  if [ -n "$TOKEN_FILE" ]; then git -c credential.helper="store --file=$TOKEN_FILE" "$@"; else git "$@"; fi
}

exec 9>"$LOCK"
if ! flock -n 9; then
  say "another deploy is running; not starting a second"
  exit 3
fi

# --- 1. fetch -----------------------------------------------------------------
if [ ! -d "$SRC/.git" ]; then
  say "cloning $REMOTE into $SRC"
  mkdir -p "$(dirname "$SRC")"
  gitc clone -q --no-checkout "$REMOTE" "$SRC" || { say "the clone failed"; exit 1; }
fi
git -C "$SRC" remote set-url origin "$REMOTE"
gitc -C "$SRC" fetch -q --prune --tags origin || { say "the fetch failed"; exit 1; }
if git -C "$SRC" rev-parse --verify -q "refs/remotes/origin/$REF^{commit}" >/dev/null; then
  target=origin/$REF
else
  target=$REF
fi
git -C "$SRC" checkout -q --force --detach "$target" || { say "no such ref: $REF"; exit 1; }
COMMIT=$(git -C "$SRC" rev-parse HEAD)
SHORT=$(git -C "$SRC" rev-parse --short HEAD)
say "commit $SHORT ($(git -C "$SRC" log -1 --format=%s HEAD | cut -c1-120))"

compose() { (cd "$DEST" && docker compose -f docker-compose.silo.yml "$@"); }
health() { docker exec "$CONTAINER" curl -sf --max-time 5 http://localhost:3000/health 2>/dev/null || true; }

# --- 2. already deployed? -----------------------------------------------------
deployed=$(cat "$STAMP" 2>/dev/null || true)
if [ "$FORCE" = 0 ] && [ "$deployed" = "$COMMIT" ]; then
  case "$(health)" in
    *'"status":"ok"'*) say "$SHORT is already deployed and the server answers; nothing to do (use --force to build anyway)"; exit 0 ;;
  esac
  say "the files for $SHORT are in place but the server does not answer; building"
fi

# --- 3. check -----------------------------------------------------------------
# The image's own Node major. prisma generate before tsc: the client's types come from it.
# The tests are unit tests and need no database, but src/config validates the environment
# when it is imported, so the variables it requires get throwaway values (nothing connects).
IN_SRC=(docker run --rm --init -u "$(id -u):$(id -g)" -v "$SRC:/src" -w /src -e HOME=/tmp
        -e NODE_ENV=test -e DATABASE_URL=postgresql://check:check@127.0.0.1:1/check
        -e JWT_SECRET=lab-check-only-not-a-secret-0123456789abcdef
        -e STRIPE_SECRET_KEY=sk_test_lab_check -e STRIPE_WEBHOOK_SECRET=whsec_lab_check
        -e STRIPE_SUCCESS_URL=http://127.0.0.1/success -e STRIPE_CANCEL_URL=http://127.0.0.1/cancel
        "$NODE_IMAGE")
if [ "$SKIP_CHECK" = 1 ]; then
  say "skipping the typecheck and tests (--skip-check)"
else
  say "npm ci, prisma generate, tsc and vitest in $NODE_IMAGE (up to $((CHECK_TIMEOUT / 60)) minutes)"
  rc=0
  run timeout "$CHECK_TIMEOUT" "${IN_SRC[@]}" bash -lc 'npm ci --no-audit --no-fund && npx prisma generate && npx tsc --noEmit && npx vitest run' || rc=$?
  if [ "$rc" != 0 ]; then
    [ "$rc" = 124 ] && say "the check timed out after ${CHECK_TIMEOUT}s" || say "the check failed (exit $rc)"
    say "not deploying $SHORT"
    exit 4
  fi
fi

# --- 4. copy ------------------------------------------------------------------
# The files git tracks, so nothing ignored (.env, keys/, node_modules, dist) is
# carried and nothing host-only is overwritten. No deletions.
[ -f "$DEST/.env" ] || { say "no $DEST/.env; this is not the lab's deploy directory"; exit 1; }
rsync_flags=(-a --checksum --itemize-changes --from0 --files-from=-)
[ "$DRY_RUN" = 1 ] && rsync_flags+=(--dry-run)
say "copying the tracked files into $DEST (no deletions; .env, keys/ and backups/ untouched)"
if ! sync_out=$(git -C "$SRC" ls-files -z | rsync "${rsync_flags[@]}" "$SRC/" "$DEST/"); then
  say "the copy into $DEST failed; nothing has been built or restarted"
  exit 1
fi
say "$(printf '%s\n' "$sync_out" | grep -c '^>f' || true) file(s) updated"

# --- 5. keep what is running, then build -------------------------------------
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  run docker tag "$IMAGE" "${IMAGE%:*}:previous"
  say "kept the running image as ${IMAGE%:*}:previous"
fi
say "building the licence server"
if ! run compose build app; then
  say "the build failed (compose exit above); the running container is unchanged"
  exit 8
fi

# --- 6. back up the database ----------------------------------------------------
# The container runs prisma db push as it starts. A change it would lose data
# for is refused (no --accept-data-loss), the container fails its health check
# and :previous comes back; anything else applies on the restart, so dump first.
dump=$BACKUPS/license_server-$(date -u +%Y%m%d-%H%M%S)-$SHORT.sql.gz
if [ "$DRY_RUN" = 1 ]; then
  say "would dump the database to $dump"
else
  mkdir -p "$BACKUPS"
  if docker exec "$DB_CONTAINER" pg_dump -U postgres license_server | gzip > "$dump.part" \
     && [ "$(gzip -dc "$dump.part" | head -c 4096 | wc -c)" -gt 0 ]; then
    mv "$dump.part" "$dump"
    say "dumped the database to $dump ($(du -h "$dump" | cut -f1))"
  else
    rm -f "$dump.part"
    say "the database dump failed; not restarting (the new image is built, the old one runs)"
    exit 9
  fi
fi

# --- 7. restart -----------------------------------------------------------------
# Only the app: the database belongs to the other compose project and storage-init
# is a one-shot that has done its work.
say "restarting the licence server on the new image"
if ! run compose up -d --no-build app; then
  say "the restart failed (compose exit above)"
  exit 8
fi

# --- 8. health ----------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  say "would wait up to ${HEALTH_TIMEOUT}s for /health to answer ok"
else
  healthy=0 h=
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while :; do
    h=$(health)
    case "$h" in *'"status":"ok"'*) healthy=1; break ;; esac
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep 5
  done
  if [ "$healthy" = 0 ]; then
    say "not healthy after ${HEALTH_TIMEOUT}s; putting ${IMAGE%:*}:previous back"
    docker logs --tail 40 "$CONTAINER" 2>&1 | sed 's/^/    /' || true
    docker image inspect "${IMAGE%:*}:previous" >/dev/null 2>&1 && docker tag "${IMAGE%:*}:previous" "$IMAGE"
    if compose up -d --no-build app; then say "rolled back to the former image. The schema is as the new one left it; the dump is $dump"
    else say "the rollback could not start ${IMAGE%:*}:previous either; the licence server is down. Logs: docker logs --tail 200 $CONTAINER"; fi
    exit 7
  fi
  say "the licence server answers: $h"
fi

# --- 9. stamp and tidy --------------------------------------------------------
if [ "$DRY_RUN" = 0 ]; then
  printf '%s\n' "$COMMIT" > "$STAMP"
  # Newest first; the hand-made dumps from before this script share the prefix and age out too.
  ls -1t "$BACKUPS"/license_server-*.sql.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while IFS= read -r old; do rm -f "$old"; done || true
fi
run docker builder prune -f --keep-storage "$CACHE_BUDGET" >/dev/null
say "deployed $SHORT"
