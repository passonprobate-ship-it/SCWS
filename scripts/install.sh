#!/usr/bin/env bash
# =============================================================================
# SPAWN One-Line Installer — Self-Programming Autonomous Web Node
# =============================================================================
# Install SPAWN on a fresh Ubuntu VPS with a single command:
#
#   curl -fsSL https://raw.githubusercontent.com/passonprobate-ship-it/SCWS/master/scripts/install.sh | bash
#
# Supported: Ubuntu 20.04, 22.04, 24.04 (amd64 or arm64)
#
# What this does:
#   1. Clones the SPAWN repo to /var/www/scws
#   2. Runs bootstrap-vps.sh (system deps, PostgreSQL, nginx, PM2, etc.)
#   3. Generates secrets, .env, and ecosystem.config.cjs
#   4. Creates the database schema
#   5. Starts the daemon via PM2
#   6. Installs auto-update cron
#   7. Verifies everything is running
# =============================================================================
set -euo pipefail

SCWS_ROOT="/var/www/scws"
REPO_URL="https://github.com/passonprobate-ship-it/SCWS.git"
BRANCH="master"

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

log()  { printf "${GREEN}[SPAWN]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[WARN]${NC} %s\n" "$*"; }
err()  { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; }

banner() {
  printf "\n${CYAN}${BOLD}"
  printf '  ____  ____   ___  _      __ _   _\n'
  printf ' / ___||  _ \\ / _ \\| |    / /| \\ | |\n'
  printf ' \\___ \\| |_) / /_\\ | | /\\/ / |  \\| |\n'
  printf '  ___) |  __/ ___ | |/ __/  | |\\  |\n'
  printf ' |____/|_| /_/   \\_|__/\\_\\  |_| \\_|\n'
  printf "${NC}\n"
  printf "  ${DIM}One-Line Installer${NC}\n\n"
}

# ── 1. Preflight checks ────────────────────────────────────────────────────

banner

log "Running preflight checks..."

# Must be root
if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root."
  printf "  Run: ${CYAN}sudo bash${NC} or ${CYAN}curl ... | sudo bash${NC}\n"
  exit 1
fi

# Must be Ubuntu
if [[ ! -f /etc/os-release ]]; then
  err "Cannot detect OS. This installer requires Ubuntu."
  exit 1
fi

source /etc/os-release

if [[ "$ID" != "ubuntu" ]]; then
  err "Unsupported OS: $ID. This installer requires Ubuntu."
  exit 1
fi

UBUNTU_MAJOR="${VERSION_ID%%.*}"
if [[ "$UBUNTU_MAJOR" -lt 20 ]]; then
  err "Unsupported Ubuntu version: $VERSION_ID. Requires 20.04 or later."
  exit 1
fi

# Detect architecture
ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
case "$ARCH" in
  amd64|x86_64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)
    err "Unsupported architecture: $ARCH. Requires amd64 or arm64."
    exit 1
    ;;
esac

log "OS: Ubuntu $VERSION_ID ($ARCH)"

# Check if already installed
if [[ -d "$SCWS_ROOT/daemon/dist" ]] && [[ -f "$SCWS_ROOT/daemon/.env" ]]; then
  warn "SPAWN appears to be already installed at $SCWS_ROOT"
  printf "  To update, use: ${CYAN}bash $SCWS_ROOT/scripts/auto-update.sh --force${NC}\n"
  printf "  To reinstall, remove $SCWS_ROOT first.\n"
  exit 1
fi

# Must have git (install if missing)
if ! command -v git &>/dev/null; then
  log "Installing git..."
  apt-get update -qq && apt-get install -y -qq git
fi

# ── 2. Generate secrets ────────────────────────────────────────────────────

log "Generating secrets..."

SPAWN_DB_PASSWORD=$(openssl rand -hex 24)
DASHBOARD_TOKEN=$(openssl rand -hex 24)

log "Secrets generated (will be saved to .env)"

# ── 3. Clone the repository ────────────────────────────────────────────────

log "Cloning SPAWN repository..."

if [[ -d "$SCWS_ROOT" ]]; then
  warn "$SCWS_ROOT already exists but is incomplete — removing and re-cloning"
  rm -rf "$SCWS_ROOT"
fi

git clone --branch "$BRANCH" "$REPO_URL" "$SCWS_ROOT"

log "Repository cloned to $SCWS_ROOT"

