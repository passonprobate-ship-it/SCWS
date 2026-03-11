# gpio-toolkit

REST API for Raspberry Pi 5 GPIO control — digital I/O, PWM, I2C, SPI.

## Environment
- **Port**: 5010
- **Base URL**: /gpio-toolkit
- **Directory**: /var/www/scws/projects/gpio-toolkit
- **Process**: PM2 name `gpio-toolkit`
- **Database**: none
- **Pi-only**: Requires Raspberry Pi hardware (lgpio, i2c-bus, spi-device)

## Stack
Plain JavaScript (no build step). Express 4 + lgpio/i2c-bus/spi-device native modules.

## Key Files
- `index.js` — Express app with all GPIO/I2C/SPI/PWM endpoints

## Rules
- All routes are relative to BASE_URL (/gpio-toolkit/)
- Reverse-proxied by nginx — don't handle SSL
- Native modules must be compiled on the Pi (npm install on target)
- After changes: `pm2 restart gpio-toolkit`
