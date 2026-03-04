#!/usr/bin/env bash
# =============================================================================
# SPAWN Pi Bootstrap — Raspberry Pi 5 System Setup
# =============================================================================
# Sets up a fresh Ubuntu Server 24.04 (arm64) on a Raspberry Pi 5 to run SPAWN.
# Adapted from scripts/bootstrap.sh, restructured to accept config via env vars
# (same pattern as bootstrap-vps.sh) so deploy.sh can drive it remotely.
#
# This script runs ON the Pi as root. It's typically invoked by deploy.sh
# from another machine, but can also be run manually:
#
#   sudo SPAWN_DB_PASSWORD=<pw> bash bootstrap-pi.sh
#   sudo SPAWN_DB_PASSWORD=<pw> bash bootstrap-pi.sh --dry-run
#
# Environment variables (set by deploy.sh or export before running):
#   SPAWN_USER          - Linux user to create/use (default: codeman)
#   SPAWN_HOSTNAME      - Hostname (default: SPAWN)
#   SPAWN_DB_PASSWORD   - PostgreSQL password for 'scws' role (required)
#   ENABLE_TAILSCALE    - true/false (default: true)
#   INSTALL_DOCKER      - true/false (default: true)
#   ENABLE_GPIO         - true/false (default: true)
#   ENABLE_I2C          - true/false (default: true)
#   ENABLE_SPI          - true/false (default: true)
#   ENABLE_PWM          - true/false (default: true)
#   ENABLE_UART         - true/false (default: true)
#   ENABLE_CHROMIUM     - true/false (default: true)
#   EXTRA_DATABASES     - Comma-separated list of extra DBs (default: spawn_cortex,solbot_db)
# =============================================================================
set -euo pipefail

# ── Parse flags ──────────────────────────────────────────────────────────────
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      echo "Usage: sudo bash bootstrap-pi.sh [--dry-run]"
      echo ""
      echo "  --dry-run   Print what would be done without making changes"
      echo ""
      echo "Environment variables:"
      echo "  SPAWN_USER          Linux user (default: codeman)"
      echo "  SPAWN_HOSTNAME      Hostname (default: SPAWN)"
      echo "  SPAWN_DB_PASSWORD   PostgreSQL password (required)"
      echo "  ENABLE_TAILSCALE    true/false (default: true)"
      echo "  INSTALL_DOCKER      true/false (default: true)"
      echo "  ENABLE_GPIO         true/false (default: true)"
      echo "  ENABLE_I2C          true/false (default: true)"
      echo "  ENABLE_SPI          true/false (default: true)"
      echo "  ENABLE_PWM          true/false (default: true)"
      echo "  ENABLE_UART         true/false (default: true)"
      echo "  ENABLE_CHROMIUM     true/false (default: true)"
      echo "  EXTRA_DATABASES     Comma-separated extra DBs (default: spawn_cortex,solbot_db)"
      exit 0
      ;;
  esac
done

# ── Defaults ─────────────────────────────────────────────────────────────────
SPAWN_USER="${SPAWN_USER:-codeman}"
SPAWN_HOSTNAME="${SPAWN_HOSTNAME:-SPAWN}"
SPAWN_DB_PASSWORD="${SPAWN_DB_PASSWORD:-}"
ENABLE_TAILSCALE="${ENABLE_TAILSCALE:-true}"
INSTALL_DOCKER="${INSTALL_DOCKER:-true}"
ENABLE_GPIO="${ENABLE_GPIO:-true}"
ENABLE_I2C="${ENABLE_I2C:-true}"
ENABLE_SPI="${ENABLE_SPI:-true}"
ENABLE_PWM="${ENABLE_PWM:-true}"
ENABLE_UART="${ENABLE_UART:-true}"
ENABLE_CHROMIUM="${ENABLE_CHROMIUM:-true}"
EXTRA_DATABASES="${EXTRA_DATABASES:-spawn_cortex,solbot_db}"

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[SPAWN-PI]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# Dry-run wrapper: prints instead of executing
run() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY-RUN]${NC} $*"
  else
    eval "$@"
  fi
}

# ── Preflight ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (or via sudo)."
  exit 1
fi

if [[ -z "$SPAWN_DB_PASSWORD" ]]; then
  err "SPAWN_DB_PASSWORD is required. Set it before running."
  exit 1
fi

