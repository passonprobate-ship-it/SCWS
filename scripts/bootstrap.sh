#!/usr/bin/env bash
# =============================================================================
# SPAWN Bootstrap — Self-Programming Autonomous Web Node
# =============================================================================
# Regenerated: 2026-03-01 from live system audit
#
# Sets up a fresh Ubuntu Server 24.04 (arm64) on a Raspberry Pi 5 to match the
# production SPAWN system. Run as root or with sudo on a fresh install.
#
# Prerequisites:
#   - Ubuntu Server 24.04 LTS (arm64) freshly imaged
#   - User 'codeman' created during install (uid 1000)
#   - Internet connectivity
#   - SSH access
#
# Usage:
#   curl -fsSL <url>/bootstrap.sh | sudo bash
#   # — or —
#   sudo bash bootstrap.sh
#
# After running:
#   1. Set up Tailscale:  sudo tailscale up --hostname=SPAWN
#   2. Authenticate gh:   gh auth login
#   3. Install Claude CLI: see https://docs.anthropic.com/claude-code
#   4. Clone/deploy daemon code into /var/www/scws/daemon/
#   5. Create /var/www/scws/daemon/.env with required keys
#   6. Build daemon & start PM2
#   7. Restore DB backups if migrating
# =============================================================================
set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[SPAWN]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── Preflight ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (or via sudo)."
  exit 1
fi

SPAWN_USER="codeman"
if ! id "$SPAWN_USER" &>/dev/null; then
  err "User '$SPAWN_USER' does not exist. Create it first."
  exit 1
fi

ARCH=$(dpkg --print-architecture)
if [[ "$ARCH" != "arm64" ]]; then
  warn "Expected arm64 architecture, got $ARCH. Proceeding anyway."
fi

log "Starting SPAWN bootstrap on $(hostname) — $(date)"

# ── 1. Hostname ──────────────────────────────────────────────────────────────
log "Setting hostname to SPAWN..."
hostnamectl set-hostname SPAWN

# ── 2. Sudoers — passwordless sudo for codeman ──────────────────────────────
log "Configuring sudoers..."
echo "$SPAWN_USER ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/codeman
chmod 440 /etc/sudoers.d/codeman

# ── 3. User groups — GPIO, I2C, SPI, Docker, etc. ───────────────────────────
log "Setting up hardware groups..."
for grp in gpio spi i2c; do
  groupadd -f "$grp"
done
usermod -aG sudo,adm,dialout,cdrom,audio,video,plugdev,games,users,input,render,netdev,gpio,spi,i2c "$SPAWN_USER"

# ── 4. APT repositories ─────────────────────────────────────────────────────
log "Adding APT repositories..."

# NodeSource (Node.js 20.x)
mkdir -p /usr/share/keyrings
if [[ ! -f /usr/share/keyrings/nodesource.gpg ]]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
fi
cat > /etc/apt/sources.list.d/nodesource.sources <<'APTEOF'
Types: deb
URIs: https://deb.nodesource.com/node_20.x
Suites: nodistro
Components: main
Architectures: arm64
Signed-By: /usr/share/keyrings/nodesource.gpg
APTEOF

# GitHub CLI
if [[ ! -f /usr/share/keyrings/githubcli-archive-keyring.gpg ]]; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg
fi
echo "deb [arch=arm64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list

# Detect Ubuntu codename for APT repos
UBUNTU_CODENAME=$(lsb_release -cs 2>/dev/null || echo "noble")

# Tailscale
if [[ ! -f /usr/share/keyrings/tailscale-archive-keyring.gpg ]]; then
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${UBUNTU_CODENAME}.noarmor.gpg" \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg
fi
echo "deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu ${UBUNTU_CODENAME} main" \
  > /etc/apt/sources.list.d/tailscale.list

# Docker
mkdir -p /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi
echo "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

# ── 5. System packages ──────────────────────────────────────────────────────
log "Updating and installing system packages..."
apt-get update -qq