# ── 4. Run bootstrap ──────────────────────────────────────────────────────

# Auto-detect Raspberry Pi via device tree
IS_PI=false
if [[ -f /proc/device-tree/model ]]; then
  DT_MODEL=$(tr -d '\0' < /proc/device-tree/model)
  if echo "$DT_MODEL" | grep -qi "raspberry pi"; then
    IS_PI=true
    log "Detected Raspberry Pi: $DT_MODEL"
  fi
fi

if $IS_PI; then
  BOOTSTRAP_SCRIPT="$SCWS_ROOT/projects/spawn-pi/bootstrap-pi.sh"
else
  BOOTSTRAP_SCRIPT="$SCWS_ROOT/projects/spawn-vps/bootstrap-vps.sh"
fi

if [[ ! -f "$BOOTSTRAP_SCRIPT" ]]; then
  err "Bootstrap script not found at $BOOTSTRAP_SCRIPT"
  err "The repository may be incomplete."
  exit 1
fi

log "Running system bootstrap (this takes a few minutes)..."

export SPAWN_DB_PASSWORD
if $IS_PI; then
  # Pi defaults
  export SPAWN_USER="${SPAWN_USER:-codeman}"
  export SPAWN_HOSTNAME="${SPAWN_HOSTNAME:-SPAWN}"
  export ENABLE_TAILSCALE="${ENABLE_TAILSCALE:-true}"
  export INSTALL_DOCKER="${INSTALL_DOCKER:-true}"
  export ENABLE_GPIO="${ENABLE_GPIO:-true}"
  export ENABLE_I2C="${ENABLE_I2C:-true}"
  export ENABLE_SPI="${ENABLE_SPI:-true}"
  export ENABLE_PWM="${ENABLE_PWM:-true}"
  export ENABLE_UART="${ENABLE_UART:-true}"
  export ENABLE_CHROMIUM="${ENABLE_CHROMIUM:-true}"
  export EXTRA_DATABASES="${EXTRA_DATABASES:-spawn_cortex,solbot_db}"
else
  # VPS defaults
  export SPAWN_USER="${SPAWN_USER:-spawn}"
  export SPAWN_HOSTNAME="${SPAWN_HOSTNAME:-SPAWN}"
  export SPAWN_DOMAIN="${SPAWN_DOMAIN:-}"
  export ENABLE_SSL="${ENABLE_SSL:-false}"
  export SSL_EMAIL="${SSL_EMAIL:-}"
  export ENABLE_TAILSCALE="${ENABLE_TAILSCALE:-false}"
  export INSTALL_DOCKER="${INSTALL_DOCKER:-false}"
fi

bash "$BOOTSTRAP_SCRIPT"

log "System bootstrap complete"

# ── 5. Read scaling values from bootstrap ───────────────────────────────────

DAEMON_HEAP=192
PM2_RESTART="200M"

if [[ -f /tmp/spawn-bootstrap-values ]]; then
  source /tmp/spawn-bootstrap-values
  rm -f /tmp/spawn-bootstrap-values
  log "Scaling: heap=${DAEMON_HEAP}MB restart=${PM2_RESTART}"
fi

# ── 6. Install daemon npm dependencies ──────────────────────────────────────

log "Installing daemon dependencies..."

cd "$SCWS_ROOT/daemon"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3

log "Daemon dependencies installed"

# ── 7. Generate .env ────────────────────────────────────────────────────────

log "Generating daemon .env..."

ENV_TEMPLATE="$SCWS_ROOT/projects/spawn-vps/templates/env.template"
if $IS_PI && [[ -f "$SCWS_ROOT/projects/spawn-pi/templates/env.template" ]]; then
  ENV_TEMPLATE="$SCWS_ROOT/projects/spawn-pi/templates/env.template"
fi
ENV_FILE="$SCWS_ROOT/daemon/.env"

# Detect base URL
if [[ -n "${SPAWN_DOMAIN:-}" ]]; then
  if [[ "${ENABLE_SSL:-false}" == "true" ]]; then
    BASE_URL="https://$SPAWN_DOMAIN"
  else
    BASE_URL="http://$SPAWN_DOMAIN"
  fi
elif $IS_PI; then
  # Pi: prefer Tailscale IP, then LAN IP
  TS_IP=$(tailscale ip -4 2>/dev/null || true)
  if [[ -n "$TS_IP" ]]; then
    BASE_URL="http://$TS_IP"
  else
    LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
    BASE_URL="http://${LAN_IP:-localhost:4000}"
  fi
