import { type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseUrl } from "url";
import { log } from "./logger.js";

// node-pty is a native module — must be required at runtime (not bundled by esbuild)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pty = require("node-pty");

// ── Config ────────────────────────────────────────────────────────

const MAX_SESSIONS = 3;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ── Types ─────────────────────────────────────────────────────────

const PING_INTERVAL_MS = 25_000; // 25s — under nginx's 60s default

interface TerminalSession {
  id: string;
  pty: ReturnType<typeof pty.spawn>;
  ws: WebSocket;
  idleTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  alive: boolean;
  createdAt: number;
}

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

// ── State ─────────────────────────────────────────────────────────

const sessions = new Map<string, TerminalSession>();
let sessionCounter = 0;

// ── Public API ────────────────────────────────────────────────────

export function initTerminalServer(
  httpServer: Server,
  authFn: (token: string) => boolean,
): void {
  const wss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade → WebSocket
  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname, query } = parseUrl(req.url || "", true);

    if (pathname !== "/api/terminal") return; // let other upgrade handlers (if any) handle it

    // Auth check
    const token = (query.token as string) || "";
    if (!token || !authFn(token)) {
      log("Terminal WebSocket auth failed", "terminal");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    // Session limit
    if (sessions.size >= MAX_SESSIONS) {
      log(`Terminal session limit reached (${MAX_SESSIONS})`, "terminal");
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  // Handle new WebSocket connections
  wss.on("connection", (ws: WebSocket) => {
    const id = `term-${++sessionCounter}`;
    log(`Terminal session ${id} connected (${sessions.size + 1}/${MAX_SESSIONS})`, "terminal");

    // Spawn PTY — default size, client will send resize immediately
    const shell = pty.spawn("/bin/bash", ["--login"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: "/var/www/scws",
      env: {
        HOME: process.env.HOME || "/home/codeman",
        TERM: "xterm-256color",
        PATH: `${process.env.HOME || "/home/codeman"}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin`,
        LANG: process.env.LANG || "en_US.UTF-8",
        SHELL: "/bin/bash",
        USER: process.env.USER || "codeman",
      },
    });

    const session: TerminalSession = {
      id,
      pty: shell,
      ws,
      idleTimer: null,
      pingTimer: null,
      alive: true,
      createdAt: Date.now(),
    };

    sessions.set(id, session);
    resetIdleTimer(session);

    // Keepalive: ping every 25s to prevent nginx/proxy from dropping the connection
    ws.on("pong", () => { session.alive = true; });
    session.pingTimer = setInterval(() => {
      if (!session.alive) {
        log(`Terminal session ${id} ping timeout — closing`, "terminal");
        ws.terminate();
        return;
      }
      session.alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, PING_INTERVAL_MS);

    // PTY output → WebSocket
    shell.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    shell.onExit(({ exitCode }: { exitCode: number }) => {
      log(`Terminal session ${id} PTY exited (code ${exitCode})`, "terminal");
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
        ws.close();
      }
      cleanup(id);
    });

    // WebSocket messages → PTY
    ws.on("message", (raw: Buffer | string) => {
      try {
        const msg: ClientMessage = JSON.parse(
          typeof raw === "string" ? raw : raw.toString(),
        );

        switch (msg.type) {
          case "input":
            shell.write(msg.data);
            resetIdleTimer(session);
            break;
          case "resize":
            if (msg.cols > 0 && msg.rows > 0) {
              shell.resize(msg.cols, msg.rows);
            }
            break;
        }
      } catch {
        // Invalid message — ignore
      }
    });

    ws.on("close", () => {
      log(`Terminal session ${id} WebSocket closed`, "terminal");
      cleanup(id);
    });

    ws.on("error", (err: Error) => {
      log(`Terminal session ${id} error: ${err.message}`, "terminal");
      cleanup(id);
    });
  });

  log("Terminal WebSocket server initialized on /api/terminal", "startup");
}

/**
 * Get count of active terminal sessions (for status bar).
 */
export function getActiveTerminalCount(): number {
  return sessions.size;
}

/**
 * Clean up all terminal sessions (for graceful shutdown).
 */
export function shutdownTerminals(): void {
  for (const [id] of sessions) {
    cleanup(id);
  }
}

// ── Internal helpers ──────────────────────────────────────────────

function cleanup(id: string): void {
  const session = sessions.get(id);
  if (!session) return;

  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.pingTimer) clearInterval(session.pingTimer);

  try { session.pty.kill(); } catch { /* already dead */ }
  try {
    if (session.ws.readyState === WebSocket.OPEN) session.ws.close();
  } catch { /* ignore */ }

  sessions.delete(id);
  log(`Terminal session ${id} cleaned up (${sessions.size} remaining)`, "terminal");
}

function resetIdleTimer(session: TerminalSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    log(`Terminal session ${session.id} idle timeout`, "terminal");
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        type: "output",
        data: "\r\n\x1b[33m[Session timed out after 30 minutes of inactivity]\x1b[0m\r\n",
      }));
      session.ws.close();
    }
    cleanup(session.id);
  }, IDLE_TIMEOUT_MS);
}
