#!/usr/bin/env bash
# =============================================================================
# SPAWN VPS Deploy — Deploy SPAWN daemon to a remote VPS
# =============================================================================
# Runs from the Pi (or any machine with the SPAWN repo).
# Deploys the daemon bundle + all dependencies to a remote VPS.
#
# Usage:
#   cp config.example.sh config.sh && nano config.sh
#   bash deploy.sh                    # Full deploy (bootstrap + daemon)
#   bash deploy.sh --bootstrap-only   # Just run bootstrap on VPS
#   bash deploy.sh --update-only      # Skip bootstrap, update daemon bundle
#   bash deploy.sh --package          # Create tarball for manual deploy
#
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCWS_ROOT="/var/www/scws"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[DEPLOY]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }
info() { echo -e "${CYAN}[INFO]${NC} $*"; }

# ── Parse flags ───────────────────────────────────────────────────────────────
MODE="full"
for arg in "$@"; do
  case "$arg" in
    --bootstrap-only) MODE="bootstrap" ;;
    --update-only)    MODE="update" ;;
    --package)        MODE="package" ;;
    --help|-h)
      echo "Usage: bash deploy.sh [--bootstrap-only|--update-only|--package]"
      echo ""
      echo "  (no flag)        Full deploy: bootstrap + daemon"
      echo "  --bootstrap-only Just install system dependencies on VPS"
      echo "  --update-only    Skip bootstrap, update daemon bundle only"
      echo "  --package        Create tarball for manual deploy"
      echo ""
      exit 0
      ;;
    *)
      err "Unknown flag: $arg"
      exit 1
      ;;
  esac
done

# ── Package mode (no config needed) ──────────────────────────────────────────
if [[ "$MODE" == "package" ]]; then
  log "Creating deployment package..."
  bash "${SCRIPT_DIR}/package.sh"
  exit $?
fi

# ── Load config ───────────────────────────────────────────────────────────────
CONFIG_FILE="${SCRIPT_DIR}/config.sh"
if [[ ! -f "$CONFIG_FILE" ]]; then
  err "Config file not found: $CONFIG_FILE"
  err "Copy config.example.sh to config.sh and fill in your values."
  exit 1
fi
source "$CONFIG_FILE"

# ── Validate required fields ─────────────────────────────────────────────────
if [[ -z "${VPS_HOST:-}" ]]; then
  err "VPS_HOST is required in config.sh"
  exit 1
fi

# Defaults
VPS_USER="${VPS_USER:-root}"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
SPAWN_USER="${SPAWN_USER:-spawn}"
SPAWN_HOSTNAME="${SPAWN_HOSTNAME:-SPAWN}"
SPAWN_DOMAIN="${SPAWN_DOMAIN:-}"
ENABLE_SSL="${ENABLE_SSL:-false}"
SSL_EMAIL="${SSL_EMAIL:-}"
ENABLE_TAILSCALE="${ENABLE_TAILSCALE:-false}"
INSTALL_DOCKER="${INSTALL_DOCKER:-false}"

# Auto-generate secrets if not provided
if [[ -z "${SPAWN_DB_PASSWORD:-}" ]]; then
  SPAWN_DB_PASSWORD=$(openssl rand -hex 24)
fi
if [[ -z "${SPAWN_DASHBOARD_TOKEN:-}" ]]; then
  SPAWN_DASHBOARD_TOKEN=$(openssl rand -hex 24)
fi

# Compute base URL
if [[ -z "${SPAWN_BASE_URL:-}" ]]; then
  if [[ -n "$SPAWN_DOMAIN" ]]; then
    if [[ "$ENABLE_SSL" == "true" ]]; then
      SPAWN_BASE_URL="https://${SPAWN_DOMAIN}"
    else
      SPAWN_BASE_URL="http://${SPAWN_DOMAIN}"
    fi
  else
    SPAWN_BASE_URL="http://${VPS_HOST}"
  fi
fi

# SSH args
SSH_KEY_ARG=""
if [[ -n "${VPS_SSH_KEY:-}" ]]; then
  SSH_KEY_ARG="-i ${VPS_SSH_KEY}"
