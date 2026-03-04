#!/usr/bin/env bash
# =============================================================================
# SPAWN Pi Package — Create a self-contained deployment tarball
# =============================================================================
# Creates spawn-pi-YYYYMMDD.tar.gz with everything needed for manual deploy.
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
TARBALL="${SCRIPT_DIR}/spawn-pi-${DATE}.tar.gz"
STAGING=$(mktemp -d)
STAGE="${STAGING}/spawn-pi"

log "Creating Pi deployment package..."

mkdir -p "${STAGE}/daemon/dist"
mkdir -p "${STAGE}/scripts"
mkdir -p "${STAGE}/templates"
mkdir -p "${STAGE}/lib"

# ── Verify source files ─────────────────────────────────────────────────────
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

# ── Copy files ───────────────────────────────────────────────────────────────
log "Copying daemon bundle..."
cp "${SCWS_ROOT}/daemon/dist/index.cjs"      "${STAGE}/daemon/dist/"
cp "${SCWS_ROOT}/daemon/dist/dashboard.html"  "${STAGE}/daemon/dist/"
cp "${SCWS_ROOT}/daemon/package.json"         "${STAGE}/daemon/"

log "Copying scripts..."
cp "${SCWS_ROOT}/scripts/set-oom-scores.sh"   "${STAGE}/scripts/"
cp "${SCWS_ROOT}/scripts/backup-db.sh"        "${STAGE}/scripts/"
if [[ -f "${SCWS_ROOT}/scripts/auto-update.sh" ]]; then
  cp "${SCWS_ROOT}/scripts/auto-update.sh"    "${STAGE}/scripts/"
fi
if [[ -f "${SCWS_ROOT}/scripts/stamp-version.sh" ]]; then
  cp "${SCWS_ROOT}/scripts/stamp-version.sh"  "${STAGE}/scripts/"
fi
if [[ -f "${SCWS_ROOT}/scripts/schema.sql" ]]; then
  cp "${SCWS_ROOT}/scripts/schema.sql"        "${STAGE}/scripts/"
fi

log "Copying deployment tools..."
cp "${SCRIPT_DIR}/bootstrap-pi.sh"            "${STAGE}/"
cp "${SCRIPT_DIR}/deploy.sh"                  "${STAGE}/"
cp "${SCRIPT_DIR}/config.example.sh"          "${STAGE}/"
cp "${SCRIPT_DIR}/README.md"                  "${STAGE}/"

# Copy templates (resolve symlinks)
for tmpl in "${SCRIPT_DIR}/templates/"*; do
  if [[ -f "$tmpl" ]] || [[ -L "$tmpl" ]]; then
    cp -L "$tmpl" "${STAGE}/templates/"
  fi
done

log "Copying onboarding files..."
# Resolve symlinks to get actual files
REAL_ONBOARD=$(readlink -f "${SCRIPT_DIR}/onboard.sh" 2>/dev/null || true)
if [[ -n "$REAL_ONBOARD" && -f "$REAL_ONBOARD" ]]; then
  cp "$REAL_ONBOARD" "${STAGE}/"
fi
REAL_DETECT=$(readlink -f "${SCRIPT_DIR}/lib/onboard-detect.sh" 2>/dev/null || true)
if [[ -n "$REAL_DETECT" && -f "$REAL_DETECT" ]]; then
  cp "$REAL_DETECT" "${STAGE}/lib/"
fi

log "Copying memory seed scripts..."
REAL_SEED=$(readlink -f "${SCRIPT_DIR}/seed-memory.sh" 2>/dev/null || true)
if [[ -n "$REAL_SEED" && -f "$REAL_SEED" ]]; then
  cp "$REAL_SEED" "${STAGE}/"
fi
if [[ -f "${SCRIPT_DIR}/seed-memory-pi.sh" ]]; then
  cp "${SCRIPT_DIR}/seed-memory-pi.sh" "${STAGE}/"
fi

# Include spawn-mcp bundle if available
SPAWN_MCP_DIR="${SCWS_ROOT}/projects/spawn-mcp"
if [[ -f "${SPAWN_MCP_DIR}/dist/index.cjs" && -f "${SPAWN_MCP_DIR}/package.json" ]]; then
  log "Copying spawn-mcp bundle..."
  mkdir -p "${STAGE}/spawn-mcp-bundle/dist"
  cp "${SPAWN_MCP_DIR}/dist/index.cjs"        "${STAGE}/spawn-mcp-bundle/dist/"
  cp "${SPAWN_MCP_DIR}/package.json"           "${STAGE}/spawn-mcp-bundle/"
fi

# ── Create tarball ───────────────────────────────────────────────────────────
log "Creating tarball..."
tar czf "$TARBALL" -C "$STAGING" spawn-pi

# Cleanup
rm -rf "$STAGING"

SIZE=$(du -h "$TARBALL" | cut -f1)
log "Package created: ${TARBALL} (${SIZE})"
echo ""
log "To deploy manually on a Pi:"
log "  1. scp ${TARBALL} root@<pi-ip>:/tmp/"
log "  2. ssh root@<pi-ip>"
log "  3. cd /tmp && tar xzf spawn-pi-${DATE}.tar.gz && cd spawn-pi"
log "  4. cp config.example.sh config.sh && nano config.sh"
log "  5. export SPAWN_DB_PASSWORD=<password>"
log "  6. bash bootstrap-pi.sh"
log "  7. Copy daemon files to /var/www/scws/ and npm install"
log "  8. See README.md for full instructions"
