#!/usr/bin/env node
/**
 * spawn-browser supervisor — runs the shared-browser stack on one virtual display:
 *
 *   Xvfb :99  ──►  Chromium (snap, via systemd-run user scope, CDP on 127.0.0.1:9222)
 *              └►  x11vnc (127.0.0.1:5900, password-protected)
 *                    └►  websockify + noVNC web UI (127.0.0.1:PORT)
 *
 * Snap chromium cannot start inside the PM2 systemd service cgroup, so it is
 * launched through `systemd-run --user --scope` (requires loginctl linger for
 * codeman, enabled 2026-08-28). All listeners bind localhost; nginx exposes
 * only the noVNC web UI at /spawn-browser/.
 */
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOME = process.env.HOME || "/home/codeman";
const PORT = parseInt(process.env.PORT || "5046", 10);
const DISPLAY = process.env.DISPLAY_NUM || ":99";
const SCREEN = process.env.SCREEN || "1600x900x24";
const [SCREEN_W, SCREEN_H] = SCREEN.split("x");
const VNC_PORT = 5900;
const CDP_PORT = 9222;
const CHROMIUM_UNIT = "spawn-browser-chromium";
const PROFILE_DIR = path.join(HOME, "snap/chromium/common/spawn-browser-profile");
const PASSWD_FILE = path.join(__dirname, ".vncpass");
const XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
let shuttingDown = false;
const children = new Map(); // name -> ChildProcess

function stopChromiumScope() {
  try {
    execFileSync("systemctl", ["--user", "stop", `${CHROMIUM_UNIT}.scope`], {
      env: { ...process.env, XDG_RUNTIME_DIR },
      stdio: "ignore",
    });
  } catch {} // not running — fine
}

function start(name, cmd, args, extraEnv = {}) {
  if (shuttingDown) return;
  const child = spawn(cmd, args, {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.set(name, child);
  log(`started ${name} (pid ${child.pid})`);
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;
    log(`${name} exited (code=${code} signal=${signal}) — restarting in 2s`);
    if (name === "chromium") stopChromiumScope(); // clear stale scope before relaunch
    setTimeout(() => start(name, cmd, args, extraEnv), 2000);
  });
}

function waitForDisplay(timeoutMs = 10000) {
  const sock = `/tmp/.X11-unix/X${DISPLAY.slice(1)}`;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (fs.existsSync(sock)) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error("Xvfb display never appeared")); }
    }, 200);
  });
}

async function main() {
  if (!fs.existsSync(PASSWD_FILE)) {
    console.error(`Missing ${PASSWD_FILE} — create it with a VNC password (chmod 600)`);
    process.exit(1);
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  stopChromiumScope(); // clean up any orphan from a previous run

  start("xvfb", "Xvfb", [DISPLAY, "-screen", "0", SCREEN, "-nolisten", "tcp"]);
  await waitForDisplay();

  start("chromium", "systemd-run", [
    "--user", "--scope", "--collect", "--quiet", `--unit=${CHROMIUM_UNIT}`,
    "--setenv=DISPLAY=" + DISPLAY,
    "snap", "run", "chromium",
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    `--window-size=${SCREEN_W},${SCREEN_H}`,
    "--window-position=0,0",
    "--start-maximized",
  ], { XDG_RUNTIME_DIR });

  start("x11vnc", "x11vnc", [
    "-display", DISPLAY,
    "-rfbport", String(VNC_PORT),
    "-localhost",
    "-forever",
    "-shared",
    "-repeat",
    "-noxdamage",
    "-passwdfile", `read:${PASSWD_FILE}`,
    "-quiet",
  ]);

  start("websockify", "websockify", [
    "--web=/usr/share/novnc",
    `127.0.0.1:${PORT}`,
    `127.0.0.1:${VNC_PORT}`,
  ]);

  log(`spawn-browser up: noVNC http://127.0.0.1:${PORT}/vnc.html, CDP http://127.0.0.1:${CDP_PORT}`);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down");
  for (const [name, child] of children) {
    log(`stopping ${name}`);
    child.kill("SIGTERM");
  }
  stopChromiumScope();
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((e) => { console.error(e); process.exit(1); });