# Verify this is a Raspberry Pi
PI_MODEL=""
if [[ -f /proc/device-tree/model ]]; then
  PI_MODEL=$(tr -d '\0' < /proc/device-tree/model)
  log "Detected: $PI_MODEL"
else
  warn "Cannot detect Pi model via /proc/device-tree/model — proceeding anyway."
fi

ARCH=$(dpkg --print-architecture)
if [[ "$ARCH" != "arm64" ]]; then
  warn "Expected arm64 architecture, got $ARCH. Proceeding anyway."
fi

log "Starting SPAWN Pi bootstrap on $(hostname) — arch=$ARCH — $(date)"

# ── Memory detection for scaling ─────────────────────────────────────────────
RAM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
log "Detected ${RAM_MB}MB RAM"

if (( RAM_MB < 2048 )); then
  # 1GB Pi (Pi Zero 2, Pi 3)
  SWAP_SIZE="2G"; PG_CONNS=15; DAEMON_HEAP=96; PM2_RESTART="128M"
elif (( RAM_MB < 4096 )); then
  # 2GB Pi
  SWAP_SIZE="2G"; PG_CONNS=20; DAEMON_HEAP=128; PM2_RESTART="160M"
elif (( RAM_MB < 8192 )); then
  # 4GB Pi
  SWAP_SIZE="4G"; PG_CONNS=30; DAEMON_HEAP=192; PM2_RESTART="200M"
else
  # 8GB Pi
  SWAP_SIZE="4G"; PG_CONNS=30; DAEMON_HEAP=192; PM2_RESTART="200M"
fi

log "Scaling: swap=${SWAP_SIZE} pg_conns=${PG_CONNS} heap=${DAEMON_HEAP}MB restart=${PM2_RESTART}"

if $DRY_RUN; then
  log "Dry-run mode: showing what would be done..."
  echo ""
  echo "Configuration:"
  echo "  SPAWN_USER=$SPAWN_USER"
  echo "  SPAWN_HOSTNAME=$SPAWN_HOSTNAME"
  echo "  ENABLE_TAILSCALE=$ENABLE_TAILSCALE"
  echo "  INSTALL_DOCKER=$INSTALL_DOCKER"
  echo "  ENABLE_GPIO=$ENABLE_GPIO"
  echo "  ENABLE_I2C=$ENABLE_I2C"
  echo "  ENABLE_SPI=$ENABLE_SPI"
  echo "  ENABLE_PWM=$ENABLE_PWM"
  echo "  ENABLE_UART=$ENABLE_UART"
  echo "  ENABLE_CHROMIUM=$ENABLE_CHROMIUM"
  echo "  EXTRA_DATABASES=$EXTRA_DATABASES"
  echo ""
  echo "Scaling (${RAM_MB}MB RAM):"
  echo "  SWAP_SIZE=$SWAP_SIZE"
  echo "  PG_CONNS=$PG_CONNS"
  echo "  DAEMON_HEAP=$DAEMON_HEAP"
  echo "  PM2_RESTART=$PM2_RESTART"
  echo ""
fi

# ── 1. Hostname ──────────────────────────────────────────────────────────────
log "1. Setting hostname to ${SPAWN_HOSTNAME}..."
run "hostnamectl set-hostname '$SPAWN_HOSTNAME'"
if ! grep -q "127.0.1.1.*${SPAWN_HOSTNAME}" /etc/hosts 2>/dev/null; then
  run "sed -i '/127.0.1.1/d' /etc/hosts"
  run "echo '127.0.1.1 ${SPAWN_HOSTNAME}' >> /etc/hosts"
fi

# ── 2. Create user + sudoers ────────────────────────────────────────────────
if ! id "$SPAWN_USER" &>/dev/null; then
  log "2. Creating user '$SPAWN_USER'..."
  run "useradd -m -s /bin/bash '$SPAWN_USER'"
  if [[ -f /root/.ssh/authorized_keys ]]; then
    run "mkdir -p '/home/$SPAWN_USER/.ssh'"
    run "cp /root/.ssh/authorized_keys '/home/$SPAWN_USER/.ssh/'"
    run "chown -R '$SPAWN_USER:$SPAWN_USER' '/home/$SPAWN_USER/.ssh'"
    run "chmod 700 '/home/$SPAWN_USER/.ssh'"
    run "chmod 600 '/home/$SPAWN_USER/.ssh/authorized_keys'"
  fi
else
  log "2. User '$SPAWN_USER' already exists."
