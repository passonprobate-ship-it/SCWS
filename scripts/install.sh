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
INSTALL_START=$(date +%s)
FORCE=false

# ── Parse flags ─────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    --help|-h)
      echo "Usage: bash install.sh [--force]"
      echo ""
      echo "  --force   Remove existing installation and start fresh"
      echo ""
      exit 0
      ;;
  esac
done

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

TOTAL_STEPS=15
# Steps: preflight, secrets, clone, bootstrap, daemon-deps, .env, ecosystem,
#        schema, ownership, start-daemon, spawn-mcp, agent-settings,
#        mcp-card (no step call), auto-update, stamp-version, healthcheck
CURRENT_STEP=0
step() {
  CURRENT_STEP=$((CURRENT_STEP + 1))
  printf "${GREEN}[SPAWN ${CURRENT_STEP}/${TOTAL_STEPS}]${NC} %s\n" "$*"
}
log()  { printf "${GREEN}[SPAWN]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[WARN]${NC} %s\n" "$*"; }
err()  { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; }

banner() {
  printf "\n"
  printf "${CYAN}            .-----------------------------.${NC}\n"
  printf "${CYAN}            |  ${GREEN}[]${NC}${CYAN}  ${GREEN}[]${NC}${CYAN}          []    [] |${NC}\n"
  printf "${CYAN}            |         .----------.        |${NC}\n"
  printf "${CYAN}            |         |${GREEN}==========${NC}${CYAN}|        |${NC}\n"
  printf "${CYAN}            |         '----------'        |${NC}\n"
  printf "${CYAN}            '--------------.---.----------'${NC}\n"
  printf "${CYAN}                           |   |${NC}\n"
  printf "${CYAN}                       .---'   '---.${NC}\n"
  printf "${CYAN}                       '----._.----'${NC}\n"
  printf "\n"
  printf "${BOLD}${CYAN}"
  printf '   ███████╗██████╗  █████╗ ██╗    ██╗███╗   ██╗\n'
  printf '   ██╔════╝██╔══██╗██╔══██╗██║    ██║████╗  ██║\n'
  printf '   ███████╗██████╔╝███████║██║ █╗ ██║██╔██╗ ██║\n'
  printf '   ╚════██║██╔═══╝ ██╔══██║██║███╗██║██║╚██╗██║\n'
  printf '   ███████║██║     ██║  ██║╚███╔███╔╝██║ ╚████║\n'
  printf '   ╚══════╝╚═╝     ╚═╝  ╚═╝ ╚══╝╚══╝ ╚═╝  ╚═══╝\n'
  printf "${NC}\n"
  printf "   ${BOLD}Self-Programming Autonomous Web Node${NC}\n"
  printf "   ${DIM}One machine. One install. Unlimited projects.${NC}\n\n"
}

# ── 1. Preflight checks ────────────────────────────────────────────────────

banner

step "Running preflight checks..."

# Must be root
if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root."
  printf "  Run: ${CYAN}sudo bash${NC} or ${CYAN}curl ... | sudo bash${NC}\n"
  exit 1
fi

# Update system packages first
log "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

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

log "  OS: Ubuntu $VERSION_ID ($ARCH)"

# Check disk space (need at least 2GB free)
DISK_FREE_MB=$(df -m / | awk 'NR==2 {print $4}')
if [[ "$DISK_FREE_MB" -lt 2000 ]]; then
  err "Not enough disk space. Need at least 2GB free, have ${DISK_FREE_MB}MB."
  exit 1
fi
log "  Disk: ${DISK_FREE_MB}MB free"

# Check RAM (need at least 2GB)
RAM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
if [[ "$RAM_MB" -lt 1800 ]]; then
  err "Not enough RAM. Need at least 2GB, have ${RAM_MB}MB."
  exit 1
fi
log "  RAM: ${RAM_MB}MB"

# Check if port 80 is already in use by something other than nginx
if command -v ss &>/dev/null; then
  PORT80_PID=$(ss -tlnp 'sport = :80' 2>/dev/null | grep -v nginx | awk 'NR>1 {print $0}' || true)
  if [[ -n "$PORT80_PID" ]]; then
    warn "Port 80 is in use by a non-nginx process. nginx may fail to start."
    warn "Run: ss -tlnp 'sport = :80' to see what's using it."
  fi
fi

