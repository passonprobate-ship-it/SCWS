import express from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const execFileAsync = promisify(execFile);

import crypto from 'crypto';

const PORT = process.env.PORT || 5010;
const AUTH_TOKEN = process.env.AUTH_TOKEN || process.env.DASHBOARD_TOKEN || "";
const app = express();
app.use(express.json());

// Auth middleware — require token for /api routes (except health)
function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next(); // no token configured = open (dev mode)
  if (req.path === '/api/health') return next();
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) { res.status(401).json({ error: 'Authorization required' }); return; }
  const a = crypto.createHash('sha256').update(token).digest();
  const b = crypto.createHash('sha256').update(AUTH_TOKEN).digest();
  if (!crypto.timingSafeEqual(a, b)) { res.status(403).json({ error: 'Invalid token' }); return; }
  next();
}
app.use('/api', authMiddleware);

app.get("/", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>gpio-toolkit</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0f; color: #e0e0e8; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { text-align: center; padding: 48px; border: 1px solid #1e1e2e; border-radius: 16px; background: #12121a; max-width: 480px; }
    h1 { font-size: 2rem; font-weight: 600; margin-bottom: 8px; background: linear-gradient(135deg, #7c6aef, #4ecdc4); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .sub { font-size: 0.85rem; color: #6b6b80; margin-bottom: 24px; }
    .endpoints { text-align: left; font-size: 0.8rem; color: #4a4a5e; padding: 12px; background: #0d0d14; border-radius: 8px; font-family: monospace; line-height: 1.8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>gpio-toolkit</h1>
    <p class="sub">Raspberry Pi 5 GPIO REST API &middot; port ${PORT}</p>
    <div class="endpoints">
      GET /api/health<br>
      GET /api/gpio/info<br>
      GET /api/gpio/:pin<br>
      POST /api/gpio/:pin<br>
      GET /api/i2c/scan<br>
      GET /api/pinmap
    </div>
  </div>
</body>
</html>`);
});


// Track allocated GPIO lines so we can clean up
const allocatedPins = new Map(); // pin -> Gpio instance

// ──────────────────────────────────────────────
// Health
// ──────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'gpio-toolkit', uptime: process.uptime() });
});

// ──────────────────────────────────────────────
// GPIO Info — list all lines on gpiochip4
// ──────────────────────────────────────────────
app.get('/api/gpio/info', async (_req, res) => {
  try {
    const { stdout } = await execFileAsync('gpioinfo', ['gpiochip4']);
    const lines = stdout.trim().split('\n').slice(1).map(line => {
      const m = line.match(/line\s+(\d+):\s+"([^"]*?)"\s+"?([^"]*?)"?\s+(input|output)\s+(active-\w+)/);
      if (!m) return null;
      return {
        line: parseInt(m[1]),
        name: m[2].trim(),
        consumer: m[3].trim() || 'unused',
        direction: m[4],
        active: m[5],
        used: line.includes('[used]')
      };
    }).filter(Boolean);
    res.json({ chip: 'gpiochip4', lines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// GPIO Read — read a pin value
// ──────────────────────────────────────────────
app.get('/api/gpio/:pin', async (req, res) => {
  const pin = parseInt(req.params.pin);
  if (isNaN(pin) || pin < 0 || pin > 53) {
    return res.status(400).json({ error: 'Invalid pin number (0-53)' });
  }
  try {
    const { stdout } = await execFileAsync('gpioget', ['gpiochip4', String(pin)]);
    res.json({ pin, value: parseInt(stdout.trim()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// GPIO Write — set a pin value
// ──────────────────────────────────────────────
app.post('/api/gpio/:pin', async (req, res) => {
  const pin = parseInt(req.params.pin);
  const value = parseInt(req.body.value);
  if (isNaN(pin) || pin < 0 || pin > 53) {
    return res.status(400).json({ error: 'Invalid pin number (0-53)' });
  }
  if (value !== 0 && value !== 1) {
    return res.status(400).json({ error: 'Value must be 0 or 1' });
  }
  try {
    await execFileAsync('gpioset', ['gpiochip4', `${pin}=${value}`]);
    res.json({ pin, value, status: 'set' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// GPIO Blink — toggle a pin N times
// ──────────────────────────────────────────────
app.post('/api/gpio/:pin/blink', async (req, res) => {
  const pin = parseInt(req.params.pin);
  const count = parseInt(req.body.count) || 5;
  const intervalMs = parseInt(req.body.interval) || 500;
  if (isNaN(pin) || pin < 0 || pin > 53) {
    return res.status(400).json({ error: 'Invalid pin number (0-53)' });
  }
  if (count < 1 || count > 100) {
    return res.status(400).json({ error: 'Count must be 1-100' });
  }

  // Use gpioset for toggling (gpiod-based, works on Pi 5 without offset issues)
  try {
    res.json({ pin, count, interval: intervalMs, status: 'blinking' });

    // Run blink in background after responding
    for (let i = 0; i < count; i++) {
      await execFileAsync('gpioset', ['-m', 'time', '-u', String(intervalMs * 1000), 'gpiochip4', `${pin}=1`]);
      if (i < count - 1) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }
    // Ensure pin is low when done
    await execFileAsync('gpioset', ['gpiochip4', `${pin}=0`]);
  } catch (err) {
    // Response already sent, just log
    console.error('Blink error:', err.message);
  }
});

// ──────────────────────────────────────────────
// I2C Scan — detect devices on bus
// ──────────────────────────────────────────────
app.get('/api/i2c/scan', async (_req, res) => {
  const bus = parseInt(_req.query.bus) || 1;
  try {
    const i2c = await import('i2c-bus');
    const wire = await i2c.default.openPromisified(bus);
    const devices = [];
    for (let addr = 0x03; addr <= 0x77; addr++) {
      try {
        await wire.receiveByte(addr);
        devices.push({ address: addr, hex: '0x' + addr.toString(16).padStart(2, '0') });
      } catch {
        // No device at this address
      }
    }
    await wire.close();
    res.json({ bus, devices, count: devices.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// I2C Read — read bytes from a device
// ──────────────────────────────────────────────
app.get('/api/i2c/:address/read', async (req, res) => {
  const addr = parseInt(req.params.address, 16) || parseInt(req.params.address);
  const register = parseInt(req.query.register ?? '0', 16);
  const length = parseInt(req.query.length) || 1;
  const bus = parseInt(req.query.bus) || 1;

  try {
    const i2c = await import('i2c-bus');
    const wire = await i2c.default.openPromisified(bus);
    const buf = Buffer.alloc(length);
    await wire.readI2cBlock(addr, register, length, buf);
    await wire.close();
    res.json({
      address: '0x' + addr.toString(16),
      register: '0x' + register.toString(16),
      data: Array.from(buf),
      hex: buf.toString('hex')
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// I2C Write — write bytes to a device
// ──────────────────────────────────────────────
app.post('/api/i2c/:address/write', async (req, res) => {
  const addr = parseInt(req.params.address, 16) || parseInt(req.params.address);
  const register = parseInt(req.body.register ?? '0', 16);
  const data = req.body.data; // array of bytes
  const bus = parseInt(req.body.bus) || 1;

  if (!Array.isArray(data)) {
    return res.status(400).json({ error: 'data must be an array of bytes' });
  }

  try {
    const i2c = await import('i2c-bus');
    const wire = await i2c.default.openPromisified(bus);
    const buf = Buffer.from(data);
    await wire.writeI2cBlock(addr, register, buf.length, buf);
    await wire.close();
    res.json({
      address: '0x' + addr.toString(16),
      register: '0x' + register.toString(16),
      bytesWritten: buf.length,
      status: 'ok'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// PWM — control hardware PWM via sysfs
// ──────────────────────────────────────────────
app.post('/api/pwm/:channel', async (req, res) => {
  const channel = parseInt(req.params.channel);
  const { period, duty_cycle, enable } = req.body;
  const chip = req.body.chip || 0;
  const base = `/sys/class/pwm/pwmchip${chip}`;

  if (isNaN(channel) || channel < 0 || channel > 3) {
    return res.status(400).json({ error: 'Channel must be 0-3' });
  }

  try {
    const chanPath = `${base}/pwm${channel}`;
    // Export channel if not already exported
    if (!existsSync(chanPath)) {
      writeFileSync(`${base}/export`, String(channel));
      // Small delay for sysfs to create the directory
      await new Promise(r => setTimeout(r, 100));
    }

    if (period !== undefined) {
      writeFileSync(`${chanPath}/period`, String(period));
    }
    if (duty_cycle !== undefined) {
      writeFileSync(`${chanPath}/duty_cycle`, String(duty_cycle));
    }
    if (enable !== undefined) {
      writeFileSync(`${chanPath}/enable`, enable ? '1' : '0');
    }

    // Read back current state
    const state = {
      channel,
      period: parseInt(readFileSync(`${chanPath}/period`, 'utf8')),
      duty_cycle: parseInt(readFileSync(`${chanPath}/duty_cycle`, 'utf8')),
      enabled: readFileSync(`${chanPath}/enable`, 'utf8').trim() === '1'
    };
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// Pin Map — reference for the 40-pin header
// ──────────────────────────────────────────────
app.get('/api/pinmap', (_req, res) => {
  const pinmap = [
    { physical: 1, name: '3V3', gpio: null },
    { physical: 2, name: '5V', gpio: null },
    { physical: 3, name: 'SDA1', gpio: 2, alt: 'I2C' },
    { physical: 4, name: '5V', gpio: null },
    { physical: 5, name: 'SCL1', gpio: 3, alt: 'I2C' },
    { physical: 6, name: 'GND', gpio: null },
    { physical: 7, name: 'GPIO4', gpio: 4 },
    { physical: 8, name: 'TXD', gpio: 14, alt: 'UART' },
    { physical: 9, name: 'GND', gpio: null },
    { physical: 10, name: 'RXD', gpio: 15, alt: 'UART' },
    { physical: 11, name: 'GPIO17', gpio: 17 },
    { physical: 12, name: 'GPIO18', gpio: 18, alt: 'PWM0' },
    { physical: 13, name: 'GPIO27', gpio: 27 },
    { physical: 14, name: 'GND', gpio: null },
    { physical: 15, name: 'GPIO22', gpio: 22 },
    { physical: 16, name: 'GPIO23', gpio: 23 },
    { physical: 17, name: '3V3', gpio: null },
    { physical: 18, name: 'GPIO24', gpio: 24 },
    { physical: 19, name: 'MOSI', gpio: 10, alt: 'SPI' },
    { physical: 20, name: 'GND', gpio: null },
    { physical: 21, name: 'MISO', gpio: 9, alt: 'SPI' },
    { physical: 22, name: 'GPIO25', gpio: 25 },
    { physical: 23, name: 'SCLK', gpio: 11, alt: 'SPI' },
    { physical: 24, name: 'CE0', gpio: 8, alt: 'SPI' },
    { physical: 25, name: 'GND', gpio: null },
    { physical: 26, name: 'CE1', gpio: 7, alt: 'SPI' },
    { physical: 27, name: 'ID_SDA', gpio: 0, alt: 'EEPROM' },
    { physical: 28, name: 'ID_SCL', gpio: 1, alt: 'EEPROM' },
    { physical: 29, name: 'GPIO5', gpio: 5 },
    { physical: 30, name: 'GND', gpio: null },
    { physical: 31, name: 'GPIO6', gpio: 6 },
    { physical: 32, name: 'GPIO12', gpio: 12, alt: 'PWM0' },
    { physical: 33, name: 'GPIO13', gpio: 13, alt: 'PWM1' },
    { physical: 34, name: 'GND', gpio: null },
    { physical: 35, name: 'GPIO19', gpio: 19 },
    { physical: 36, name: 'GPIO16', gpio: 16 },
    { physical: 37, name: 'GPIO26', gpio: 26 },
    { physical: 38, name: 'GPIO20', gpio: 20 },
    { physical: 39, name: 'GND', gpio: null },
    { physical: 40, name: 'GPIO21', gpio: 21 }
  ];
  res.json(pinmap);
});

// ──────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────
// Global error handler middleware
app.use((err, _req, res, _next) => {
  console.error('[gpio-toolkit] Error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`GPIO Toolkit API running on port ${PORT}`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[gpio-toolkit] ${signal} received, shutting down...`);
  for (const [pin, gpio] of allocatedPins) {
    try { gpio.unexport(); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