fi
SSH_CMD="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p ${VPS_SSH_PORT} ${SSH_KEY_ARG} ${VPS_USER}@${VPS_HOST}"
SCP_CMD="scp -o StrictHostKeyChecking=accept-new -P ${VPS_SSH_PORT} ${SSH_KEY_ARG}"

# ── Phase 1: Validate connectivity ───────────────────────────────────────────
log "Phase 1: Validating SSH connectivity to ${VPS_HOST}..."
if ! $SSH_CMD "echo 'SSH OK'" 2>/dev/null; then
  err "Cannot connect to ${VPS_USER}@${VPS_HOST}:${VPS_SSH_PORT}"
  exit 1
fi
log "SSH connection verified."

# ── Phase 2: Bootstrap (if needed) ───────────────────────────────────────────
if [[ "$MODE" != "update" ]]; then
  log "Phase 2: Running bootstrap on VPS..."

  # Upload bootstrap script
  $SCP_CMD "${SCRIPT_DIR}/bootstrap-vps.sh" "${VPS_USER}@${VPS_HOST}:/tmp/bootstrap-vps.sh"

  # Run bootstrap with config vars as environment
  $SSH_CMD "
    export SPAWN_USER='${SPAWN_USER}'
    export SPAWN_HOSTNAME='${SPAWN_HOSTNAME}'
    export SPAWN_DOMAIN='${SPAWN_DOMAIN}'
    export SPAWN_DB_PASSWORD='${SPAWN_DB_PASSWORD}'
    export ENABLE_SSL='${ENABLE_SSL}'
    export SSL_EMAIL='${SSL_EMAIL}'
    export ENABLE_TAILSCALE='${ENABLE_TAILSCALE}'
    export INSTALL_DOCKER='${INSTALL_DOCKER}'
    bash /tmp/bootstrap-vps.sh
    rm -f /tmp/bootstrap-vps.sh
  "

  log "Bootstrap complete."

  if [[ "$MODE" == "bootstrap" ]]; then
    log "Bootstrap-only mode. Done."
    echo ""
    info "Next: run 'bash deploy.sh --update-only' to deploy the daemon."
    exit 0
  fi
fi

# ── Phase 3: Read VPS scaling values ──────────────────────────────────────────
if [[ "$MODE" != "update" ]]; then
  log "Phase 3: Reading VPS scaling values..."
  DAEMON_HEAP=$($SSH_CMD "cat /tmp/spawn-bootstrap-values 2>/dev/null | grep DAEMON_HEAP | cut -d= -f2" 2>/dev/null || true)
  PM2_RESTART=$($SSH_CMD "cat /tmp/spawn-bootstrap-values 2>/dev/null | grep PM2_RESTART | cut -d= -f2" 2>/dev/null || true)
  DAEMON_HEAP="${DAEMON_HEAP:-192}"
  PM2_RESTART="${PM2_RESTART:-200M}"
  $SSH_CMD "rm -f /tmp/spawn-bootstrap-values" 2>/dev/null || true
  log "Using heap=${DAEMON_HEAP}MB restart=${PM2_RESTART}"
fi

# ── Phase 4: Upload daemon ───────────────────────────────────────────────────
log "Phase 4: Uploading daemon bundle..."

# Verify source files exist
for f in daemon/dist/index.cjs daemon/dist/dashboard.html daemon/package.json; do
  if [[ ! -f "${SCWS_ROOT}/${f}" ]]; then
    err "Missing source file: ${SCWS_ROOT}/${f}"
    exit 1
  fi
done

# Ensure remote directories exist
$SSH_CMD "sudo -u ${SPAWN_USER} mkdir -p /var/www/scws/daemon/dist /var/www/scws/scripts /var/www/scws/nginx/projects"

