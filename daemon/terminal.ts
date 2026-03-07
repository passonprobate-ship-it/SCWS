import { type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseUrl } from "url";
import { existsSync } from "fs";
import { log } from "./logger.js";
import { storage } from "./storage.js";

// node-pty is a native module — must be required at runtime (not bundled by esbuild)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pty = require("node-pty");

// ── Config ────────────────────────────────────────────────────────

const MAX_SESSIONS = 3;
const MAX_CLAUDE_SESSIONS = 5;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const PING_INTERVAL_MS = 25_000;
const PROJECTS_DIR = "/var/www/scws/projects";

// ── Types ─────────────────────────────────────────────────────────

interface TerminalSession {
  id: string;
  pty: ReturnType<typeof pty.spawn>;
  ws: WebSocket;
  idleTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  alive: boolean;
  createdAt: number;
}

interface ClaudeSession extends TerminalSession {
  tool: "claude" | "opencode";
  projectName: string | null;
}

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

// ── State ─────────────────────────────────────────────────────────

const sessions = new Map<string, TerminalSession>();
const claudeSessions = new Map<string, ClaudeSession>();
let sessionCounter = 0;
let claudeSessionCounter = 0;
let opencodeSessionCounter = 0;

// Detect OpenCode binary
const HOME = process.env.HOME || "/home/codeman";
let opencodePath: string | null = null;
const _ocCandidates = [HOME + "/.opencode/bin/opencode", "/usr/local/bin/opencode"];
for (const _p of _ocCandidates) {
  if (existsSync(_p)) { opencodePath = _p; break; }
}

// ── Shell Terminal ────────────────────────────────────────────────

export function initTerminalServer(
  httpServer: Server,
  authFn: (token: string) => boolean,
): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname, query } = parseUrl(req.url || "", true);

    if (pathname === "/api/terminal") {
      const token = (query.token as string) || "";
      if (!token || !authFn(token)) {
        log("Terminal WebSocket auth failed", "terminal");
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      if (sessions.size >= MAX_SESSIONS) {
        log(`Terminal session limit reached (${MAX_SESSIONS})`, "terminal");
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleTerminalConnection(ws);
      });
    } else if (pathname === "/api/claude/terminal") {
      const token = (query.token as string) || "";
      if (!token || !authFn(token)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      if (claudeSessions.size >= MAX_CLAUDE_SESSIONS) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      const tool = (query.tool as string) === "opencode" ? "opencode" as const : "claude" as const;
      const projectName = (query.project as string) || null;
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleClaudeTerminalConnection(ws, tool, projectName);
      });
    }
  });

  log("Terminal WebSocket server initialized on /api/terminal + /api/claude/terminal", "startup");
}

function handleTerminalConnection(ws: WebSocket): void {
  const id = `term-${++sessionCounter}`;
  log(`Terminal session ${id} connected (${sessions.size + 1}/${MAX_SESSIONS})`, "terminal");

  const shell = pty.spawn("/bin/bash", ["--login"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: "/var/www/scws",
    env: {
      HOME,
      TERM: "xterm-256color",
      PATH: `${HOME}/.opencode/bin:${HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin`,
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
  resetIdleTimer(session, sessions);
  setupSessionHandlers(session, sessions);
}

// ── Claude/OpenCode Terminal ──────────────────────────────────────

function handleClaudeTerminalConnection(
  ws: WebSocket,
  tool: "claude" | "opencode",
  projectName: string | null,
): void {
  const id = tool + "-" + (tool === "opencode" ? ++opencodeSessionCounter : ++claudeSessionCounter);
  const toolLabel = tool === "opencode" ? "OpenCode" : "Claude";

  log(`${toolLabel} terminal ${id} connected for project "${projectName || "system"}"`, "terminal");

  let binPath: string;
  if (tool === "opencode") {
    if (!opencodePath) {
      ws.send(JSON.stringify({ type: "output", data: "\x1b[31mOpenCode not installed. Install it first.\x1b[0m\r\n" }));
      ws.close(4404, "OpenCode not found");
      return;
    }
    binPath = opencodePath;
  } else {
    binPath = HOME + "/.local/bin/claude";
  }

  const cwd = projectName ? `${PROJECTS_DIR}/${projectName}` : "/var/www/scws";

  const shell = pty.spawn(binPath, [], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd,
    env: {
      HOME,
      TERM: "xterm-256color",
      PATH: HOME + "/.opencode/bin:" + HOME + "/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin",
      LANG: process.env.LANG || "en_US.UTF-8",
      SHELL: "/bin/bash",
      USER: process.env.USER || "codeman",
      NODE_ENV: "production",
    },
  });

  const session: ClaudeSession = {
    id,
    pty: shell,
    ws,
    idleTimer: null,
    pingTimer: null,
    alive: true,
    createdAt: Date.now(),
    tool,
    projectName,
  };

  claudeSessions.set(id, session);
  resetIdleTimer(session, claudeSessions);
  setupSessionHandlers(session, claudeSessions);

  // Log the session start
  storage.logActivity({
    action: `${tool}_session`,
    details: `${toolLabel} interactive session started for "${projectName || "system"}"`,
  }).catch(() => {});
}

// ── Shared Handlers ──────────────────────────────────────────────

function setupSessionHandlers(session: TerminalSession, map: Map<string, TerminalSession>): void {
  const { id, ws } = session;
  const shell = session.pty;

  // Keepalive
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
    cleanupSession(id, map);
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
          resetIdleTimer(session, map);
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
    cleanupSession(id, map);
  });

  ws.on("error", (err: Error) => {
    log(`Terminal session ${id} error: ${err.message}`, "terminal");
    cleanupSession(id, map);
  });
}

// ── Public API ────────────────────────────────────────────────────

export function getActiveTerminalCount(): number {
  return sessions.size;
}

export function getClaudeSessionsList(): Array<{
  id: string;
  tool: string;
  projectName: string | null;
  createdAt: number;
  elapsed: number;
}> {
  const result: Array<{ id: string; tool: string; projectName: string | null; createdAt: number; elapsed: number }> = [];
  for (const s of claudeSessions.values()) {
    result.push({
      id: s.id,
      tool: s.tool,
      projectName: s.projectName,
      createdAt: s.createdAt,
      elapsed: Date.now() - s.createdAt,
    });
  }
  return result;
}

export function getTerminalSessionsList(): Array<{ id: string; createdAt: number }> {
  return Array.from(sessions.values()).map(s => ({ id: s.id, createdAt: s.createdAt }));
}

export function getCapabilities(): { opencode: boolean } {
  return { opencode: !!opencodePath };
}

export function shutdownTerminals(): void {
  for (const [id] of sessions) cleanupSession(id, sessions);
  for (const [id] of claudeSessions) cleanupSession(id, claudeSessions);
}

// ── Internal helpers ──────────────────────────────────────────────

function cleanupSession(id: string, map: Map<string, TerminalSession>): void {
  const session = map.get(id);
  if (!session) return;

  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.pingTimer) clearInterval(session.pingTimer);

  try { session.pty.kill(); } catch { /* already dead */ }
  try {
    if (session.ws.readyState === WebSocket.OPEN) session.ws.close();
  } catch { /* ignore */ }

  map.delete(id);
  log(`Terminal session ${id} cleaned up (${map.size} remaining)`, "terminal");
}

function resetIdleTimer(session: TerminalSession, map: Map<string, TerminalSession>): void {
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
    cleanupSession(session.id, map);
  }, IDLE_TIMEOUT_MS);
}
