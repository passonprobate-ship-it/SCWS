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
  outputBuffer: string[];
  detached: boolean;
}

interface ClaudeSession extends TerminalSession {
  tool: "claude" | "opencode";
  projectName: string | null;
  outputBuffer: string[];       // ring buffer of recent output for replay on reattach
  detached: boolean;            // true when WebSocket disconnected but pty still alive
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
      const reattachTermId = (query.session as string) || null;
      if (reattachTermId && sessions.has(reattachTermId)) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          reattachTerminalSession(ws, reattachTermId);
        });
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
      const reattachId = (query.session as string) || null;
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (reattachId && claudeSessions.has(reattachId)) {
          reattachClaudeSession(ws, reattachId);
        } else {
          handleClaudeTerminalConnection(ws, tool, projectName);
        }
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
    outputBuffer: [],
    detached: false,
  };

  sessions.set(id, session);
  resetIdleTimer(session, sessions);
  setupTerminalSessionHandlers(session);

  // Send session ID to client for reattach
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "session", id }));
  }
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
    outputBuffer: [],
    detached: false,
  };

  claudeSessions.set(id, session);
  resetIdleTimer(session, claudeSessions);
  setupClaudeSessionHandlers(session);

  // Log the session start
  storage.logActivity({
    action: `${tool}_session`,
    details: `${toolLabel} interactive session started for "${projectName || "system"}"`,
  }).catch(() => {});
}

// ── Claude Session Handlers (with detach/reattach support) ───────

const MAX_OUTPUT_BUFFER = 500; // lines to keep for replay
const DETACH_TIMEOUT_MS = 10 * 60 * 1000; // kill detached session after 10 min

function setupClaudeSessionHandlers(session: ClaudeSession): void {
  const { id } = session;
  const shell = session.pty;

  setupWsHandlers(session);

  // PTY output → WebSocket + buffer
  shell.onData((data: string) => {
    // Always buffer regardless of WebSocket state
    session.outputBuffer.push(data);
    if (session.outputBuffer.length > MAX_OUTPUT_BUFFER) {
      session.outputBuffer.splice(0, session.outputBuffer.length - MAX_OUTPUT_BUFFER);
    }
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  shell.onExit(({ exitCode }: { exitCode: number }) => {
    log(`Claude session ${id} PTY exited (code ${exitCode})`, "terminal");
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      session.ws.close();
    }
    cleanupSession(id, claudeSessions);
  });
}

function setupWsHandlers(session: ClaudeSession): void {
  const { id, ws } = session;
  const shell = session.pty;

  // Keepalive
  ws.on("pong", () => { session.alive = true; });
  if (session.pingTimer) clearInterval(session.pingTimer);
  session.pingTimer = setInterval(() => {
    if (!session.alive) {
      log(`Claude session ${id} ping timeout — detaching`, "terminal");
      detachClaudeSession(session);
      return;
    }
    session.alive = false;
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, PING_INTERVAL_MS);

  // WebSocket messages → PTY
  ws.on("message", (raw: Buffer | string) => {
    try {
      const msg: ClientMessage = JSON.parse(
        typeof raw === "string" ? raw : raw.toString(),
      );
      switch (msg.type) {
        case "input":
          shell.write(msg.data);
          resetIdleTimer(session, claudeSessions);
          break;
        case "resize":
          if (msg.cols > 0 && msg.rows > 0) shell.resize(msg.cols, msg.rows);
          break;
      }
    } catch { /* ignore */ }
  });

  ws.on("close", () => {
    log(`Claude session ${id} WebSocket closed — detaching (pty stays alive)`, "terminal");
    detachClaudeSession(session);
  });

  ws.on("error", (err: Error) => {
    log(`Claude session ${id} WS error: ${err.message} — detaching`, "terminal");
    detachClaudeSession(session);
  });

  // Send session ID to client
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "session", id, tool: session.tool }));
  }
}

function detachClaudeSession(session: ClaudeSession): void {
  if (session.detached) return;
  session.detached = true;
  if (session.pingTimer) { clearInterval(session.pingTimer); session.pingTimer = null; }
  try { if (session.ws.readyState === WebSocket.OPEN) session.ws.close(); } catch { /* ignore */ }
  log(`Claude session ${session.id} detached — pty alive, waiting for reattach`, "terminal");

  // Set a timeout to kill the session if nobody reattaches
  session.idleTimer = setTimeout(() => {
    if (session.detached && claudeSessions.has(session.id)) {
      log(`Claude session ${session.id} detach timeout — killing`, "terminal");
      cleanupSession(session.id, claudeSessions);
    }
  }, DETACH_TIMEOUT_MS);
}

function reattachClaudeSession(ws: WebSocket, sessionId: string): void {
  const session = claudeSessions.get(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: "output", data: "\x1b[31mSession not found\x1b[0m\r\n" }));
    ws.close(4404, "Session not found");
    return;
  }

  log(`Reattaching WebSocket to claude session ${sessionId}`, "terminal");

  // Clear detach timeout
  if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
  session.detached = false;
  session.alive = true;

  // Swap WebSocket
  const oldWs = session.ws;
  session.ws = ws;
  try { if (oldWs.readyState === WebSocket.OPEN) oldWs.close(); } catch { /* ignore */ }

  // Remove old WS listeners (they reference the old ws, new ones get set up below)
  oldWs.removeAllListeners();

  // Setup new WS handlers
  setupWsHandlers(session);

  // Replay buffered output
  if (session.outputBuffer.length > 0) {
    const replay = session.outputBuffer.join("");
    ws.send(JSON.stringify({ type: "replay", data: replay }));
  }

  resetIdleTimer(session, claudeSessions);
}