# Check if already installed
if [[ -d "$SCWS_ROOT/daemon/dist" ]] && [[ -f "$SCWS_ROOT/daemon/.env" ]]; then
  if $FORCE; then
    warn "Existing installation found — removing it (--force)"
    # Stop PM2 processes first
    SPAWN_USER_EXISTING=$(stat -c '%U' "$SCWS_ROOT" 2>/dev/null || echo "spawn")
    sudo -u "$SPAWN_USER_EXISTING" pm2 delete all 2>/dev/null || true
    rm -rf "$SCWS_ROOT"
  else
    warn "SPAWN appears to be already installed at $SCWS_ROOT"
    printf "\n"
    printf "  To update:    ${CYAN}bash $SCWS_ROOT/scripts/auto-update.sh --force${NC}\n"
    printf "  To reinstall: ${CYAN}curl -fsSL <url> | bash -s -- --force${NC}\n"
    printf "  To nuke it:   ${CYAN}rm -rf $SCWS_ROOT && rerun this script${NC}\n"
    printf "\n"
    exit 1
  fi
fi

# Must have git (install if missing)
if ! command -v git &>/dev/null; then
  log "Installing git..."
  apt-get update -qq && apt-get install -y -qq git
fi

log "  Preflight checks passed"

# ── 2. Generate secrets ────────────────────────────────────────────────────

step "Generating secrets..."

SPAWN_DB_PASSWORD=$(openssl rand -hex 24)
DASHBOARD_TOKEN=$(openssl rand -hex 24)

log "Secrets generated (will be saved to .env)"

# ── 3. Clone the repository ────────────────────────────────────────────────

step "Cloning SPAWN repository..."

if [[ -d "$SCWS_ROOT" ]]; then
  warn "$SCWS_ROOT already exists but is incomplete — removing and re-cloning"
  rm -rf "$SCWS_ROOT"
fi

git clone --branch "$BRANCH" "$REPO_URL" "$SCWS_ROOT"

log "Repository cloned to $SCWS_ROOT"

# Create AGENTS.md symlink for OpenCode compatibility
# (OpenCode reads AGENTS.md the way Claude Code reads CLAUDE.md)
ln -sf CLAUDE.md "$SCWS_ROOT/AGENTS.md" 2>/dev/null || true

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

step "Running system bootstrap (this takes a few minutes)..."

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

step "Installing daemon dependencies..."

cd "$SCWS_ROOT/daemon"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3

log "Daemon dependencies installed"

# ── 7. Generate .env ────────────────────────────────────────────────────────

step "Generating daemon .env..."

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

step "Generating PM2 ecosystem config..."

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

step "Creating database schema..."

SCHEMA_FILE="$SCWS_ROOT/scripts/schema.sql"

if [[ -f "$SCHEMA_FILE" ]]; then
  sudo -u postgres psql -d scws_daemon -f "$SCHEMA_FILE" 2>&1 | tail -5
  log "Schema applied from $SCHEMA_FILE"
else
  err "Schema file not found at $SCHEMA_FILE"
  exit 1
fi

# ── 10. Fix ownership ──────────────────────────────────────────────────────

step "Setting file ownership..."

chown -R "${SPAWN_USER}:${SPAWN_USER}" "$SCWS_ROOT"

# ── 11. Start daemon ───────────────────────────────────────────────────────

step "Starting SPAWN daemon..."

cd "$SCWS_ROOT/daemon"
sudo -u "$SPAWN_USER" pm2 start ecosystem.config.cjs
sudo -u "$SPAWN_USER" pm2 save

log "Daemon started via PM2"

# ── 12. Install & start spawn-mcp ─────────────────────────────────────

step "Installing spawn-mcp (AI agent bridge)..."

MCP_DIR="$SCWS_ROOT/projects/spawn-mcp"

if [[ -d "$MCP_DIR" && -f "$MCP_DIR/package.json" ]]; then
  # Install dependencies
  cd "$MCP_DIR"
  sudo -u "$SPAWN_USER" npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3

  # Generate .env for spawn-mcp
  cat > "$MCP_DIR/.env" <<MCPENVEOF