else
  # VPS: public IP
  VPS_PUBLIC_IP=$(curl -s --max-time 5 http://ifconfig.me 2>/dev/null || true)
  if [[ -n "$VPS_PUBLIC_IP" ]]; then
    BASE_URL="http://$VPS_PUBLIC_IP"
  else
    BASE_URL="http://localhost:4000"
  fi
fi

if [[ -f "$ENV_TEMPLATE" ]]; then
  sed \
    -e "s|{{DB_PASSWORD}}|${SPAWN_DB_PASSWORD}|g" \
    -e "s|{{DASHBOARD_TOKEN}}|${DASHBOARD_TOKEN}|g" \
    -e "s|{{BASE_URL}}|${BASE_URL}|g" \
    "$ENV_TEMPLATE" > "$ENV_FILE"
else
  # Fallback: write .env directly
  cat > "$ENV_FILE" <<ENVEOF
DATABASE_URL=postgresql://scws:${SPAWN_DB_PASSWORD}@localhost:5432/scws_daemon
PORT=4000
DASHBOARD_TOKEN=${DASHBOARD_TOKEN}
SCWS_DB_PASSWORD=${SPAWN_DB_PASSWORD}
SCWS_BASE_URL=${BASE_URL}
NODE_ENV=production
ENVEOF
fi

chmod 600 "$ENV_FILE"
log ".env written to $ENV_FILE"

# ── 8. Generate ecosystem.config.cjs ───────────────────────────────────────

log "Generating PM2 ecosystem config..."

ECO_TEMPLATE="$SCWS_ROOT/projects/spawn-vps/templates/ecosystem.template.cjs"
if $IS_PI && [[ -f "$SCWS_ROOT/projects/spawn-pi/templates/ecosystem.template.cjs" ]]; then
  ECO_TEMPLATE="$SCWS_ROOT/projects/spawn-pi/templates/ecosystem.template.cjs"
fi
ECO_FILE="$SCWS_ROOT/daemon/ecosystem.config.cjs"

if [[ -f "$ECO_TEMPLATE" ]]; then
  sed \
    -e "s|{{DAEMON_HEAP}}|${DAEMON_HEAP}|g" \
    -e "s|{{PM2_RESTART}}|${PM2_RESTART}|g" \
    "$ECO_TEMPLATE" > "$ECO_FILE"
else
  # Fallback: write config directly
  cat > "$ECO_FILE" <<'ECOEOF'
const { readFileSync } = require('fs');
const envFile = readFileSync('/var/www/scws/daemon/.env', 'utf-8');
const env = {};
for (const line of envFile.split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}
module.exports = {
  apps: [{
    name: 'scws-daemon',
    script: 'dist/index.cjs',
    cwd: '/var/www/scws/daemon',
ECOEOF
  # Append the dynamic parts
  printf "    node_args: '--dns-result-order=ipv4first --max-old-space-size=%s',\n" "$DAEMON_HEAP" >> "$ECO_FILE"
  printf "    max_memory_restart: '%s',\n" "$PM2_RESTART" >> "$ECO_FILE"
  cat >> "$ECO_FILE" <<'ECOEOF2'
    env
  }]
};
ECOEOF2
fi

log "ecosystem.config.cjs generated"

# ── 9. Create database schema ──────────────────────────────────────────────

log "Creating database schema..."

SCHEMA_FILE="$SCWS_ROOT/scripts/schema.sql"

if [[ -f "$SCHEMA_FILE" ]]; then
  sudo -u postgres psql -d scws_daemon -f "$SCHEMA_FILE" 2>&1 | tail -5
  log "Schema applied from $SCHEMA_FILE"
else
  err "Schema file not found at $SCHEMA_FILE"
  exit 1
fi

# ── 10. Fix ownership ──────────────────────────────────────────────────────

log "Setting file ownership..."

chown -R "${SPAWN_USER}:${SPAWN_USER}" "$SCWS_ROOT"

# ── 11. Start daemon ───────────────────────────────────────────────────────

log "Starting SPAWN daemon..."

cd "$SCWS_ROOT/daemon"
sudo -u "$SPAWN_USER" pm2 start ecosystem.config.cjs
sudo -u "$SPAWN_USER" pm2 save

log "Daemon started via PM2"

# ── 12. Install auto-update cron ───────────────────────────────────────────

log "Installing auto-update cron..."

chmod +x "$SCWS_ROOT/scripts/"*.sh 2>/dev/null || true

AUTO_UPDATE_CRON="*/5 * * * * bash $SCWS_ROOT/scripts/auto-update.sh >> $SCWS_ROOT/logs/auto-update.log 2>&1"
EXISTING_CRON=$(sudo -u "$SPAWN_USER" crontab -l 2>/dev/null | grep -v 'auto-update.sh' || true)
printf '%s\n%s\n' "$EXISTING_CRON" "$AUTO_UPDATE_CRON" | sudo -u "$SPAWN_USER" crontab -

log "Auto-update cron installed (every 5 minutes)"

# ── 13. Stamp version ──────────────────────────────────────────────────────

if [[ -f "$SCWS_ROOT/scripts/stamp-version.sh" ]]; then
  bash "$SCWS_ROOT/scripts/stamp-version.sh" --deploy-method=install 2>/dev/null || true
fi

# ── 14. Health check ───────────────────────────────────────────────────────

log "Running health check..."

sleep 3

HEALTH_OK=false
for i in 1 2 3 4 5; do
  if curl -sf http://localhost:4000/health >/dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi
  sleep 2
done

# ── 15. Print summary ──────────────────────────────────────────────────────

printf "\n"
if $HEALTH_OK; then
  printf "${GREEN}${BOLD}"
  printf "  =============================================\n"
  printf "    SPAWN is installed and running!\n"
  printf "  =============================================\n"
  printf "${NC}\n"
else
  printf "${YELLOW}${BOLD}"
  printf "  =============================================\n"
  printf "    SPAWN installed but health check failed\n"
  printf "  =============================================\n"
  printf "${NC}\n"
  printf "  Check logs: ${CYAN}sudo -u $SPAWN_USER pm2 logs scws-daemon --lines 30${NC}\n\n"
fi

CREDS_FILE="$SCWS_ROOT/daemon/.install-credentials"
cat > "$CREDS_FILE" <<CREDSEOF
SPAWN Install Credentials — $(date)
Dashboard URL:    ${BASE_URL}
Dashboard Token:  ${DASHBOARD_TOKEN}
DB Password:      ${SPAWN_DB_PASSWORD}
System User:      ${SPAWN_USER}
Install Path:     ${SCWS_ROOT}
.env:             ${SCWS_ROOT}/daemon/.env
CREDSEOF
chmod 600 "$CREDS_FILE"
chown "${SPAWN_USER}:${SPAWN_USER}" "$CREDS_FILE"

printf "  ${BOLD}Dashboard:${NC}       ${CYAN}${BASE_URL}${NC}\n"
printf "  ${BOLD}System User:${NC}     ${CYAN}${SPAWN_USER}${NC}\n"
printf "  ${BOLD}Install Path:${NC}    ${CYAN}${SCWS_ROOT}${NC}\n"
printf "  ${BOLD}.env:${NC}            ${CYAN}${SCWS_ROOT}/daemon/.env${NC}\n"
printf "\n"
printf "  ${YELLOW}${BOLD}Credentials saved to:${NC} ${CYAN}${CREDS_FILE}${NC}\n"
printf "  ${DIM}(readable only by ${SPAWN_USER} — chmod 600)${NC}\n"
printf "\n"
printf "  ${BOLD}Next steps:${NC}\n"
printf "    1. Open the dashboard: ${CYAN}${BASE_URL}${NC}\n"
printf "    2. Run onboarding (Claude CLI, auth, GitHub):\n"
if $IS_PI; then
  printf "       ${CYAN}sudo -u $SPAWN_USER bash $SCWS_ROOT/projects/spawn-pi/onboard.sh${NC}\n"
else
  printf "       ${CYAN}sudo -u $SPAWN_USER bash $SCWS_ROOT/projects/spawn-vps/onboard.sh${NC}\n"
fi
printf "    3. Start building! Open the Terminal page in the dashboard.\n"
printf "\n"
printf "  ${BOLD}Useful commands:${NC}\n"
printf "    ${CYAN}sudo -u $SPAWN_USER pm2 status${NC}           # Process status\n"
printf "    ${CYAN}sudo -u $SPAWN_USER pm2 logs scws-daemon${NC} # Daemon logs\n"
printf "    ${CYAN}cat $SCWS_ROOT/daemon/.env${NC}         # View credentials\n"
printf "\n"