// ── Shell Terminal Handlers (with detach/reattach) ───────────────

function setupTerminalSessionHandlers(session: TerminalSession): void {
  const { id } = session;
  const shell = session.pty;

  setupTerminalWsHandlers(session);

  // PTY output → WebSocket + buffer
  shell.onData((data: string) => {
    session.outputBuffer.push(data);
    if (session.outputBuffer.length > MAX_OUTPUT_BUFFER) {
      session.outputBuffer.splice(0, session.outputBuffer.length - MAX_OUTPUT_BUFFER);
    }
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  shell.onExit(({ exitCode }: { exitCode: number }) => {
    log(`Terminal session ${id} PTY exited (code ${exitCode})`, "terminal");
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      session.ws.close();
    }
    cleanupSession(id, sessions);
  });
}

function setupTerminalWsHandlers(session: TerminalSession): void {
  const { id, ws } = session;
  const shell = session.pty;

  ws.on("pong", () => { session.alive = true; });
  if (session.pingTimer) clearInterval(session.pingTimer);
  session.pingTimer = setInterval(() => {
    if (!session.alive) {
      log(`Terminal session ${id} ping timeout — detaching`, "terminal");
      detachTerminalSession(session);
      return;
    }
    session.alive = false;
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, PING_INTERVAL_MS);

  ws.on("message", (raw: Buffer | string) => {
    try {
      const msg: ClientMessage = JSON.parse(
        typeof raw === "string" ? raw : raw.toString(),
      );
      switch (msg.type) {
        case "input":
          shell.write(msg.data);
          resetIdleTimer(session, sessions);
          break;
        case "resize":
          if (msg.cols > 0 && msg.rows > 0) shell.resize(msg.cols, msg.rows);
          break;
      }
    } catch { /* ignore */ }
  });

  ws.on("close", () => {
    log(`Terminal session ${id} WebSocket closed — detaching (pty stays alive)`, "terminal");
    detachTerminalSession(session);
  });

  ws.on("error", (err: Error) => {
    log(`Terminal session ${id} WS error: ${err.message} — detaching`, "terminal");
    detachTerminalSession(session);
  });
}

function detachTerminalSession(session: TerminalSession): void {
  if (session.detached) return;
  session.detached = true;
  if (session.pingTimer) { clearInterval(session.pingTimer); session.pingTimer = null; }
  try { if (session.ws.readyState === WebSocket.OPEN) session.ws.close(); } catch { /* ignore */ }
  log(`Terminal session ${session.id} detached — pty alive, waiting for reattach`, "terminal");

  session.idleTimer = setTimeout(() => {
    if (session.detached && sessions.has(session.id)) {
      log(`Terminal session ${session.id} detach timeout — killing`, "terminal");
      cleanupSession(session.id, sessions);
    }
  }, DETACH_TIMEOUT_MS);
}

function reattachTerminalSession(ws: WebSocket, sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: "output", data: "\x1b[31mSession not found\x1b[0m\r\n" }));
    ws.close(4404, "Session not found");
    return;
  }

  log(`Reattaching WebSocket to terminal session ${sessionId}`, "terminal");

  if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
  session.detached = false;
  session.alive = true;

  const oldWs = session.ws;
  session.ws = ws;
  try { if (oldWs.readyState === WebSocket.OPEN) oldWs.close(); } catch { /* ignore */ }
  oldWs.removeAllListeners();

  setupTerminalWsHandlers(session);

  // Replay buffered output
  if (session.outputBuffer.length > 0) {
    const replay = session.outputBuffer.join("");
    ws.send(JSON.stringify({ type: "replay", data: replay }));
  }

  // Send session ID
  ws.send(JSON.stringify({ type: "session", id: sessionId }));

  resetIdleTimer(session, sessions);
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
  pid: number | null;
  attached: boolean;
}> {
  const result: Array<{ id: string; tool: string; projectName: string | null; createdAt: number; elapsed: number; pid: number | null; attached: boolean }> = [];
  for (const s of claudeSessions.values()) {
    result.push({
      id: s.id,
      tool: s.tool,
      projectName: s.projectName,
      createdAt: s.createdAt,
      elapsed: Date.now() - s.createdAt,
      pid: s.pty?.pid ?? null,
      attached: s.ws?.readyState === WebSocket.OPEN,
    });
  }
  return result;
}

export function getTerminalSessionsList(): Array<{ id: string; createdAt: number; attached: boolean }> {
  return Array.from(sessions.values()).map(s => ({ id: s.id, createdAt: s.createdAt, attached: s.ws?.readyState === WebSocket.OPEN }));
}

export function getCapabilities(): { opencode: boolean } {
  return { opencode: !!opencodePath };
}

export function killClaudeSessionById(id: string): boolean {
  if (claudeSessions.has(id)) {
    cleanupSession(id, claudeSessions);
    return true;
  }
  if (sessions.has(id)) {
    cleanupSession(id, sessions);
    return true;
  }
  return false;
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