fi

log "   Configuring sudoers..."
run "echo '$SPAWN_USER ALL=(ALL) NOPASSWD: ALL' > '/etc/sudoers.d/$SPAWN_USER'"
run "chmod 440 '/etc/sudoers.d/$SPAWN_USER'"

# ── 3. User groups ──────────────────────────────────────────────────────────
log "3. Setting up user groups..."
if [[ "$ENABLE_GPIO" == "true" ]]; then
  for grp in gpio spi i2c; do
    run "groupadd -f '$grp'"
  done
  run "usermod -aG sudo,adm,dialout,cdrom,audio,video,plugdev,games,users,input,render,netdev,gpio,spi,i2c '$SPAWN_USER'"
else
  run "usermod -aG sudo,adm '$SPAWN_USER' 2>/dev/null || true"
fi

# ── 4. APT repositories ─────────────────────────────────────────────────────
log "4. Adding APT repositories (arch=$ARCH)..."

# NodeSource (Node.js 20.x)
run "mkdir -p /usr/share/keyrings"
if [[ ! -f /usr/share/keyrings/nodesource.gpg ]]; then
  run "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg"
fi
run "cat > /etc/apt/sources.list.d/nodesource.sources <<APTEOF
Types: deb
URIs: https://deb.nodesource.com/node_20.x
Suites: nodistro
Components: main
Architectures: ${ARCH}
Signed-By: /usr/share/keyrings/nodesource.gpg
APTEOF"

# GitHub CLI
if [[ ! -f /usr/share/keyrings/githubcli-archive-keyring.gpg ]]; then
  run "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg"
fi
run "echo 'deb [arch=${ARCH} signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' > /etc/apt/sources.list.d/github-cli.list"

# Tailscale (conditional)
if [[ "$ENABLE_TAILSCALE" == "true" ]]; then
  if [[ ! -f /usr/share/keyrings/tailscale-archive-keyring.gpg ]]; then
    run "curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg"
  fi
  run "echo 'deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main' > /etc/apt/sources.list.d/tailscale.list"
fi

# Docker (conditional)
if [[ "$INSTALL_DOCKER" == "true" ]]; then
  run "mkdir -p /etc/apt/keyrings"
  if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
    run "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc"
    run "chmod a+r /etc/apt/keyrings/docker.asc"
  fi
  run "echo 'deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable' > /etc/apt/sources.list.d/docker.list"
fi

# ── 5. System packages ──────────────────────────────────────────────────────
log "5. Updating and installing system packages..."
run "apt-get update -qq"

# Base packages
BASE_PKGS="nodejs postgresql postgresql-contrib redis-server nginx gh git build-essential python3 python3-pip python3-venv golang-go cmake imagemagick ffmpeg jq yq ripgrep libcap2-bin fail2ban ufw sqlite3 curl wget unzip htop tree"

# Pi-specific GPIO packages
GPIO_PKGS=""
if [[ "$ENABLE_GPIO" == "true" ]]; then
  GPIO_PKGS="i2c-tools libgpiod-dev gpiod"
fi

run "apt-get install -y -qq $BASE_PKGS $GPIO_PKGS"

# Tailscale
if [[ "$ENABLE_TAILSCALE" == "true" ]]; then
  run "apt-get install -y -qq tailscale"
fi

# Docker
if [[ "$INSTALL_DOCKER" == "true" ]]; then
  run "apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
  run "usermod -aG docker '$SPAWN_USER'"
fi

# ── 6. Chromium via snap (conditional) ──────────────────────────────────────
if [[ "$ENABLE_CHROMIUM" == "true" ]]; then
  log "6. Installing Chromium browser via snap..."
  if ! snap list chromium &>/dev/null 2>&1; then
    run "snap install chromium"
  else
    log "   Chromium already installed."
  fi
else
  log "6. Skipping Chromium (ENABLE_CHROMIUM=false)"
fi

# ── 7. Node.js global packages ──────────────────────────────────────────────
log "7. Installing global npm packages..."
NPM_GLOBALS="pm2@latest typescript tsx esbuild"
if [[ "$ENABLE_CHROMIUM" == "true" ]]; then
  NPM_GLOBALS="$NPM_GLOBALS puppeteer-core"
fi
run "npm install -g $NPM_GLOBALS"