# Upload files
log "  Uploading daemon bundle..."
$SCP_CMD "${SCWS_ROOT}/daemon/dist/index.cjs" "${VPS_USER}@${VPS_HOST}:/var/www/scws/daemon/dist/"
$SCP_CMD "${SCWS_ROOT}/daemon/dist/dashboard.html" "${VPS_USER}@${VPS_HOST}:/var/www/scws/daemon/dist/"
$SCP_CMD "${SCWS_ROOT}/daemon/package.json" "${VPS_USER}@${VPS_HOST}:/var/www/scws/daemon/"

log "  Uploading scripts..."
$SCP_CMD "${SCWS_ROOT}/scripts/set-oom-scores.sh" "${VPS_USER}@${VPS_HOST}:/var/www/scws/scripts/"
$SCP_CMD "${SCWS_ROOT}/scripts/backup-db.sh" "${VPS_USER}@${VPS_HOST}:/var/www/scws/scripts/"

# Upload onboarding files
log "  Uploading onboarding files..."
ONBOARD_DIR="${SCRIPT_DIR}"
if [[ -f "${ONBOARD_DIR}/onboard.sh" ]]; then
  $SSH_CMD "sudo -u ${SPAWN_USER} mkdir -p /var/www/scws/lib"
  $SCP_CMD "${ONBOARD_DIR}/onboard.sh" "${VPS_USER}@${VPS_HOST}:/var/www/scws/"
  if [[ -f "${ONBOARD_DIR}/lib/onboard-detect.sh" ]]; then
    $SCP_CMD "${ONBOARD_DIR}/lib/onboard-detect.sh" "${VPS_USER}@${VPS_HOST}:/var/www/scws/lib/"
  fi
else
  warn "Onboarding files not found at ${ONBOARD_DIR} — skipping"
fi

# Fix ownership after SCP (runs as root)
$SSH_CMD "chown -R ${SPAWN_USER}:${SPAWN_USER} /var/www/scws && chmod +x /var/www/scws/scripts/*.sh /var/www/scws/onboard.sh 2>/dev/null || true"

# ── Phase 5: Install native dependencies on VPS ──────────────────────────────
log "Phase 5: Installing node dependencies on VPS (rebuilds node-pty for target arch)..."
$SSH_CMD "cd /var/www/scws/daemon && sudo -u ${SPAWN_USER} npm install --omit=dev 2>&1 | tail -5"

# ── Phase 6: Generate config files ───────────────────────────────────────────
if [[ "$MODE" == "update" ]]; then
  # Update mode: preserve existing .env and ecosystem config
  log "Phase 6: Preserving existing .env and ecosystem.config.cjs (update mode)"
  HAS_ENV=$($SSH_CMD "test -f /var/www/scws/daemon/.env && echo yes || echo no" 2>/dev/null)
  if [[ "$HAS_ENV" != "yes" ]]; then
    err "No .env found on VPS. Run full deploy first (without --update-only)."
    exit 1
  fi
else
  log "Phase 6: Generating .env and ecosystem.config.cjs..."

  # Generate .env from template
  ENV_CONTENT=$(cat "${SCRIPT_DIR}/templates/env.template" \
    | sed "s|{{DB_PASSWORD}}|${SPAWN_DB_PASSWORD}|g" \
    | sed "s|{{DASHBOARD_TOKEN}}|${SPAWN_DASHBOARD_TOKEN}|g" \
    | sed "s|{{BASE_URL}}|${SPAWN_BASE_URL}|g")

  $SSH_CMD "cat > /var/www/scws/daemon/.env << 'ENVEOF'
${ENV_CONTENT}
ENVEOF
chown ${SPAWN_USER}:${SPAWN_USER} /var/www/scws/daemon/.env
chmod 600 /var/www/scws/daemon/.env"

  # Generate ecosystem.config.cjs from template
  ECO_CONTENT=$(cat "${SCRIPT_DIR}/templates/ecosystem.template.cjs" \
    | sed "s|{{DAEMON_HEAP}}|${DAEMON_HEAP}|g" \
    | sed "s|{{PM2_RESTART}}|${PM2_RESTART}|g")

  $SSH_CMD "cat > /var/www/scws/daemon/ecosystem.config.cjs << 'ECOEOF'