apt-get install -y -qq \
  nodejs \
  postgresql postgresql-contrib \
  redis-server \
  nginx \
  tailscale \
  gh \
  git \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
  build-essential \
  python3 python3-pip python3-venv \
  golang-go \
  cmake \
  imagemagick \
  ffmpeg \
  jq yq \
  ripgrep \
  i2c-tools \
  libgpiod-dev gpiod \
  libcap2-bin \
  fail2ban \
  ufw \
  sqlite3 \
  curl wget \
  unzip \
  htop \
  tree

# ── 6. Chromium via snap ────────────────────────────────────────────────────
log "Installing Chromium browser via snap..."
if ! snap list chromium &>/dev/null; then
  snap install chromium
fi

# ── 7. Node.js global packages ──────────────────────────────────────────────
log "Installing global npm packages..."
npm install -g \
  pm2@latest \
  typescript \
  tsx \
  esbuild \
  puppeteer-core

# ── 8. PM2 log rotation ─────────────────────────────────────────────────────
log "Installing and configuring pm2-logrotate..."
sudo -u "$SPAWN_USER" pm2 install pm2-logrotate
sudo -u "$SPAWN_USER" pm2 set pm2-logrotate:max_size 10M
sudo -u "$SPAWN_USER" pm2 set pm2-logrotate:retain 5
sudo -u "$SPAWN_USER" pm2 set pm2-logrotate:compress true
sudo -u "$SPAWN_USER" pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
sudo -u "$SPAWN_USER" pm2 set pm2-logrotate:rotateInterval "0 0 * * *"
sudo -u "$SPAWN_USER" pm2 set pm2-logrotate:rotateModule true

# ── 9. PM2 startup hook ─────────────────────────────────────────────────────
log "Configuring PM2 startup..."
env PATH=$PATH:/usr/bin pm2 startup systemd -u "$SPAWN_USER" --hp "/home/$SPAWN_USER" --no-daemon
systemctl enable pm2-codeman

# ── 10. Bun ──────────────────────────────────────────────────────────────────
log "Installing Bun..."
sudo -u "$SPAWN_USER" bash -c 'curl -fsSL https://bun.sh/install | bash'

# ── 11. Docker group ────────────────────────────────────────────────────────
log "Adding $SPAWN_USER to docker group..."
usermod -aG docker "$SPAWN_USER"

# ── 12. PostgreSQL setup ────────────────────────────────────────────────────
log "Configuring PostgreSQL..."
systemctl enable --now postgresql

# Create the scws role (prompt for password)
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='scws'" | grep -q 1; then
  log "Creating PostgreSQL role 'scws'..."
  echo "Enter password for PostgreSQL role 'scws':"
  read -rs SCWS_DB_PASSWORD
  # Escape single quotes to prevent SQL injection
  SCWS_DB_PASSWORD_ESCAPED="${SCWS_DB_PASSWORD//\'/\'\'}"
  sudo -u postgres psql -c "CREATE ROLE scws WITH LOGIN PASSWORD '${SCWS_DB_PASSWORD_ESCAPED}';"
else
  log "PostgreSQL role 'scws' already exists."
fi

# Create databases
for db in scws_daemon spawn_cortex solbot_db; do
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
    sudo -u postgres psql -c "CREATE DATABASE $db OWNER scws;"
    log "Created database: $db"
  else
    log "Database $db already exists."
  fi
done

# ── 13. Directory structure ──────────────────────────────────────────────────
log "Creating SPAWN directory structure..."
mkdir -p /var/www/scws/{daemon,projects,nginx/projects,scripts,logs,backups}
chown -R "$SPAWN_USER:$SPAWN_USER" /var/www/scws

# ── 14. Swap (4GB) ──────────────────────────────────────────────────────────
log "Configuring 4GB swap..."
if [[ ! -f /swapfile ]]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  log "4GB swapfile created and activated."
else
  log "Swapfile already exists."
fi

# ── 15. Kernel tuning ───────────────────────────────────────────────────────
log "Applying kernel tuning..."
cat > /etc/sysctl.d/99-spawn-memory.conf <<'SYSEOF'
vm.swappiness=5
vm.vfs_cache_pressure=50
SYSEOF
sysctl --system >/dev/null 2>&1

# ── 16. GPIO / I2C / SPI / PWM hardware config ──────────────────────────────
log "Configuring Pi 5 hardware interfaces..."