# ── 8. PM2 log rotation ─────────────────────────────────────────────────────
log "8. Installing and configuring pm2-logrotate..."
run "sudo -u '$SPAWN_USER' pm2 install pm2-logrotate"
run "sudo -u '$SPAWN_USER' pm2 set pm2-logrotate:max_size 10M"
run "sudo -u '$SPAWN_USER' pm2 set pm2-logrotate:retain 5"
run "sudo -u '$SPAWN_USER' pm2 set pm2-logrotate:compress true"
run "sudo -u '$SPAWN_USER' pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss"
run "sudo -u '$SPAWN_USER' pm2 set pm2-logrotate:rotateInterval '0 0 * * *'"
run "sudo -u '$SPAWN_USER' pm2 set pm2-logrotate:rotateModule true"

# ── 9. PM2 startup hook ─────────────────────────────────────────────────────
log "9. Configuring PM2 startup..."
run "env PATH=\$PATH:/usr/bin pm2 startup systemd -u '$SPAWN_USER' --hp '/home/$SPAWN_USER' --no-daemon"
run "systemctl enable 'pm2-${SPAWN_USER}'"

# ── 10. Bun ─────────────────────────────────────────────────────────────────
log "10. Installing Bun..."
run "sudo -u '$SPAWN_USER' bash -c 'curl -fsSL https://bun.sh/install | bash'"

# ── 11. PostgreSQL setup ────────────────────────────────────────────────────
log "11. Configuring PostgreSQL..."
run "systemctl enable --now postgresql"

# Create the scws role
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='scws'" 2>/dev/null | grep -q 1; then
  log "    Creating PostgreSQL role 'scws'..."
  run "sudo -u postgres psql -c \"CREATE ROLE scws WITH LOGIN PASSWORD '${SPAWN_DB_PASSWORD}';\""
else
  log "    PostgreSQL role 'scws' already exists."
fi

# Create main database
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='scws_daemon'" 2>/dev/null | grep -q 1; then
  run "sudo -u postgres psql -c 'CREATE DATABASE scws_daemon OWNER scws;'"
  log "    Created database: scws_daemon"
else
  log "    Database scws_daemon already exists."
fi

# Create extra databases
if [[ -n "$EXTRA_DATABASES" ]]; then
  IFS=',' read -ra EXTRA_DBS <<< "$EXTRA_DATABASES"
  for db in "${EXTRA_DBS[@]}"; do
    db=$(echo "$db" | tr -d ' ')
    if [[ -z "$db" ]]; then continue; fi
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" 2>/dev/null | grep -q 1; then
      run "sudo -u postgres psql -c 'CREATE DATABASE $db OWNER scws;'"
      log "    Created database: $db"
    else
      log "    Database $db already exists."
    fi
  done
fi

# ── 12. Directory structure ──────────────────────────────────────────────────
log "12. Creating SPAWN directory structure..."
run "mkdir -p /var/www/scws/{daemon/dist,projects,nginx/projects,scripts,logs,backups}"
run "chown -R '$SPAWN_USER:$SPAWN_USER' /var/www/scws"

# ── 13. Swap ─────────────────────────────────────────────────────────────────
log "13. Configuring ${SWAP_SIZE} swap..."
if [[ ! -f /swapfile ]]; then
  run "fallocate -l '$SWAP_SIZE' /swapfile"
  run "chmod 600 /swapfile"
  run "mkswap /swapfile"
  run "swapon /swapfile"
  run "echo '/swapfile none swap sw 0 0' >> /etc/fstab"
  log "    ${SWAP_SIZE} swapfile created and activated."
else
  log "    Swapfile already exists."
fi

# ── 14. Kernel tuning ───────────────────────────────────────────────────────
log "14. Applying kernel tuning..."
run "cat > /etc/sysctl.d/99-spawn-memory.conf <<'SYSEOF'
vm.swappiness=5
vm.vfs_cache_pressure=50
SYSEOF"
run "sysctl --system >/dev/null 2>&1"

# ── 15. GPIO / I2C / SPI / PWM hardware config ──────────────────────────────
if [[ "$ENABLE_GPIO" == "true" ]]; then
  log "15. Configuring Pi 5 hardware interfaces..."

  # udev rule for GPIO group access
  run "cat > /etc/udev/rules.d/99-gpio.rules <<'UDEVEOF'
