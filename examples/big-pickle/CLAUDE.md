# big-pickle

Living Server AI portfolio page - shows off SPAWN with live system stats.

## Environment
- **Port**: 5050
- **Base URL**: /big-pickle
- **Directory**: /var/www/scws/projects/big-pickle
- **Process**: PM2 name `big-pickle`
- **Database**: none

## Stack
Express + TypeScript + esbuild. Build with `node script/build.js`, output to `dist/index.js`.

## Key Files
- `src/index.ts` — Express app, serves the portfolio HTML with live stats
- `script/build.js` — esbuild bundler
- `.env` — PORT, BASE_URL, DASHBOARD_TOKEN

## Rules
- All routes must be relative to BASE_URL (/big-pickle/)
- The app is reverse-proxied by nginx — don't handle SSL
- After changes: build, then `pm2 restart big-pickle`
- Fetches live stats from daemon API and PM2 for the dashboard