# udev rule for GPIO group access
cat > /etc/udev/rules.d/99-gpio.rules <<'UDEVEOF'
SUBSYSTEM=="gpio", KERNEL=="gpiochip*", GROUP="gpio", MODE="0660"
UDEVEOF
udevadm control --reload-rules
udevadm trigger

# Boot firmware — enable I2C, SPI, UART, PWM
BOOT_CONFIG="/boot/firmware/config.txt"
if [[ -f "$BOOT_CONFIG" ]]; then
  # Ensure I2C is enabled
  if ! grep -q '^dtparam=i2c_arm=on' "$BOOT_CONFIG"; then
    sed -i '/^\[all\]/a dtparam=i2c_arm=on' "$BOOT_CONFIG"
  fi
  # Ensure SPI is enabled
  if ! grep -q '^dtparam=spi=on' "$BOOT_CONFIG"; then
    sed -i '/^\[all\]/a dtparam=spi=on' "$BOOT_CONFIG"
  fi
  # Ensure UART is enabled
  if ! grep -q '^enable_uart=1' "$BOOT_CONFIG"; then
    sed -i '/^\[all\]/a enable_uart=1' "$BOOT_CONFIG"
  fi
  # Ensure PWM overlay (2-channel on GPIO 12/13)
  if ! grep -q 'dtoverlay=pwm-2chan' "$BOOT_CONFIG"; then
    echo 'dtoverlay=pwm-2chan,pin=12,func=4,pin2=13,func2=4' >> "$BOOT_CONFIG"
  fi
  log "Boot config updated. Reboot required for hardware changes."
else
  warn "Boot config not found at $BOOT_CONFIG — skipping hardware overlay setup."
fi

# ── 17. Nginx configuration ─────────────────────────────────────────────────
log "Configuring nginx..."

# Remove default site
rm -f /etc/nginx/sites-enabled/default