SUBSYSTEM==\"gpio\", KERNEL==\"gpiochip*\", GROUP=\"gpio\", MODE=\"0660\"
UDEVEOF"
  run "udevadm control --reload-rules"
  run "udevadm trigger"

  # Boot firmware overlays
  BOOT_CONFIG="/boot/firmware/config.txt"
  if [[ -f "$BOOT_CONFIG" ]] || $DRY_RUN; then
    REBOOT_NEEDED=false

    if [[ "$ENABLE_I2C" == "true" ]]; then
      if ! grep -q '^dtparam=i2c_arm=on' "$BOOT_CONFIG" 2>/dev/null; then
        run "sed -i '/^\[all\]/a dtparam=i2c_arm=on' '$BOOT_CONFIG'"
        REBOOT_NEEDED=true
      fi
    fi

    if [[ "$ENABLE_SPI" == "true" ]]; then
      if ! grep -q '^dtparam=spi=on' "$BOOT_CONFIG" 2>/dev/null; then
        run "sed -i '/^\[all\]/a dtparam=spi=on' '$BOOT_CONFIG'"
        REBOOT_NEEDED=true
      fi
    fi

    if [[ "$ENABLE_UART" == "true" ]]; then
      if ! grep -q '^enable_uart=1' "$BOOT_CONFIG" 2>/dev/null; then
        run "sed -i '/^\[all\]/a enable_uart=1' '$BOOT_CONFIG'"
        REBOOT_NEEDED=true
      fi
    fi

    if [[ "$ENABLE_PWM" == "true" ]]; then
      if ! grep -q 'dtoverlay=pwm-2chan' "$BOOT_CONFIG" 2>/dev/null; then
        run "echo 'dtoverlay=pwm-2chan,pin=12,func=4,pin2=13,func2=4' >> '$BOOT_CONFIG'"
        REBOOT_NEEDED=true
      fi
    fi

    if $REBOOT_NEEDED; then
      log "    Boot config updated. Reboot required for hardware changes."
    fi
  else
    warn "    Boot config not found at $BOOT_CONFIG — skipping hardware overlay setup."
  fi
else
  log "15. Skipping GPIO/hardware setup (ENABLE_GPIO=false)"
fi

# ── 16. Python GPIO libraries (conditional) ─────────────────────────────────
if [[ "$ENABLE_GPIO" == "true" ]]; then
  log "16. Installing Python GPIO libraries..."
  run "pip3 install gpiod rpi-lgpio --break-system-packages 2>/dev/null || pip3 install gpiod rpi-lgpio"
else
  log "16. Skipping Python GPIO libraries (ENABLE_GPIO=false)"
fi

# ── 17. pinctrl from source (conditional) ───────────────────────────────────
if [[ "$ENABLE_GPIO" == "true" ]]; then
  log "17. Building pinctrl from source..."
  if [[ ! -f /usr/local/bin/pinctrl ]] || $DRY_RUN; then
    TMPDIR_PC=$(mktemp -d)
    run "git clone --depth=1 https://github.com/raspberrypi/utils.git '$TMPDIR_PC/rpi-utils'"
    run "cd '$TMPDIR_PC/rpi-utils' && cmake -B build -DCMAKE_INSTALL_PREFIX=/usr/local && cmake --build build --target pinctrl"
    run "cp '$TMPDIR_PC/rpi-utils/build/pinctrl/pinctrl' /usr/local/bin/pinctrl"
    run "chmod +x /usr/local/bin/pinctrl"
    run "rm -rf '$TMPDIR_PC'"
    log "    pinctrl installed to /usr/local/bin/pinctrl"
  else
    log "    pinctrl already installed."
  fi
else
  log "17. Skipping pinctrl (ENABLE_GPIO=false)"
fi

# ── 18. Nginx configuration ─────────────────────────────────────────────────
log "18. Configuring nginx..."

# Build server_name — on Pi we use Tailscale IP + LAN IP + catch-all
SERVER_NAMES=""
# Try Tailscale IP
if command -v tailscale &>/dev/null; then
  TS_IP=$(tailscale ip -4 2>/dev/null || true)
  if [[ -n "$TS_IP" ]]; then
    SERVER_NAMES="$TS_IP"
  fi
fi
# Try Tailscale DNS name
TS_DNS="${SPAWN_HOSTNAME,,}.tail852587.ts.net"
SERVER_NAMES="${SERVER_NAMES:+$SERVER_NAMES }${TS_DNS}"
# Try LAN IP
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
if [[ -n "$LAN_IP" ]]; then
  SERVER_NAMES="${SERVER_NAMES:+$SERVER_NAMES }${LAN_IP}"