${ECO_CONTENT}
ECOEOF
chown ${SPAWN_USER}:${SPAWN_USER} /var/www/scws/daemon/ecosystem.config.cjs"
fi

# ── Phase 6b: Push database schema (full deploy only) ───────────────────────
if [[ "$MODE" != "update" ]]; then
  log "Phase 6b: Pushing database schema..."
  SCHEMA_DUMP=$(sudo -u postgres pg_dump --schema-only --no-owner --no-privileges scws_daemon 2>/dev/null || true)
  if [[ -n "$SCHEMA_DUMP" ]]; then
    printf '%s' "$SCHEMA_DUMP" | $SSH_CMD "sudo -u postgres psql scws_daemon 2>&1 | tail -5"
    # Grant permissions to the scws role (schema dump strips ownership)
    $SSH_CMD "sudo -u postgres psql scws_daemon -c 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO scws; GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO scws; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO scws; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO scws;'" 2>/dev/null
    log "Schema pushed and permissions granted."
  else
    warn "Could not dump local schema — you may need to push it manually."
  fi
fi

# ── Phase 6c: Deploy memory bundle (full deploy only) ───────────────────────
if [[ "$MODE" != "update" ]]; then
  log "Phase 6c: Deploying memory bundle (CLAUDE.md, MEMORY.md, seed memories)..."

  # Detect VPS architecture and RAM for template rendering
  VPS_ARCH=$($SSH_CMD "dpkg --print-architecture" 2>/dev/null || echo "amd64")
  VPS_RAM=$($SSH_CMD "free -h | awk '/^Mem:/{print \$2}'" 2>/dev/null || echo "unknown")

  # ── Layer 1: VPS-specific CLAUDE.md ──
  if [[ -f "${SCRIPT_DIR}/templates/CLAUDE.vps.md" ]]; then
    CLAUDE_MD=$(cat "${SCRIPT_DIR}/templates/CLAUDE.vps.md" \
      | sed "s|{{USER}}|${SPAWN_USER}|g" \
      | sed "s|{{HOSTNAME}}|${SPAWN_HOSTNAME}|g" \
      | sed "s|{{BASE_URL}}|${SPAWN_BASE_URL}|g" \
      | sed "s|{{ARCH}}|${VPS_ARCH}|g" \
      | sed "s|{{RAM}}|${VPS_RAM}|g")

    $SSH_CMD "cat > /var/www/scws/CLAUDE.md << 'CLAUDEEOF'
${CLAUDE_MD}
CLAUDEEOF
chown ${SPAWN_USER}:${SPAWN_USER} /var/www/scws/CLAUDE.md"
    log "  Deployed /var/www/scws/CLAUDE.md"
  else
    warn "  templates/CLAUDE.vps.md not found — skipping"
  fi

  # ── Layer 2: VPS-specific MEMORY.md ──
  if [[ -f "${SCRIPT_DIR}/templates/MEMORY.vps.md" ]]; then
    MEMORY_DIR="/home/${SPAWN_USER}/.claude/projects/-var-www-scws/memory"
    MEMORY_MD=$(cat "${SCRIPT_DIR}/templates/MEMORY.vps.md" \
      | sed "s|{{USER}}|${SPAWN_USER}|g" \
      | sed "s|{{HOSTNAME}}|${SPAWN_HOSTNAME}|g" \
      | sed "s|{{BASE_URL}}|${SPAWN_BASE_URL}|g" \
      | sed "s|{{ARCH}}|${VPS_ARCH}|g" \
      | sed "s|{{RAM}}|${VPS_RAM}|g")

    $SSH_CMD "sudo -u ${SPAWN_USER} mkdir -p '${MEMORY_DIR}'