# Main SPAWN server block
cat > /etc/nginx/sites-available/scws <<'NGINXEOF'
server {
    listen 80;
    server_name 100.89.2.95 spawn.tail852587.ts.net 192.168.1.125 _;

    client_max_body_size 150m;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    include /var/www/scws/nginx/projects/*.conf;
}
NGINXEOF

ln -sf /etc/nginx/sites-available/scws /etc/nginx/sites-enabled/scws
nginx -t && systemctl reload nginx
systemctl enable nginx

# ── 18. UFW firewall ─────────────────────────────────────────────────────────
log "Configuring firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp              # SSH
ufw allow 80/tcp              # HTTP (nginx)
ufw allow in on tailscale0    # All Tailscale traffic
ufw --force enable
systemctl enable ufw

# ── 19. Fail2ban ─────────────────────────────────────────────────────────────
log "Configuring fail2ban..."
cat > /etc/fail2ban/jail.local <<'F2BEOF'
[DEFAULT]
bantime = 1800
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = ssh
logpath = %(sshd_log)s
F2BEOF
systemctl enable fail2ban
systemctl restart fail2ban || warn "fail2ban failed to start — check logs."

# ── 20. Backup script + cron ────────────────────────────────────────────────
log "Installing backup scripts and cron jobs..."

# --- Local backup script (12 backup types) ---
cat > /var/www/scws/scripts/backup-db.sh <<'BACKUPEOF'
#!/bin/bash
# SPAWN backup script
# Runs nightly via cron, retains 7 days of backups
# Covers: all PostgreSQL databases + project source code + nginx configs + daemon config
# + daemon full + SPAWN core + system nginx + Claude memory + crontab + PM2 state

export PATH="/usr/bin:/usr/local/bin:$PATH"
export HOME="/home/codeman"

BACKUP_DIR="/var/www/scws/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=7

mkdir -p "${BACKUP_DIR}"

# --- PostgreSQL Databases ---
pg_dump -U scws -h localhost scws_daemon | gzip > "${BACKUP_DIR}/scws_daemon_${TIMESTAMP}.sql.gz"
if [ $? -eq 0 ]; then
    echo "[$(date)] Backup successful: scws_daemon_${TIMESTAMP}.sql.gz"
else
    echo "[$(date)] ERROR: Backup failed for scws_daemon" >&2
fi

for db in $(psql -U scws -h localhost -d postgres -t -A -c "SELECT datname FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = 'scws') AND datname NOT IN ('scws_daemon', 'postgres', 'template0', 'template1');"); do
    pg_dump -U scws -h localhost "$db" | gzip > "${BACKUP_DIR}/${db}_${TIMESTAMP}.sql.gz"
    if [ $? -eq 0 ]; then
        echo "[$(date)] Backup successful: ${db}_${TIMESTAMP}.sql.gz"
    else
        echo "[$(date)] WARNING: Backup failed for ${db}" >&2
    fi
done

# --- Project Source Code ---
tar czf "${BACKUP_DIR}/projects_${TIMESTAMP}.tar.gz" \
    --exclude='node_modules' --exclude='dist' --exclude='.git' --exclude='*.log' \
    -C /var/www/scws projects/ 2>/dev/null
echo "[$(date)] Backup: projects_${TIMESTAMP}.tar.gz ($?)"

# --- Nginx Configs ---
tar czf "${BACKUP_DIR}/nginx_configs_${TIMESTAMP}.tar.gz" \
    -C /var/www/scws nginx/ 2>/dev/null
echo "[$(date)] Backup: nginx_configs_${TIMESTAMP}.tar.gz ($?)"

# --- Daemon Config (.env + ecosystem) ---
tar czf "${BACKUP_DIR}/daemon_config_${TIMESTAMP}.tar.gz" \
    --exclude='node_modules' --exclude='dist' \
    -C /var/www/scws daemon/.env daemon/ecosystem.config.cjs 2>/dev/null
echo "[$(date)] Backup: daemon_config_${TIMESTAMP}.tar.gz ($?)"

# --- Daemon Full (web interface + API, includes dist/) ---
tar czf "${BACKUP_DIR}/daemon_full_${TIMESTAMP}.tar.gz" \
    --exclude='node_modules' --exclude='*.bak' \
    -C /var/www/scws daemon/ 2>/dev/null
echo "[$(date)] Backup: daemon_full_${TIMESTAMP}.tar.gz ($?)"

# --- SPAWN Core (CLAUDE.md + scripts) ---
tar czf "${BACKUP_DIR}/spawn_core_${TIMESTAMP}.tar.gz" \
    -C /var/www/scws CLAUDE.md scripts/ 2>/dev/null
echo "[$(date)] Backup: spawn_core_${TIMESTAMP}.tar.gz ($?)"

# --- System nginx (main site config) ---
sudo tar czf "${BACKUP_DIR}/nginx_system_${TIMESTAMP}.tar.gz" \
    -C /etc nginx/sites-enabled/ nginx/nginx.conf 2>/dev/null
echo "[$(date)] Backup: nginx_system_${TIMESTAMP}.tar.gz ($?)"

# --- Claude Memory ---
tar czf "${BACKUP_DIR}/claude_memory_${TIMESTAMP}.tar.gz" \
    -C /home/codeman .claude/projects/-var-www-scws/memory/ 2>/dev/null
echo "[$(date)] Backup: claude_memory_${TIMESTAMP}.tar.gz ($?)"

# --- Crontab ---
crontab -l > "${BACKUP_DIR}/crontab_${TIMESTAMP}.txt" 2>/dev/null
echo "[$(date)] Backup: crontab_${TIMESTAMP}.txt"

# --- PM2 Process List ---
pm2 jlist > "${BACKUP_DIR}/pm2_processes_${TIMESTAMP}.json" 2>/dev/null
echo "[$(date)] Backup: pm2_processes_${TIMESTAMP}.json"

# --- Prune ---
find "${BACKUP_DIR}" \( -name "*.sql.gz" -o -name "*.tar.gz" -o -name "*.json" -o -name "*.txt" \) -mtime +${RETENTION_DAYS} -delete
echo "[$(date)] Pruned backups older than ${RETENTION_DAYS} days"
BACKUPEOF
chmod +x /var/www/scws/scripts/backup-db.sh

# --- Off-site backup script ---
# Note: backup-offsite.sh should be copied from the repo or restored from backup.
# It pushes local backups to MCP server at passoncloud.duckdns.org.
# The token must be configured manually after bootstrap.
touch /var/www/scws/scripts/backup-offsite.sh
chmod +x /var/www/scws/scripts/backup-offsite.sh

# Install cron jobs for codeman
CRON_LOCAL="0 2 * * * /var/www/scws/scripts/backup-db.sh >> /var/www/scws/logs/backup.log 2>&1"
CRON_OFFSITE="15 2 * * * /var/www/scws/scripts/backup-offsite.sh >> /var/www/scws/logs/backup-offsite.log 2>&1"
CRON_UPDATE="*/5 * * * * /var/www/scws/scripts/auto-update.sh >> /var/www/scws/logs/auto-update.log 2>&1"
(sudo -u "$SPAWN_USER" crontab -l 2>/dev/null | grep -v 'backup-db.sh' | grep -v 'backup-offsite.sh' | grep -v 'auto-update.sh'; echo "$CRON_LOCAL"; echo "$CRON_OFFSITE"; echo "$CRON_UPDATE") \
  | sudo -u "$SPAWN_USER" crontab -

# ── 21. Python GPIO library ─────────────────────────────────────────────────
log "Installing Python GPIO libraries..."
pip3 install gpiod rpi-lgpio --break-system-packages 2>/dev/null || \
pip3 install gpiod rpi-lgpio

# ── 22. pinctrl (built from source) ─────────────────────────────────────────
log "Building pinctrl from source..."
if [[ ! -f /usr/local/bin/pinctrl ]]; then
  TMPDIR=$(mktemp -d)
  git clone --depth=1 https://github.com/raspberrypi/utils.git "$TMPDIR/rpi-utils"
  cd "$TMPDIR/rpi-utils"
  cmake -B build -DCMAKE_INSTALL_PREFIX=/usr/local
  cmake --build build --target pinctrl
  cp build/pinctrl/pinctrl /usr/local/bin/pinctrl
  chmod +x /usr/local/bin/pinctrl
  cd /
  rm -rf "$TMPDIR"
  log "pinctrl installed to /usr/local/bin/pinctrl"
else
  log "pinctrl already installed."
fi

# ── 23. Shell profile — Bun + Claude CLI paths ──────────────────────────────
log "Configuring shell profile..."
PROFILE="/home/$SPAWN_USER/.profile"
BASHRC="/home/$SPAWN_USER/.bashrc"

# .profile — ensure ~/.local/bin and bun are in PATH
if ! grep -q 'BUN_INSTALL' "$PROFILE" 2>/dev/null; then
  cat >> "$PROFILE" <<'PROFILEEOF'

# Bun
export PATH="/home/codeman/.bun/bin:$PATH"
PROFILEEOF
fi

if ! grep -q '.local/bin' "$PROFILE" 2>/dev/null; then
  # Already in default Ubuntu .profile template usually, but ensure
  :
fi

# .bashrc — Bun export
if ! grep -q 'BUN_INSTALL' "$BASHRC" 2>/dev/null; then
  cat >> "$BASHRC" <<'BASHRCEOF'

# Bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
BASHRCEOF
fi

chown "$SPAWN_USER:$SPAWN_USER" "$PROFILE" "$BASHRC"

# ── 24. File ownership sweep ────────────────────────────────────────────────
log "Final ownership sweep..."
chown -R "$SPAWN_USER:$SPAWN_USER" /var/www/scws

# ── 25. Ecosystem config ────────────────────────────────────────────────────
log "Writing PM2 ecosystem config..."
cat > /var/www/scws/daemon/ecosystem.config.cjs <<'ECOEOF'
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
    node_args: '--dns-result-order=ipv4first --max-old-space-size=192',
    max_memory_restart: '200M',
    env
  }]
};
ECOEOF
chown "$SPAWN_USER:$SPAWN_USER" /var/www/scws/daemon/ecosystem.config.cjs