DATABASE_URL=postgresql://scws:${SPAWN_DB_PASSWORD}@localhost:5432/scws_daemon
PORT=5020
DAEMON_URL=http://localhost:4000
DASHBOARD_TOKEN=${DASHBOARD_TOKEN}
AUTH_TOKEN=${DASHBOARD_TOKEN}
MCPENVEOF
  chmod 600 "$MCP_DIR/.env"
  chown "${SPAWN_USER}:${SPAWN_USER}" "$MCP_DIR/.env"

  # Start spawn-mcp via PM2 (if dist/index.cjs exists — it's pre-built in the repo)
  if [[ -f "$MCP_DIR/dist/index.cjs" ]]; then
    sudo -u "$SPAWN_USER" pm2 start "$MCP_DIR/dist/index.cjs" \
      --name spawn-mcp \
      --cwd "$MCP_DIR" \
      --node-args="--env-file=.env --max-old-space-size=128" \
      --max-memory-restart 150M
    sudo -u "$SPAWN_USER" pm2 save
    log "spawn-mcp started on port 5020"
  else
    warn "spawn-mcp dist/index.cjs not found — skipping PM2 start"
  fi

  # Write nginx config for spawn-mcp
  cat > "$SCWS_ROOT/nginx/projects/spawn-mcp.conf" <<'MCPNGINXEOF'
location /spawn-mcp/ {
    proxy_pass http://127.0.0.1:5020/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
    proxy_intercept_errors on;
    error_page 502 503 504 = @project_down;
}
MCPNGINXEOF
  nginx -t 2>/dev/null && nginx -s reload 2>/dev/null || true

  log "spawn-mcp installed and configured"
else
  warn "spawn-mcp project not found at $MCP_DIR — skipping"
fi

# ── 13. Configure AI agent settings ───────────────────────────────────

step "Configuring AI agent settings (Claude Code + OpenCode)..."

SPAWN_USER_HOME=$(eval echo "~${SPAWN_USER}")

# Build the MCP server JSON config
MCP_CONFIG=$(cat <<MCPCFG
{
  "type": "streamableHttp",
  "url": "http://localhost:5020/mcp",
  "headers": {
    "Authorization": "Bearer ${DASHBOARD_TOKEN}"
  }
}
MCPCFG
)

# ── Claude Code: ~/.claude/settings.json ──
CLAUDE_DIR="${SPAWN_USER_HOME}/.claude"
CLAUDE_SETTINGS="${CLAUDE_DIR}/settings.json"

mkdir -p "$CLAUDE_DIR"

if [[ -f "$CLAUDE_SETTINGS" ]] && command -v jq &>/dev/null; then
  # Merge into existing settings
  tmp_file=$(mktemp)
  jq --argjson spawn "$MCP_CONFIG" '
    .mcpServers.spawn = $spawn |
    if .permissions == null then
      .permissions = {
        "allow": [
          "Bash(pm2 *)",
          "Bash(curl *)",
          "Bash(git *)",
          "Bash(npm *)",
          "Bash(sudo nginx *)",
          "Bash(sudo -u postgres *)"
        ]
      }
    else . end
  ' "$CLAUDE_SETTINGS" > "$tmp_file" 2>/dev/null

  if [[ $? -eq 0 && -s "$tmp_file" ]]; then
    mv "$tmp_file" "$CLAUDE_SETTINGS"
    log "Merged spawn MCP into existing Claude settings"
  else
    rm -f "$tmp_file"
    # Fall through to fresh write
    CLAUDE_SETTINGS_NEEDS_FRESH=true
  fi
else
  CLAUDE_SETTINGS_NEEDS_FRESH=true
fi

if [[ "${CLAUDE_SETTINGS_NEEDS_FRESH:-false}" == "true" || ! -f "$CLAUDE_SETTINGS" ]]; then
  cat > "$CLAUDE_SETTINGS" <<SETTINGSJSON
{
  "mcpServers": {
    "spawn": ${MCP_CONFIG}
  },
  "permissions": {
    "allow": [
      "Bash(pm2 *)",
      "Bash(curl *)",
      "Bash(git *)",
      "Bash(npm *)",
      "Bash(sudo nginx *)",
      "Bash(sudo -u postgres *)"
    ]
  }
}
SETTINGSJSON
  log "Created Claude settings with spawn MCP server"
fi

chown -R "${SPAWN_USER}:${SPAWN_USER}" "$CLAUDE_DIR"

# Note: OpenCode reads ~/.claude/settings.json natively — no separate config needed.
# An opencode.json in the project root uses a different schema (agent, mode, plugin)
# and must NOT contain mcpServers (causes "Unrecognized key" error on startup).

