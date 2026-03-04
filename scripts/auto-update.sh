#!/bin/bash
# =============================================================================
# SPAWN Auto-Update Engine
# =============================================================================
# Polls origin/master for new commits and applies component-aware updates.
# Designed to run via cron every 5 minutes.
#
# Usage:
#   bash scripts/auto-update.sh              # Normal run (cron)
#   bash scripts/auto-update.sh --dry-run    # Show what would happen
#   bash scripts/auto-update.sh --force      # Run even if up-to-date
# =============================================================================
set -euo pipefail

SCWS_ROOT="/var/www/scws"
LOCK_FILE="/tmp/spawn-auto-update.lock"
LOCK_STALE_SEC=600
LOG_PREFIX="[auto-update]"

DRY_RUN=false
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --force)   FORCE=true ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────────────

log()  { printf '%s %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$LOG_PREFIX" "$*"; }
warn() { log "WARN: $*"; }
err()  { log "ERROR: $*" >&2; }

cleanup() {
  rm -f "$LOCK_FILE"
}

# Read dashboard token for API calls
DAEMON_ENV="$SCWS_ROOT/daemon/.env"
DASHBOARD_TOKEN=""
if [[ -f "$DAEMON_ENV" ]]; then
  DASHBOARD_TOKEN=$(grep -E '^DASHBOARD_TOKEN=' "$DAEMON_ENV" | cut -d= -f2- | tr -d '[:space:]' || true)
fi

notify_daemon() {
  local details="$1"
  if [[ -z "$DASHBOARD_TOKEN" ]]; then return; fi
  if $DRY_RUN; then
    log "DRY-RUN: would POST to daemon activity_log: $details"
    return
  fi
  curl -sf -X POST "http://localhost:4000/api/activity" \
    -H "Authorization: Bearer $DASHBOARD_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"auto_update\",\"details\":$(printf '%s' "$details" | jq -Rs .)}" \
    >/dev/null 2>&1 || warn "Failed to notify daemon"
}

notify_cortex() {
  local message="$1"
  if $DRY_RUN; then
    log "DRY-RUN: would POST to spawn-cortex notify: $message"
    return
  fi
  # Only attempt if cortex is running
  if pm2 pid spawn-cortex >/dev/null 2>&1 && [[ "$(pm2 pid spawn-cortex 2>/dev/null)" != "0" ]]; then
    curl -sf -X POST "http://localhost:5002/api/notify" \
      -H "Content-Type: application/json" \
      -d "{\"message\":$(printf '%s' "$message" | jq -Rs .)}" \
      >/dev/null 2>&1 || warn "Failed to notify cortex"
  fi
}

# ── Lock ─────────────────────────────────────────────────────────────────────

if [[ -f "$LOCK_FILE" ]]; then
  lock_age=$(( $(date +%s) - $(stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0) ))
  if (( lock_age > LOCK_STALE_SEC )); then
    warn "Stale lock file (${lock_age}s old), removing"
    rm -f "$LOCK_FILE"
  else
    log "Another update is running (lock age: ${lock_age}s), exiting"
    exit 0
  fi
fi

printf '%s' "$$" > "$LOCK_FILE"
trap cleanup EXIT

# ── Pre-flight ───────────────────────────────────────────────────────────────

cd "$SCWS_ROOT"

if [[ ! -d .git ]]; then
  err "Not a git repository: $SCWS_ROOT"
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [[ "$CURRENT_BRANCH" != "master" ]]; then
  warn "Not on master branch (on '$CURRENT_BRANCH'), skipping"
  exit 0
fi

# Check for dirty working tree
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  warn "Dirty working tree, skipping auto-update"
  exit 0
fi

# ── Fetch ────────────────────────────────────────────────────────────────────

log "Fetching origin/master..."
git fetch origin master --quiet 2>/dev/null

OLD_HEAD=$(git rev-parse HEAD)
NEW_HEAD=$(git rev-parse origin/master)

if [[ "$OLD_HEAD" == "$NEW_HEAD" ]] && ! $FORCE; then
  # Up to date — silent exit (no log spam)
  exit 0
fi

OLD_SHORT=$(git rev-parse --short HEAD)
NEW_SHORT=$(git rev-parse --short origin/master)
COMMIT_COUNT=$(git rev-list HEAD..origin/master --count 2>/dev/null || echo 0)

if [[ "$OLD_HEAD" == "$NEW_HEAD" ]]; then
  log "Force mode — no new commits but running update anyway"
  COMMIT_COUNT=0
else
  log "New commits detected: $OLD_SHORT → $NEW_SHORT ($COMMIT_COUNT commit(s))"
fi

# ── Pull ─────────────────────────────────────────────────────────────────────

if [[ "$OLD_HEAD" != "$NEW_HEAD" ]]; then
  if $DRY_RUN; then
    log "DRY-RUN: would git pull --ff-only"
  else
    if ! git pull --ff-only origin master --quiet 2>/dev/null; then
      err "git pull --ff-only failed — local branch has diverged. Manual intervention required."
      notify_daemon "Auto-update FAILED: git pull --ff-only failed (diverged from origin/master)"
      exit 1
    fi
    log "Pulled successfully"
  fi
fi

# ── Categorize changed files ────────────────────────────────────────────────

DAEMON_RESTART=false
DAEMON_NPM=false
NGINX_RELOAD=false
SCRIPTS_CHANGED=false
VERSION_CHANGED=false
PROJECT_COUNT=0
declare -A PROJECT_CHANGES  # project_dir → "npm|build|restart"

if [[ "$OLD_HEAD" != "$NEW_HEAD" ]]; then
  CHANGED_FILES=$(git diff --name-only "$OLD_HEAD" "$NEW_HEAD" 2>/dev/null || true)
else
  # Force mode — no changes to categorize, but stamp version
  CHANGED_FILES=""
  VERSION_CHANGED=true
fi

while IFS= read -r file; do
  [[ -z "$file" ]] && continue

  case "$file" in
    daemon/dist/*)
      DAEMON_RESTART=true
      ;;
    daemon/package*.json)
      DAEMON_NPM=true
      ;;
    daemon/ecosystem.config.cjs)
      DAEMON_RESTART=true
      ;;
    nginx/projects/*)
      NGINX_RELOAD=true
      ;;
    scripts/*)
      SCRIPTS_CHANGED=true
      ;;
    VERSION)
      VERSION_CHANGED=true
      ;;
    projects/*/*)
      # Extract project directory name
      proj_dir=$(printf '%s' "$file" | cut -d/ -f2)
      existing="${PROJECT_CHANGES[$proj_dir]+${PROJECT_CHANGES[$proj_dir]}}"

      if [[ -z "$existing" ]]; then
        (( PROJECT_COUNT++ )) || true
      fi

      case "$file" in
        projects/*/package*.json)
          PROJECT_CHANGES[$proj_dir]="${existing:+$existing|}npm"
          ;;
        *)
          PROJECT_CHANGES[$proj_dir]="${existing:+$existing|}source"
          ;;
      esac
      ;;
  esac
done <<< "$CHANGED_FILES"

# ── Summary ──────────────────────────────────────────────────────────────────

log "Changes: daemon_restart=$DAEMON_RESTART daemon_npm=$DAEMON_NPM nginx=$NGINX_RELOAD scripts=$SCRIPTS_CHANGED version=$VERSION_CHANGED projects=$PROJECT_COUNT"

if $DRY_RUN; then
  log "DRY-RUN: Changed files:"
  while IFS= read -r f; do
    [[ -n "$f" ]] && log "  $f"
  done <<< "$CHANGED_FILES"
  if (( PROJECT_COUNT > 0 )); then
    for proj in "${!PROJECT_CHANGES[@]}"; do
      log "DRY-RUN: Project '$proj' needs: ${PROJECT_CHANGES[$proj]}"
    done
  fi
  if $DAEMON_RESTART; then log "DRY-RUN: Daemon restart WOULD be triggered"; fi
  if $NGINX_RELOAD; then log "DRY-RUN: Nginx reload WOULD be triggered"; fi
  log "DRY-RUN: complete"
  exit 0
fi

# ── PM2 name mapping ────────────────────────────────────────────────────────
# Map project directories to PM2 process names via pm2 jlist

declare -A PM2_MAP   # project_dir → pm2_name
declare -A PM2_STATUS # pm2_name → status

PM2_JSON=$(pm2 jlist 2>/dev/null || echo "[]")

while IFS='|' read -r pm2_name pm2_cwd pm2_status; do
  [[ -z "$pm2_name" ]] && continue
  PM2_STATUS[$pm2_name]="$pm2_status"
  # Extract project dir from cwd if it's under projects/
  if [[ "$pm2_cwd" == "$SCWS_ROOT/projects/"* ]]; then
    proj_dir=$(printf '%s' "$pm2_cwd" | sed "s|$SCWS_ROOT/projects/||" | cut -d/ -f1)
    PM2_MAP[$proj_dir]="$pm2_name"
  fi
done < <(printf '%s' "$PM2_JSON" | jq -r '.[] | "\(.name)|\(.pm2_env.pm_cwd // .pm2_env.PWD // "")|\(.pm2_env.status // "unknown")"' 2>/dev/null || true)

# ── Per-project updates ─────────────────────────────────────────────────────

PROJECTS_UPDATED=0
PROJECTS_FAILED=0

if (( PROJECT_COUNT > 0 )); then
for proj_dir in "${!PROJECT_CHANGES[@]}"; do
  proj_path="$SCWS_ROOT/projects/$proj_dir"
  changes="${PROJECT_CHANGES[$proj_dir]}"
  pm2_name="${PM2_MAP[$proj_dir]:-}"

  log "Updating project: $proj_dir (changes: $changes, pm2: ${pm2_name:-none})"

  if [[ ! -d "$proj_path" ]]; then
    warn "Project directory missing: $proj_path, skipping"
    continue
  fi

  # npm install if package.json changed
  if [[ "$changes" == *"npm"* ]] && [[ -f "$proj_path/package.json" ]]; then
    log "  npm install for $proj_dir..."
    if ! (cd "$proj_path" && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1); then
      warn "  npm install failed for $proj_dir"
      (( PROJECTS_FAILED++ )) || true
      continue
    fi
  fi

  # Build if source changed and build script exists
  if [[ "$changes" == *"source"* ]] && [[ -f "$proj_path/package.json" ]]; then
    if jq -e '.scripts.build' "$proj_path/package.json" >/dev/null 2>&1; then
      log "  Building $proj_dir..."
      if ! (cd "$proj_path" && npm run build 2>&1 | tail -3); then
        warn "  Build failed for $proj_dir"
        (( PROJECTS_FAILED++ )) || true
        continue
      fi
    fi
  fi

  # Restart PM2 process only if it was online
  if [[ -n "$pm2_name" ]]; then
    status="${PM2_STATUS[$pm2_name]:-unknown}"
    if [[ "$status" == "online" ]]; then
      log "  Restarting PM2 process: $pm2_name"
      pm2 restart "$pm2_name" --update-env >/dev/null 2>&1 || warn "  Failed to restart $pm2_name"
    else
      log "  Skipping restart for $pm2_name (status: $status)"
    fi
  else
    log "  No PM2 process found for $proj_dir, skipping restart"
  fi

  (( PROJECTS_UPDATED++ )) || true
done
fi  # PROJECT_COUNT > 0

# ── Daemon npm install ───────────────────────────────────────────────────────

if $DAEMON_NPM; then
  log "Running npm install for daemon..."
  (cd "$SCWS_ROOT/daemon" && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1) || warn "Daemon npm install failed"
fi

# ── Scripts chmod ────────────────────────────────────────────────────────────

if $SCRIPTS_CHANGED; then
  log "Ensuring scripts are executable..."
  chmod +x "$SCWS_ROOT/scripts/"*.sh 2>/dev/null || true
fi

# ── Nginx reload ─────────────────────────────────────────────────────────────

if $NGINX_RELOAD; then
  log "Testing and reloading nginx..."
  if sudo nginx -t 2>&1; then
    sudo nginx -s reload
    log "Nginx reloaded"
  else
    warn "Nginx config test failed — not reloading"
  fi
fi

# ── Stamp version ────────────────────────────────────────────────────────────

if $VERSION_CHANGED || [[ "$OLD_HEAD" != "$NEW_HEAD" ]]; then
  log "Stamping version..."
  bash "$SCWS_ROOT/scripts/stamp-version.sh" --deploy-method=auto-update 2>/dev/null || warn "Version stamp failed"
fi

# ── PM2 save ─────────────────────────────────────────────────────────────────

pm2 save --force >/dev/null 2>&1 || true

# ── Notifications ────────────────────────────────────────────────────────────

VERSION=$(cat "$SCWS_ROOT/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "unknown")

SUMMARY="System updated to v${VERSION} (${OLD_SHORT} → ${NEW_SHORT})"
if (( COMMIT_COUNT > 0 )); then
  SUMMARY="$SUMMARY, ${COMMIT_COUNT} commit(s)"
fi
if (( PROJECTS_UPDATED > 0 )); then
  SUMMARY="$SUMMARY, ${PROJECTS_UPDATED} project(s) updated"
fi
if (( PROJECTS_FAILED > 0 )); then
  SUMMARY="$SUMMARY, ${PROJECTS_FAILED} project(s) FAILED"
fi
if $DAEMON_RESTART; then
  SUMMARY="$SUMMARY, daemon restart pending"
fi

log "$SUMMARY"
notify_daemon "$SUMMARY"
notify_cortex "$SUMMARY"

# ── Daemon restart LAST ──────────────────────────────────────────────────────

if $DAEMON_RESTART; then
  log "Daemon files changed — restarting scws-daemon (this will terminate any active Claude session)"
  pm2 save --force >/dev/null 2>&1 || true
  pm2 restart scws-daemon >/dev/null 2>&1 &
  # Backgrounded so this script can exit cleanly before being killed
  exit 0
fi

log "Auto-update complete"
