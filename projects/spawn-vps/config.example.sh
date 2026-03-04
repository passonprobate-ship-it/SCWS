#!/usr/bin/env bash
# =============================================================================
# SPAWN VPS Deployment — Configuration
# =============================================================================
# Copy this file to config.sh and fill in your values:
#   cp config.example.sh config.sh
#   nano config.sh
# =============================================================================

# ── Target VPS ───────────────────────────────────────────────────────────────
VPS_HOST=""                    # IP or hostname of the VPS
VPS_USER="root"                # SSH user (needs root or sudo)
VPS_SSH_KEY=""                 # Path to SSH private key (empty = default ~/.ssh/id_ed25519)
VPS_SSH_PORT="22"              # SSH port

# ── SPAWN Configuration ─────────────────────────────────────────────────────
SPAWN_USER="spawn"             # Linux user to create/use on VPS
SPAWN_HOSTNAME="SPAWN"         # Hostname for the VPS

# ── Networking ───────────────────────────────────────────────────────────────
SPAWN_DOMAIN=""                # Public domain (e.g., spawn.example.com). Empty = IP only.
ENABLE_SSL="false"             # true = install certbot + Let's Encrypt SSL
SSL_EMAIL=""                   # Required if ENABLE_SSL=true

# ── Secrets (auto-generated if left empty) ───────────────────────────────────
SPAWN_DB_PASSWORD=""           # PostgreSQL password for 'scws' role
SPAWN_DASHBOARD_TOKEN=""       # Dashboard auth token

# ── Optional Features ───────────────────────────────────────────────────────
ENABLE_TAILSCALE="false"       # true = install Tailscale (requires manual auth after)
INSTALL_DOCKER="false"         # true = install Docker (disabled at boot to save RAM)

# ── Base URL ─────────────────────────────────────────────────────────────────
# Auto-computed from SPAWN_DOMAIN or VPS_HOST if left empty
SPAWN_BASE_URL=""              # e.g., https://spawn.example.com or http://1.2.3.4