# ── 26. OOM killer prioritization ─────────────────────────────────────────
log "Configuring OOM killer priorities..."

# PM2 god daemon protection
mkdir -p /etc/systemd/system/pm2-codeman.service.d
cat > /etc/systemd/system/pm2-codeman.service.d/oom.conf <<'OOMEOF'
[Service]
OOMScoreAdjust=-800
OOMEOF
systemctl daemon-reload

# Per-process OOM score script (called by daemon on startup + project start/stop)
cat > /var/www/scws/scripts/set-oom-scores.sh <<'OOMSCRIPT'
#!/bin/bash
set -euo pipefail
log() { echo "[OOM] $*"; }
set_oom() {
  local name="$1" score="$2"
  local pid
  pid=$(pm2 pid "$name" 2>/dev/null || true)
  if [[ -n "$pid" && "$pid" != "0" && -d "/proc/$pid" ]]; then
    printf '%d' "$score" | sudo tee "/proc/$pid/oom_score_adj" > /dev/null 2>&1 && \
      log "$name (pid $pid) → oom_score_adj=$score" || \
      log "$name (pid $pid) → failed to set (may need root)"
  fi
}
set_oom "scws-daemon" -500
set_oom "spawn-mcp" -300
for proj in $(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for p in data:
        name = p.get('name', '')
        status = p.get('pm2_env', {}).get('status', '')
        if name not in ('scws-daemon', 'spawn-mcp', 'pm2-logrotate') and status == 'online':
            print(name)
except: pass
" 2>/dev/null); do
  set_oom "$proj" 300
done
log "OOM scores applied."
OOMSCRIPT
chmod +x /var/www/scws/scripts/set-oom-scores.sh
chown "$SPAWN_USER:$SPAWN_USER" /var/www/scws/scripts/set-oom-scores.sh

# ── 27. Disable Docker at boot (start on demand) ──────────────────────────
log "Disabling Docker at boot (saves ~128MB idle RAM)..."
systemctl disable docker.service docker.socket containerd.service 2>/dev/null || true
systemctl stop docker.service containerd.service 2>/dev/null || true

# ── 28. Reduce PostgreSQL max_connections ──────────────────────────────────
log "Tuning PostgreSQL max_connections..."
PG_CONF="/etc/postgresql/16/main/postgresql.conf"
if [[ -f "$PG_CONF" ]]; then
  sed -i 's/^max_connections = 100/max_connections = 30/' "$PG_CONF"
  systemctl restart postgresql
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
log "============================================"
log "  SPAWN bootstrap complete!"
log "============================================"
echo ""
log "Installed:"
log "  Node.js $(node --version), npm $(npm --version)"
log "  PostgreSQL $(psql --version | awk '{print $3}')"
log "  Redis $(redis-server --version | awk '{print $3}' | tr -d 'v=')"
log "  nginx $(nginx -v 2>&1 | awk -F/ '{print $2}')"
log "  Docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')"
log "  PM2 $(pm2 --version 2>/dev/null)"
log "  Tailscale $(tailscale version 2>/dev/null | head -1)"
echo ""
log "Next steps:"
log "  1. sudo tailscale up --hostname=SPAWN"
log "  2. gh auth login"
log "  3. Install Claude CLI:  npm install -g @anthropic-ai/claude-code"
log "     — or —  curl -fsSL https://claude.ai/install.sh | sh"
log "  4. Clone daemon source into /var/www/scws/daemon/"
log "  5. Create /var/www/scws/daemon/.env with:"
log "       DATABASE_URL=postgresql://scws:<password>@localhost:5432/scws_daemon"
log "       PORT=4000"
log "       DASHBOARD_TOKEN=<generate-a-token>"
log "       SCWS_DB_PASSWORD=<the-password>"
log "       SCWS_BASE_URL=http://spawn.tail852587.ts.net"
log "       NODE_ENV=production"
log "  6. cd /var/www/scws/daemon && npm install && npm run build"
log "  7. sudo -u codeman pm2 start ecosystem.config.cjs"
log "  8. sudo -u codeman pm2 save"
log "  9. Restore DB: gunzip -c backup.sql.gz | psql -U scws -h localhost scws_daemon"
log "  10. Reboot to activate hardware overlays (I2C, SPI, PWM)"
echo ""
log "Ports: daemon=4000, projects=5001-5099"
log "Dashboard: http://<tailscale-ip>/"
