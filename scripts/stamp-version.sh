#!/bin/bash
# =============================================================================
# SPAWN Version Stamper
# =============================================================================
# Reads VERSION file + git state, writes:
#   spawn-version.json  — committed to repo (version metadata)
#   .spawn-instance.json — gitignored (per-machine instance manifest)
#
# Usage:
#   bash scripts/stamp-version.sh
#   bash scripts/stamp-version.sh --deploy-method=auto-update
# =============================================================================
set -euo pipefail

SCWS_ROOT="/var/www/scws"
cd "$SCWS_ROOT"

# ── Parse flags ──────────────────────────────────────────────────────────────

DEPLOY_METHOD="manual"
for arg in "$@"; do
  case "$arg" in
    --deploy-method=*) DEPLOY_METHOD="${arg#--deploy-method=}" ;;
  esac
done

# ── Gather git/version info ──────────────────────────────────────────────────

if [ ! -f VERSION ]; then
    echo "ERROR: VERSION file not found" >&2
    exit 1
fi

VERSION=$(cat VERSION | tr -d '[:space:]')
GIT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_HASH_FULL=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HOSTNAME=$(hostname)

# ── Write spawn-version.json (committed to repo) ────────────────────────────

cat > spawn-version.json << EOF
{
  "version": "${VERSION}",
  "gitHash": "${GIT_HASH}",
  "gitHashFull": "${GIT_HASH_FULL}",
  "branch": "${BRANCH}",
  "buildDate": "${BUILD_DATE}"
}
EOF

# ── Preserve existing instance values ────────────────────────────────────────

INSTANCE_FILE=".spawn-instance.json"
INSTANCE_TYPE=""
INSTANCE_ID=""

if [[ -f "$INSTANCE_FILE" ]]; then
  INSTANCE_TYPE=$(jq -r '.instanceType // empty' "$INSTANCE_FILE" 2>/dev/null || true)
  INSTANCE_ID=$(jq -r '.instanceId // empty' "$INSTANCE_FILE" 2>/dev/null || true)
fi

# Auto-detect if no existing values
if [[ -z "$INSTANCE_TYPE" ]]; then
  if [[ -f /sys/firmware/devicetree/base/model ]] && grep -qi "raspberry pi" /sys/firmware/devicetree/base/model 2>/dev/null; then
    INSTANCE_TYPE="pi"
  else
    INSTANCE_TYPE="vps"
  fi
fi

if [[ -z "$INSTANCE_ID" ]]; then
  INSTANCE_ID="spawn-${INSTANCE_TYPE}-01"
fi

# ── Write .spawn-instance.json (gitignored, per-machine) ────────────────────

cat > "$INSTANCE_FILE" << EOF
{
  "version": "${VERSION}",
  "gitHash": "${GIT_HASH}",
  "instanceType": "${INSTANCE_TYPE}",
  "instanceId": "${INSTANCE_ID}",
  "hostname": "${HOSTNAME}",
  "deployDate": "${BUILD_DATE}",
  "deployedBy": "$(whoami)@${HOSTNAME}",
  "deployMethod": "${DEPLOY_METHOD}"
}
EOF

echo "Stamped v${VERSION} (${GIT_HASH}) at ${BUILD_DATE} [method=${DEPLOY_METHOD}]"
