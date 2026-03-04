#!/usr/bin/env bash
# =============================================================================
# SPAWN VPS Package — Create a self-contained deployment tarball
# =============================================================================
# Creates spawn-vps-YYYYMMDD.tar.gz with everything needed for manual deploy.
#
# Usage:
#   bash package.sh
#   # — or —
#   bash deploy.sh --package
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCWS_ROOT="/var/www/scws"

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
log() { echo -e "${GREEN}[PACKAGE]${NC} $*"; }
err() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

DATE=$(date +%Y%m%d)
TARBALL="${SCRIPT_DIR}/spawn-vps-${DATE}.tar.gz"
STAGING=$(mktemp -d)
STAGE="${STAGING}/spawn-vps"

log "Creating deployment package..."

mkdir -p "${STAGE}/daemon/dist"
mkdir -p "${STAGE}/scripts"
mkdir -p "${STAGE}/templates"
mkdir -p "${STAGE}/lib"

# ── Verify source files ──────────────────────────────────────────────────────
MISSING=0
for f in daemon/dist/index.cjs daemon/dist/dashboard.html daemon/package.json scripts/set-oom-scores.sh scripts/backup-db.sh; do
  if [[ ! -f "${SCWS_ROOT}/${f}" ]]; then
    err "Missing: ${SCWS_ROOT}/${f}"
    MISSING=1
  fi
done

if [[ $MISSING -eq 1 ]]; then
  err "Cannot create package — missing files."
  rm -rf "$STAGING"
  exit 1
fi

# ── Copy files ────────────────────────────────────────────────────────────────
log "Copying daemon bundle..."
cp "${SCWS_ROOT}/daemon/dist/index.cjs"      "${STAGE}/daemon/dist/"
cp "${SCWS_ROOT}/daemon/dist/dashboard.html"  "${STAGE}/daemon/dist/"
cp "${SCWS_ROOT}/daemon/package.json"         "${STAGE}/daemon/"

log "Copying scripts..."
cp "${SCWS_ROOT}/scripts/set-oom-scores.sh"   "${STAGE}/scripts/"
cp "${SCWS_ROOT}/scripts/backup-db.sh"        "${STAGE}/scripts/"

log "Copying deployment tools..."
cp "${SCRIPT_DIR}/bootstrap-vps.sh"           "${STAGE}/"
cp "${SCRIPT_DIR}/deploy.sh"                  "${STAGE}/"
cp "${SCRIPT_DIR}/config.example.sh"          "${STAGE}/"
cp "${SCRIPT_DIR}/README.md"                  "${STAGE}/"
cp "${SCRIPT_DIR}/templates/"*                "${STAGE}/templates/"

log "Copying onboarding files..."
if [[ -f "${SCRIPT_DIR}/onboard.sh" ]]; then
  cp "${SCRIPT_DIR}/onboard.sh"               "${STAGE}/"
fi
if [[ -f "${SCRIPT_DIR}/lib/onboard-detect.sh" ]]; then
  cp "${SCRIPT_DIR}/lib/onboard-detect.sh"    "${STAGE}/lib/"
fi

log "Copying memory seed script..."
if [[ -f "${SCRIPT_DIR}/seed-memory.sh" ]]; then
  cp "${SCRIPT_DIR}/seed-memory.sh"            "${STAGE}/"
fi

# Include spawn-mcp bundle if available
SPAWN_MCP_DIR="${SCWS_ROOT}/projects/spawn-mcp"
if [[ -f "${SPAWN_MCP_DIR}/dist/index.cjs" && -f "${SPAWN_MCP_DIR}/package.json" ]]; then
  log "Copying spawn-mcp bundle..."
  mkdir -p "${STAGE}/spawn-mcp-bundle/dist"
  cp "${SPAWN_MCP_DIR}/dist/index.cjs"        "${STAGE}/spawn-mcp-bundle/dist/"
  cp "${SPAWN_MCP_DIR}/package.json"           "${STAGE}/spawn-mcp-bundle/"
fi

# ── Create tarball ────────────────────────────────────────────────────────────
log "Creating tarball..."
tar czf "$TARBALL" -C "$STAGING" spawn-vps

# Cleanup
rm -rf "$STAGING"

SIZE=$(du -h "$TARBALL" | cut -f1)
log "Package created: ${TARBALL} (${SIZE})"
echo ""
log "To deploy manually on a VPS:"
log "  1. scp ${TARBALL} root@<vps-ip>:/tmp/"
log "  2. ssh root@<vps-ip>"
log "  3. cd /tmp && tar xzf spawn-vps-${DATE}.tar.gz && cd spawn-vps"
log "  4. cp config.example.sh config.sh && nano config.sh"
log "  5. export SPAWN_DB_PASSWORD=<password>"
log "  6. bash bootstrap-vps.sh"
log "  7. Copy daemon files to /var/www/scws/ and npm install"
log "  8. See README.md for full instructions"
