# spawn-browser — shared Chromium browser on SPAWN

One Chromium instance on a virtual display that humans watch/control through
noVNC and AI agents drive through CDP. Everyone shares the same tabs, cookies,
and logins — the "common browser" for Billy + Claude + any other bot on this box.

## Architecture

```
supervisor.cjs (PM2: spawn-browser)
├── Xvfb :99  (1600x900x24, no TCP)
├── Chromium snap — launched via `systemd-run --user --scope` (unit spawn-browser-chromium)
│     CDP: http://127.0.0.1:9222   profile: ~/snap/chromium/common/spawn-browser-profile
├── x11vnc  127.0.0.1:5900  (password: .vncpass, gitignored, chmod 600)
└── websockify  127.0.0.1:5046  (serves /usr/share/novnc web UI + VNC websocket)
```

nginx: `/spawn-browser/` → noVNC UI; `/spawn-browser/websockify` → VNC websocket
(3600s timeouts); `/browser` and `/spawn-browser/` redirect straight into
`vnc.html?autoconnect=true&resize=scale`.

## Environment
- **Port**: 5046 (websockify/noVNC) · VNC 5900 · CDP 9222 — all localhost-only
- **Process**: PM2 `spawn-browser` (64MB heap — supervisor only; Chromium lives
  in its own systemd user scope, outside PM2 memory accounting)
- **User URL**: `http://<host>/browser` (or https://spawn.tail852587.ts.net:8443/browser)
- **VNC password**: in `.vncpass` (never commit)

## Driving it as an agent
- `node drive.cjs goto <url> | shot <file.png> | url` — quick CLI (puppeteer-core
  from /usr/lib/node_modules)
- Or connect any CDP client to `http://127.0.0.1:9222` (multiple clients OK —
  that's the whole point). puppeteer.connect({browserURL, defaultViewport: null}).

## Gotchas
- **Snap + PM2**: snap chromium cannot start inside the pm2 systemd cgroup —
  hence `systemd-run --user --scope` with XDG_RUNTIME_DIR=/run/user/1000.
  Requires `loginctl enable-linger codeman` (enabled 2026-08-28).
- **No window manager**: chromium is the only window; sized to the Xvfb screen.
  Native popups/dialogs may behave oddly — most flows are fine.
- The dbus/GCM ERROR lines in the PM2 log at chromium start are harmless.
- Supervisor restarts any crashed component after 2s; `pm2 restart spawn-browser`
  bounces the whole stack (chromium scope is stopped/cleaned on shutdown).
- Do NOT `pm2 save` with this running (boot-baseline rule).
