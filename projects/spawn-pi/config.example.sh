#!/usr/bin/env bash
# =============================================================================
# SPAWN Pi Deploy — Configuration Template
# =============================================================================
# Copy to config.sh and fill in your values:
#   cp config.example.sh config.sh && nano config.sh
# =============================================================================

# ── Target Pi ────────────────────────────────────────────────────────────────
PI_HOST=""                     # IP or hostname of the target Pi
PI_USER="root"                 # SSH user (root for initial setup)
PI_SSH_KEY=""                  # empty = default ~/.ssh/id_ed25519
PI_SSH_PORT="22"

# ── SPAWN user ───────────────────────────────────────────────────────────────
SPAWN_USER="codeman"           # Linux user to create/use (Pi default: codeman)
SPAWN_HOSTNAME="SPAWN"         # Hostname to set on the Pi

# ── Secrets (auto-generated if empty) ────────────────────────────────────────
SPAWN_DB_PASSWORD=""            # PostgreSQL password for 'scws' role
SPAWN_DASHBOARD_TOKEN=""        # Dashboard Bearer token

# ── Networking ───────────────────────────────────────────────────────────────
ENABLE_TAILSCALE="true"        # Install + enable Tailscale (recommended for Pi)
SPAWN_BASE_URL=""              # Auto-computed from Tailscale IP or PI_HOST if empty

# ── Hardware features ────────────────────────────────────────────────────────
ENABLE_GPIO="true"             # GPIO groups, udev rules, boot overlays
ENABLE_I2C="true"              # I2C bus (dtparam=i2c_arm=on)
ENABLE_SPI="true"              # SPI bus (dtparam=spi=on)
ENABLE_PWM="true"              # PWM overlay (2-channel on GPIO 12/13)
ENABLE_UART="true"             # Serial UART (enable_uart=1)
ENABLE_CHROMIUM="true"         # Chromium snap + puppeteer-core

# ── Software options ─────────────────────────────────────────────────────────
INSTALL_DOCKER="true"          # Install Docker (disabled at boot to save RAM)

# ── Extra databases ──────────────────────────────────────────────────────────
EXTRA_DATABASES="spawn_cortex,solbot_db"   # Comma-separated, created with owner scws