fi
SERVER_NAMES="${SERVER_NAMES:+$SERVER_NAMES }_"

run "rm -f /etc/nginx/sites-enabled/default"

run "cat > /etc/nginx/sites-available/scws <<NGINXEOF
server {
    listen 80;
    server_name ${SERVER_NAMES};

    client_max_body_size 150m;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\\$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    include /var/www/scws/nginx/projects/*.conf;
}
NGINXEOF"

run "ln -sf /etc/nginx/sites-available/scws /etc/nginx/sites-enabled/scws"
run "nginx -t && systemctl reload nginx"
run "systemctl enable nginx"

# ── 19. UFW firewall ────────────────────────────────────────────────────────
log "19. Configuring firewall..."
run "ufw --force reset"
run "ufw default deny incoming"
run "ufw default allow outgoing"
run "ufw allow 22/tcp"
run "ufw allow 80/tcp"
if [[ "$ENABLE_TAILSCALE" == "true" ]]; then
  run "ufw allow in on tailscale0 2>/dev/null || true"
fi
run "ufw --force enable"
run "systemctl enable ufw"

# ── 20. Fail2ban ────────────────────────────────────────────────────────────
log "20. Configuring fail2ban..."
run "cat > /etc/fail2ban/jail.local <<'F2BEOF'
[DEFAULT]
bantime = 1800
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = ssh
logpath = %(sshd_log)s
F2BEOF"
run "systemctl enable fail2ban"
run "systemctl restart fail2ban || true"

# ── 21. Backup cron ─────────────────────────────────────────────────────────
log "21. Installing backup cron jobs..."
# backup-db.sh is deployed separately by deploy.sh
CRON_LOCAL="0 2 * * * /var/www/scws/scripts/backup-db.sh >> /var/www/scws/logs/backup.log 2>&1"
CRON_OFFSITE="15 2 * * * /var/www/scws/scripts/backup-offsite.sh >> /var/www/scws/logs/backup-offsite.log 2>&1"
CRON_UPDATE="*/5 * * * * /var/www/scws/scripts/auto-update.sh >> /var/www/scws/logs/auto-update.log 2>&1"
if ! $DRY_RUN; then
  (sudo -u "$SPAWN_USER" crontab -l 2>/dev/null | grep -v 'backup-db.sh' | grep -v 'backup-offsite.sh' | grep -v 'auto-update.sh'; echo "$CRON_LOCAL"; echo "$CRON_OFFSITE"; echo "$CRON_UPDATE") \
    | sudo -u "$SPAWN_USER" crontab -
fi

# ── 22. Shell profile ───────────────────────────────────────────────────────
log "22. Configuring shell profile..."
PROFILE="/home/$SPAWN_USER/.profile"
BASHRC="/home/$SPAWN_USER/.bashrc"

if ! grep -q 'BUN_INSTALL' "$PROFILE" 2>/dev/null; then
  run "cat >> '$PROFILE' <<PROFILEEOF

# Bun
export PATH=\"/home/${SPAWN_USER}/.bun/bin:\\\$PATH\"
PROFILEEOF"
fi

if ! grep -q 'BUN_INSTALL' "$BASHRC" 2>/dev/null; then
  run "cat >> '$BASHRC' <<BASHRCEOF

# Bun
export BUN_INSTALL=\"\\\$HOME/.bun\"
export PATH=\"\\\$BUN_INSTALL/bin:\\\$PATH\"
BASHRCEOF"
fi

run "chown '$SPAWN_USER:$SPAWN_USER' '$PROFILE' '$BASHRC'"

# ── 23. OOM killer prioritization ───────────────────────────────────────────
log "23. Configuring OOM killer priorities..."

run "mkdir -p '/etc/systemd/system/pm2-${SPAWN_USER}.service.d'"
run "cat > '/etc/systemd/system/pm2-${SPAWN_USER}.service.d/oom.conf' <<'OOMEOF'
[Service]
OOMScoreAdjust=-800
OOMEOF"
run "systemctl daemon-reload"

# Per-process OOM score script
run "cat > /var/www/scws/scripts/set-oom-scores.sh <<'OOMSCRIPT'
#!/bin/bash
set -euo pipefail
log() { echo \"[OOM] \$*\"; }
set_oom() {
  local name=\"\$1\" score=\"\$2\"
  local pid
  pid=\$(pm2 pid \"\$name\" 2>/dev/null || true)
  if [[ -n \"\$pid\" && \"\$pid\" != \"0\" && -d \"/proc/\$pid\" ]]; then
    printf '%d' \"\$score\" | sudo tee \"/proc/\$pid/oom_score_adj\" > /dev/null 2>&1 && \\
      log \"\$name (pid \$pid) -> oom_score_adj=\$score\" || \\
      log \"\$name (pid \$pid) -> failed to set (may need root)\"
  fi
}
set_oom \"scws-daemon\" -500
set_oom \"spawn-mcp\" -300
for proj in \$(pm2 jlist 2>/dev/null | python3 -c \"
import sys, json
try:
    data = json.load(sys.stdin)
    for p in data:
        name = p.get('name', '')
        status = p.get('pm2_env', {}).get('status', '')
        if name not in ('scws-daemon', 'spawn-mcp', 'pm2-logrotate') and status == 'online':
            print(name)
except: pass
\" 2>/dev/null); do
  set_oom \"\$proj\" 300
done
log \"OOM scores applied.\"
OOMSCRIPT"
run "chmod +x /var/www/scws/scripts/set-oom-scores.sh"

# ── 24. Docker disable at boot (if installed) ───────────────────────────────
if [[ "$INSTALL_DOCKER" == "true" ]]; then
  log "24. Disabling Docker at boot (saves ~128MB idle RAM)..."
  run "systemctl disable docker.service docker.socket containerd.service 2>/dev/null || true"
  run "systemctl stop docker.service containerd.service 2>/dev/null || true"
else
  log "24. Skipping Docker disable (not installed)"
fi

# ── 25. PostgreSQL tuning ───────────────────────────────────────────────────
log "25. Tuning PostgreSQL (max_connections=${PG_CONNS})..."
if ! $DRY_RUN; then
  PG_CONF=$(find /etc/postgresql -name postgresql.conf -type f 2>/dev/null | head -1)
  if [[ -n "$PG_CONF" ]]; then
    sed -i "s/^max_connections = .*/max_connections = ${PG_CONNS}/" "$PG_CONF"
    systemctl restart postgresql
  fi
fi

# ── 26. File ownership sweep ────────────────────────────────────────────────
log "26. Final ownership sweep..."
run "chown -R '$SPAWN_USER:$SPAWN_USER' /var/www/scws"

# ── 27. Export scaling values for deploy.sh ─────────────────────────────────
log "27. Exporting scaling values..."
cat > /tmp/spawn-bootstrap-values <<VALEOF
DAEMON_HEAP=${DAEMON_HEAP}
PM2_RESTART=${PM2_RESTART}
VALEOF

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
log "============================================"
log "  SPAWN Pi bootstrap complete!"
log "============================================"
echo ""
log "Installed:"
log "  Node.js $(node --version 2>/dev/null || echo 'N/A'), npm $(npm --version 2>/dev/null || echo 'N/A')"
log "  PostgreSQL $(psql --version 2>/dev/null | awk '{print $3}' || echo 'N/A')"
log "  Redis $(redis-server --version 2>/dev/null | awk '{print $3}' | tr -d 'v=' || echo 'N/A')"
log "  nginx $(nginx -v 2>&1 | awk -F/ '{print $2}' || echo 'N/A')"
if [[ "$INSTALL_DOCKER" == "true" ]]; then
  log "  Docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',' || echo 'N/A')"
fi
log "  PM2 $(pm2 --version 2>/dev/null || echo 'N/A')"
if [[ "$ENABLE_TAILSCALE" == "true" ]]; then
  log "  Tailscale $(tailscale version 2>/dev/null | head -1 || echo 'N/A')"
fi
echo ""
log "Memory scaling: heap=${DAEMON_HEAP}MB restart=${PM2_RESTART} pg_conns=${PG_CONNS} swap=${SWAP_SIZE}"
log "Ports: daemon=4000, projects=5001-5099"
if [[ -n "$PI_MODEL" ]]; then
  log "Hardware: $PI_MODEL"
fi
echo ""
if [[ "$ENABLE_GPIO" == "true" ]]; then
  log "Reboot to activate hardware overlays (I2C, SPI, PWM, UART)"
fi
if [[ "$ENABLE_TAILSCALE" == "true" ]]; then
  log "Next: sudo tailscale up --hostname=${SPAWN_HOSTNAME}"
fi