cat > '${MEMORY_DIR}/MEMORY.md' << 'MEMEOF'
${MEMORY_MD}
MEMEOF
chown ${SPAWN_USER}:${SPAWN_USER} '${MEMORY_DIR}/MEMORY.md'"
    log "  Deployed ${MEMORY_DIR}/MEMORY.md"
  else
    warn "  templates/MEMORY.vps.md not found — skipping"
  fi

  # ── Layer 3: Seed MCP memories ──
  if [[ -f "${SCRIPT_DIR}/seed-memory.sh" ]]; then
    $SCP_CMD "${SCRIPT_DIR}/seed-memory.sh" "${VPS_USER}@${VPS_HOST}:/tmp/seed-memory.sh"
    $SSH_CMD "bash /tmp/seed-memory.sh && rm -f /tmp/seed-memory.sh"
    log "  Memory seeds applied."
  else
    warn "  seed-memory.sh not found — skipping"
  fi
fi

# ── Phase 7: Start daemon ────────────────────────────────────────────────────
log "Phase 7: Starting SPAWN daemon..."

# Stop existing if running
$SSH_CMD "sudo -u ${SPAWN_USER} pm2 delete scws-daemon 2>/dev/null || true"

# Start via ecosystem config
$SSH_CMD "cd /var/www/scws/daemon && sudo -u ${SPAWN_USER} pm2 start ecosystem.config.cjs && sudo -u ${SPAWN_USER} pm2 save"

# Run OOM score script
$SSH_CMD "bash /var/www/scws/scripts/set-oom-scores.sh 2>/dev/null || true"

# ── Phase 8: Health check ────────────────────────────────────────────────────
log "Phase 8: Health check..."
sleep 3

HEALTH=$($SSH_CMD "curl -s --max-time 5 http://localhost:4000/health" 2>/dev/null || echo "FAIL")
if echo "$HEALTH" | grep -q "uptime\|ok\|status" 2>/dev/null; then
  log "Health check PASSED"
else
  warn "Health check returned unexpected response: $HEALTH"
  warn "Check logs with: ssh ${VPS_USER}@${VPS_HOST} 'sudo -u ${SPAWN_USER} pm2 logs scws-daemon --lines 30'"
fi

# ── Phase 9: External verification ───────────────────────────────────────────
log "Phase 9: External verification..."

EXTERNAL_URL="${SPAWN_BASE_URL:-http://${VPS_HOST}}"
EXT_CHECK=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "$EXTERNAL_URL" 2>/dev/null || echo "000")
if [[ "$EXT_CHECK" == "200" || "$EXT_CHECK" == "401" || "$EXT_CHECK" == "302" ]]; then
  log "External check PASSED (HTTP $EXT_CHECK)"
else
  warn "External check returned HTTP $EXT_CHECK — may need DNS propagation or firewall config"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
log "============================================"
log "  SPAWN deployed to ${VPS_HOST}!"
log "============================================"
echo ""
info "Dashboard URL:   ${SPAWN_BASE_URL}"
if [[ "$MODE" != "update" ]]; then
  info "Dashboard Token: ${SPAWN_DASHBOARD_TOKEN}"
  info "DB Password:     ${SPAWN_DB_PASSWORD}"
fi
echo ""
info "SSH access:      ssh ${VPS_USER}@${VPS_HOST} -p ${VPS_SSH_PORT}"
info "PM2 logs:        ssh ${VPS_USER}@${VPS_HOST} 'sudo -u ${SPAWN_USER} pm2 logs scws-daemon'"
echo ""
if [[ "$ENABLE_TAILSCALE" == "true" ]]; then
  info "Tailscale:       ssh ${VPS_USER}@${VPS_HOST} 'sudo tailscale up --hostname=${SPAWN_HOSTNAME}'"
fi
info "Save these credentials! They won't be shown again."
echo ""
log "──────────────────────────────────────────"
log "  Next: Run onboarding to enable AI"
log "──────────────────────────────────────────"
echo ""
info "SSH into the VPS and run the onboarding wizard:"
echo ""
echo "  ssh ${VPS_USER}@${VPS_HOST} -p ${VPS_SSH_PORT}"
echo "  sudo -u ${SPAWN_USER} bash /var/www/scws/onboard.sh"
echo ""
info "This will set up Claude Code CLI, authentication,"
info "GitHub CLI, and MCP server configuration."
info "Or open the dashboard Setup page for guided instructions."