# ── Fix OpenCode PATH if installed ──
# OpenCode installs to ~/.opencode/bin which isn't in PATH by default
OPENCODE_BIN="${SPAWN_USER_HOME}/.opencode/bin/opencode"
if [[ -x "$OPENCODE_BIN" ]]; then
  ln -sf "$OPENCODE_BIN" /usr/local/bin/opencode 2>/dev/null || true
  # Add to user's .bashrc if not already there
  BASHRC="${SPAWN_USER_HOME}/.bashrc"
  if ! grep -q '.opencode/bin' "$BASHRC" 2>/dev/null; then
    printf '\nexport PATH="$HOME/.opencode/bin:$PATH"\n' >> "$BASHRC"
    chown "${SPAWN_USER}:${SPAWN_USER}" "$BASHRC"
  fi
  log "OpenCode PATH configured (/usr/local/bin/opencode)"
fi

log "AI agent settings configured — no manual onboarding needed"

# ── 14. Register spawn-mcp project card ───────────────────────────────────

# Wait for daemon to be ready before registering
sleep 2
for i in 1 2 3; do
  curl -sf http://localhost:4000/health >/dev/null 2>&1 && break
  sleep 2
done

# Register spawn-mcp as a project card in the daemon (if not already there)
MCP_EXISTS=$(curl -sf -H "Authorization: Bearer ${DASHBOARD_TOKEN}" \
  http://localhost:4000/api/projects/spawn-mcp 2>/dev/null | grep -c '"name"' || true)

if [[ "$MCP_EXISTS" -eq 0 ]]; then
  curl -sf -X POST http://localhost:4000/api/projects \
    -H "Authorization: Bearer ${DASHBOARD_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "spawn-mcp",
      "displayName": "SPAWN MCP",
      "framework": "express",
      "description": "Local MCP server — gives AI agents native tool access to SPAWN"
    }' >/dev/null 2>&1 || true

  # Patch to set running status and port
  curl -sf -X PATCH http://localhost:4000/api/projects/spawn-mcp \
    -H "Authorization: Bearer ${DASHBOARD_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"status": "running", "port": 5020}' >/dev/null 2>&1 || true

  log "spawn-mcp project card registered in dashboard"
fi

# ── 15. Install auto-update cron ──────────────────────────────────────────

step "Installing auto-update cron..."

chmod +x "$SCWS_ROOT/scripts/"*.sh 2>/dev/null || true

AUTO_UPDATE_CRON="0 * * * * bash $SCWS_ROOT/scripts/auto-update.sh >> $SCWS_ROOT/logs/auto-update.log 2>&1"
EXISTING_CRON=$(sudo -u "$SPAWN_USER" crontab -l 2>/dev/null | grep -v 'auto-update.sh' || true)
printf '%s\n%s\n' "$EXISTING_CRON" "$AUTO_UPDATE_CRON" | sudo -u "$SPAWN_USER" crontab -

log "Auto-update cron installed (every 5 minutes)"

# ── 16. Stamp version ──────────────────────────────────────────────────────

step "Stamping version..."
if [[ -f "$SCWS_ROOT/scripts/stamp-version.sh" ]]; then
  bash "$SCWS_ROOT/scripts/stamp-version.sh" --deploy-method=install 2>/dev/null || true
fi

# ── 17. Health check ───────────────────────────────────────────────────────

step "Running health check..."

sleep 3

HEALTH_OK=false
for i in 1 2 3 4 5; do
  if curl -sf http://localhost:4000/health >/dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi
  sleep 2
done

# ── 18. Print summary ──────────────────────────────────────────────────────

INSTALL_END=$(date +%s)
ELAPSED=$(( INSTALL_END - INSTALL_START ))
ELAPSED_MIN=$(( ELAPSED / 60 ))
ELAPSED_SEC=$(( ELAPSED % 60 ))

printf "\n"
if $HEALTH_OK; then
  printf "${GREEN}${BOLD}"
  printf '   .----------------------------------------------------.\n'
  printf '   |                                                    |\n'
  printf '   |           .-------.                                |\n'
  printf '   |           | O   O |    SPAWN IS ALIVE!             |\n'
  printf '   |           |  ---  |    Installed in %dm %02ds         |\n' "$ELAPSED_MIN" "$ELAPSED_SEC"
  printf '   |           '"'"'---+---'"'"'                                |\n'
  printf '   |            .--+---.    Your autonomous server      |\n'
  printf '   |            | === |     is ready to build.          |\n'
  printf '   |            '"'"'--+--'"'"'                                 |\n'
  printf '   |              / \\                                   |\n'
  printf '   |                                                    |\n'
  printf '   '"'"'----------------------------------------------------'"'"'\n'
  printf "${NC}\n"
