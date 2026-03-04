#!/bin/bash
# =============================================================================
# SPAWN Version Stamper
# =============================================================================
# Reads VERSION file + git state, writes:
#   spawn-version.json  — committed to repo (version metadata)
#   .spawn-instance.json — gitignored (per-machine instance manifest)
#
# Usage: bash scripts/stamp-version.sh
# =============================================================================
set -euo pipefail

SCWS_ROOT="/var/www/scws"
cd "$SCWS_ROOT"

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

# Write spawn-version.json (committed to repo)
cat > spawn-version.json << EOF
{
  "version": "${VERSION}",
  "gitHash": "${GIT_HASH}",
  "gitHashFull": "${GIT_HASH_FULL}",
  "branch": "${BRANCH}",
  "buildDate": "${BUILD_DATE}"
}
EOF

# Write .spawn-instance.json (gitignored, per-machine)
cat > .spawn-instance.json << EOF
{
  "version": "${VERSION}",
  "gitHash": "${GIT_HASH}",
  "instanceType": "pi",
  "instanceId": "spawn-pi-01",
  "hostname": "${HOSTNAME}",
  "deployDate": "${BUILD_DATE}",
  "deployedBy": "$(whoami)@${HOSTNAME}",
  "deployMethod": "local"
}
EOF

echo "Stamped v${VERSION} (${GIT_HASH}) at ${BUILD_DATE}"
