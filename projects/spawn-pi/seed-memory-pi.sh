#!/usr/bin/env bash
# =============================================================================
# SPAWN Pi Memory Seed — Pi-specific knowledge entries
# =============================================================================
# Seeds 3 Pi-specific knowledge entries into spawn_memories.
# Complements the universal seed-memory.sh with hardware-specific knowledge.
#
# Idempotent: uses INSERT ON CONFLICT DO NOTHING.
# Usage (runs on Pi, typically called by deploy.sh):
#   bash seed-memory-pi.sh
# =============================================================================
set -euo pipefail

SPAWN_DB="${SPAWN_DB:-scws_daemon}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[SEED-PI]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }

# ── Verify database access ──────────────────────────────────────────────────
if ! sudo -u postgres psql "$SPAWN_DB" -c "SELECT 1;" &>/dev/null; then
  warn "Cannot access database '$SPAWN_DB' — skipping Pi memory seed."
  exit 0
fi

TABLE_EXISTS=$(sudo -u postgres psql "$SPAWN_DB" -t -A -c "
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'spawn_memories'
  );" 2>/dev/null || echo "f")

if [[ "$TABLE_EXISTS" != "t" ]]; then
  warn "spawn_memories table not found — skipping Pi memory seed."
  exit 0
fi

log "Seeding Pi-specific knowledge into spawn_memories..."

seed_memory() {
  local key="$1"
  local value="$2"
  local tags="$3"

  sudo -u postgres psql "$SPAWN_DB" -q -c "
    INSERT INTO spawn_memories (key, value, tags, updated_at)
    VALUES (\$\$${key}\$\$, \$\$${value}\$\$, '${tags}', NOW())
    ON CONFLICT (key) DO NOTHING;
  " 2>/dev/null

  if [[ $? -eq 0 ]]; then
    log "  Seeded: $key"
  fi
}

# =============================================================================
# 1. Pi 5 GPIO reference — Hardware-specific knowledge
# =============================================================================
seed_memory "pi5-gpio-reference" \
"## Raspberry Pi 5 GPIO Reference

Pi 5 uses the RP1 chip on gpiochip4 (54 lines). Old RPi.GPIO and pigpio do NOT work on Pi 5.

Working tools:
- CLI: gpioget/gpioset (from gpiod package), pinctrl (built from rpi-utils source)
- Python: gpiod, rpi-lgpio (RPi.GPIO drop-in replacement)
- Node.js: use child_process.execFile('gpioget'/'gpioset') — onoff has sysfs offset issues on Pi 5

Hardware interfaces:
- I2C: /dev/i2c-1, enabled via dtparam=i2c_arm=on in /boot/firmware/config.txt
- SPI: /dev/spidev0.0, enabled via dtparam=spi=on
- PWM: 2-channel on GPIO 12/13, enabled via dtoverlay=pwm-2chan
- UART: /dev/ttyAMA0, enabled via enable_uart=1

udev rules: /etc/udev/rules.d/99-gpio.rules (gives gpio group access to gpiochip*)
Groups: gpio, spi, i2c (user must be member)

Reboot required after changing /boot/firmware/config.txt overlays." \
'["gpio","pi5","hardware","reference"]'

# =============================================================================
# 2. Pi deployment patterns — Operational knowledge
# =============================================================================
seed_memory "pi-deployment-patterns" \
"## Raspberry Pi Deployment Patterns

Memory management is critical on Pi (2-8GB RAM). Defense-in-depth:

1. System tuning: vm.swappiness=5, vm.vfs_cache_pressure=50, swap sized to RAM
2. PM2 per-process heap caps (--max-old-space-size + max_memory_restart)
3. OOM killer: PM2 god daemon at -800, scws-daemon at -500, projects at +300
4. Docker disabled at boot (saves ~128MB idle) — start on demand

Pi-specific scaling (RAM-based):
| RAM  | Swap | PG Conns | Heap   | PM2 Restart |
|------|------|----------|--------|-------------|
| 2GB  | 2G   | 20       | 128MB  | 160M        |
| 4GB  | 4G   | 30       | 192MB  | 200M        |
| 8GB  | 4G   | 30       | 192MB  | 200M        |

Tailscale is the standard Pi networking layer — encrypts wire, no public IP needed.
Pi is always arm64; native module rebuilds (node-pty) work via npm install.

Storage: NVMe SSD via M.2 HAT+ is recommended (5-10x faster than SD card).
SD card works but is slower and wears faster under database workloads." \
'["deployment","pi","patterns","memory"]'

# =============================================================================
# 3. Pi Chromium + puppeteer — Headless browser knowledge
# =============================================================================
seed_memory "pi-chromium-puppeteer" \
"## Chromium + Puppeteer on Raspberry Pi 5

Chromium installed via snap: snap install chromium
Puppeteer-core installed globally: npm install -g puppeteer-core

Usage in Node.js:
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: '/snap/bin/chromium',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    headless: 'new'
  });

Notes:
- Use puppeteer-core (not puppeteer) — we provide our own Chromium binary
- --no-sandbox needed when running as non-root user
- --disable-dev-shm-usage prevents /dev/shm exhaustion on low-RAM Pis
- --disable-gpu avoids GPU acceleration issues on Pi
- Snap Chromium path: /snap/bin/chromium
- Memory: headless Chromium uses ~100-200MB per tab, limit concurrency on Pi" \
'["chromium","puppeteer","pi","reference"]'

# ── Summary ──────────────────────────────────────────────────────────────────
SEEDED=$(sudo -u postgres psql "$SPAWN_DB" -t -A -c "SELECT COUNT(*) FROM spawn_memories;" 2>/dev/null || echo "?")
log "Pi memory seed complete. Total entries in spawn_memories: ${SEEDED}"