else
  printf "${YELLOW}${BOLD}"
  printf '   .----------------------------------------------------.\n'
  printf '   |                                                    |\n'
  printf '   |           .-------.                                |\n'
  printf '   |           | O   O |    SPAWN INSTALLED             |\n'
  printf '   |           |  ~~~  |    Health check failed         |\n'
  printf '   |           '"'"'---+---'"'"'    Completed in %dm %02ds        |\n' "$ELAPSED_MIN" "$ELAPSED_SEC"
  printf '   |            .--+---.                                |\n'
  printf '   |            | === |     Check the logs below.       |\n'
  printf '   |            '"'"'--+--'"'"'                                 |\n'
  printf '   |              / \\                                   |\n'
  printf '   |                                                    |\n'
  printf '   '"'"'----------------------------------------------------'"'"'\n'
  printf "${NC}\n"
  printf "  Check logs: ${CYAN}sudo -u $SPAWN_USER pm2 logs scws-daemon --lines 30${NC}\n\n"
fi

printf "  ${BOLD}Dashboard:${NC}       ${CYAN}${BASE_URL}${NC}\n"
printf "  ${BOLD}System User:${NC}     ${CYAN}${SPAWN_USER}${NC}\n"
printf "  ${BOLD}Install Path:${NC}    ${CYAN}${SCWS_ROOT}${NC}\n"
printf "  ${BOLD}.env:${NC}            ${CYAN}${SCWS_ROOT}/daemon/.env${NC}\n"
printf "\n"

# ── Show the dashboard token prominently ──────────────────────────────────
printf "${YELLOW}${BOLD}"
printf "  ┌────────────────────────────────────────────────────┐\n"
printf "  │  YOUR DASHBOARD TOKEN (copy this now!):            │\n"
printf "  │                                                    │\n"
printf "  │  ${CYAN}%-50s${YELLOW}│\n" "$DASHBOARD_TOKEN"
printf "  │                                                    │\n"
printf "  │  Paste it into the login page at:                  │\n"
printf "  │  ${CYAN}%-50s${YELLOW}│\n" "$BASE_URL"
printf "  └────────────────────────────────────────────────────┘\n"
printf "${NC}\n"
printf "  ${DIM}Lost it? Run this anytime to get it back:${NC}\n"
printf "  ${CYAN}grep DASHBOARD_TOKEN $SCWS_ROOT/daemon/.env | cut -d= -f2${NC}\n"
printf "\n"

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

printf "  ${BOLD}Next steps:${NC}\n"
printf "    1. Open the dashboard: ${CYAN}${BASE_URL}${NC}\n"
printf "    2. Install an AI coding agent (if not already installed):\n"
printf "       ${CYAN}Claude Code:${NC} https://docs.anthropic.com/claude-code\n"
printf "       ${CYAN}OpenCode:${NC}    curl -fsSL https://opencode.ai/install | bash\n"
printf "    3. Launch the agent from ${CYAN}${SCWS_ROOT}${NC} and start building!\n"
printf "       The spawn MCP server is pre-configured — no setup needed.\n"
if $IS_PI; then
  printf "    ${DIM}Optional: Run full onboarding (GitHub auth, etc):${NC}\n"
  printf "       ${CYAN}sudo -u $SPAWN_USER bash $SCWS_ROOT/projects/spawn-pi/onboard.sh${NC}\n"
else
  printf "    ${DIM}Optional: Run full onboarding (GitHub auth, etc):${NC}\n"
  printf "       ${CYAN}sudo -u $SPAWN_USER bash $SCWS_ROOT/projects/spawn-vps/onboard.sh${NC}\n"
fi
printf "\n"
printf "  ${BOLD}Useful commands:${NC}\n"
printf "    ${CYAN}sudo -u $SPAWN_USER pm2 status${NC}           # Process status\n"
printf "    ${CYAN}sudo -u $SPAWN_USER pm2 logs scws-daemon${NC} # Daemon logs\n"
printf "    ${CYAN}cat $SCWS_ROOT/daemon/.env${NC}         # View credentials\n"
printf "\n"
printf "${DIM}  ─────────────────────────────────────────────────────${NC}\n"
printf "  ${DIM}Powered by SPAWN — ideas in, running software out.${NC}\n"
printf "\n"
