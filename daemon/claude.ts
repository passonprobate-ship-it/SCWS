import { spawn, type ChildProcess } from "child_process";
import type { Response } from "express";
import { storage } from "./storage.js";
import { log } from "./logger.js";

const PROJECTS_DIR = "/var/www/scws/projects";
const CLAUDE_PATH = "/root/.local/bin/claude";

// ── Types ────────────────────────────────────────────────────────

export interface StartClaudeOpts {
  projectName?: string;   // omit for system-level runs
  projectId?: string;
  prompt: string;
  mode?: "plan" | "build";
  continueSession?: string;
  maxTurns?: number;
}

export interface ActiveRunInfo {
  runId: string;
  projectName: string | null;
  status: "running" | "completed" | "failed";
  startTime: number;
  elapsed: number;
  mode: string;
  promptSnippet: string;
}

interface ActiveRun {
  process: ChildProcess;
  runId: string;
  projectName: string | null;
  projectId: string | null;
  mode: string;
  prompt: string;
  buffer: string[];           // accumulated SSE data strings
  listeners: Set<Response>;   // SSE connections watching this run
  startTime: number;
  status: "running" | "completed" | "failed";
  fullOutput: string;         // accumulated text output
  sessionId: string | null;
}

// ── State ────────────────────────────────────────────────────────

const activeRunsByRunId = new Map<string, ActiveRun>();
const projectLocks = new Set<string>();

// ── Public API ───────────────────────────────────────────────────

/**
 * Start a Claude CLI run. Returns { runId } immediately.
 * Callers subscribe to SSE via subscribeToRun().
 */
export async function startClaudeRun(opts: StartClaudeOpts): Promise<{ runId: string }> {
  const { projectName, projectId, prompt, mode = "build", continueSession, maxTurns } = opts;

  // Prevent concurrent runs on same project
  if (projectName && projectLocks.has(projectName)) {
    throw new Error(`Claude is already running on project "${projectName}". Wait for it to finish.`);
  }
  if (projectName) projectLocks.add(projectName);

  // Create DB record
  const run = await storage.createClaudeRun({
    projectId: projectId || "",
    projectName: projectName || null,
    prompt,
    status: "running",
    mode,
  });

  const args: string[] = ["-p", prompt, "--output-format", "stream-json", "--verbose"];

  if (mode === "build") {
    args.push("--allowedTools", "Bash,Read,Edit,Write,Glob,Grep");
  }
  if (continueSession) {
    args.push("--resume", continueSession);
  }
  if (maxTurns) {
    args.push("--max-turns", String(maxTurns));
  }

  const cwd = projectName ? `${PROJECTS_DIR}/${projectName}` : "/var/www/scws";
  log(`Starting Claude [${mode}] on "${projectName || 'system'}": ${prompt.substring(0, 100)}...`, "claude");

  // Use `script` to allocate a PTY — without this, the Claude CLI
  // block-buffers stdout when it detects it's a pipe (not a TTY).
  // `stdbuf` doesn't work because Claude CLI is a statically-linked binary.
  // `script -qec "cmd" /dev/null` allocates a PTY and relays stdout.
  const scriptCmd = [CLAUDE_PATH, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const child = spawn("script", ["-qec", scriptCmd, "/dev/null"], {
    cwd,
    env: { ...process.env, HOME: "/root", PATH: `${process.env.PATH}:/root/.local/bin` },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 600_000,
  });

  const activeRun: ActiveRun = {
    process: child,
    runId: run.id,
    projectName: projectName || null,
    projectId: projectId || null,
    mode,
    prompt,
    buffer: [],
    listeners: new Set(),
    startTime: Date.now(),
    status: "running",
    fullOutput: "",
    sessionId: null,
  };

  activeRunsByRunId.set(run.id, activeRun);

  // ── Handle stdout (stream-json: newline-delimited JSON) ──
  let lineBuf = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    // Strip \r added by PTY (script command) and any ANSI escape sequences
    lineBuf += chunk.toString().replace(/\r/g, "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() || ""; // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        processStreamEvent(activeRun, obj);
      } catch {
        // Not valid JSON — send as raw text
        const sseData = JSON.stringify({ type: "text", text: line });
        broadcast(activeRun, sseData);
      }
    }
  });

  // ── Handle stderr ──
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      const sseData = JSON.stringify({ type: "stderr", text });
      broadcast(activeRun, sseData);
    }
  });

  // ── Handle close ──
  child.on("close", async (code) => {
    // Flush remaining buffer
    if (lineBuf.trim()) {
      try {
        const obj = JSON.parse(lineBuf);
        processStreamEvent(activeRun, obj);
      } catch {
        const sseData = JSON.stringify({ type: "text", text: lineBuf });
        broadcast(activeRun, sseData);
      }
    }

    const duration = Date.now() - activeRun.startTime;
    activeRun.status = code === 0 ? "completed" : "failed";

    // Send done event to all listeners
    const doneData = JSON.stringify({
      type: "done",
      status: activeRun.status,
      sessionId: activeRun.sessionId,
      duration,
      exitCode: code,
    });
    broadcast(activeRun, doneData);

    // Close all SSE connections
    for (const res of activeRun.listeners) {
      try { res.end(); } catch { /* ignore */ }
    }
    activeRun.listeners.clear();

    // Update DB
    await storage.updateClaudeRun(run.id, {
      output: activeRun.fullOutput || null,
      sessionId: activeRun.sessionId,
      status: activeRun.status,
      duration,
    });

    await storage.logActivity({
      projectId: projectId || undefined,
      action: activeRun.status === "completed" ? "claude_run" : "claude_failed",
      details: `[${mode}] ${prompt.substring(0, 200)} (${Math.round(duration / 1000)}s)`,
    });

    log(`Claude ${activeRun.status} on "${projectName || 'system'}" in ${Math.round(duration / 1000)}s`, "claude");

    // Cleanup
    activeRunsByRunId.delete(run.id);
    if (projectName) projectLocks.delete(projectName);
  });

  child.on("error", async (err) => {
    const duration = Date.now() - activeRun.startTime;
    activeRun.status = "failed";

    const errData = JSON.stringify({ type: "error", text: err.message });
    broadcast(activeRun, errData);

    const doneData = JSON.stringify({ type: "done", status: "failed", duration, error: err.message });
    broadcast(activeRun, doneData);

    for (const res of activeRun.listeners) {
      try { res.end(); } catch { /* ignore */ }
    }
    activeRun.listeners.clear();

    await storage.updateClaudeRun(run.id, {
      output: err.message,
      status: "failed",
      duration,
    });

    activeRunsByRunId.delete(run.id);
    if (projectName) projectLocks.delete(projectName);
  });

  return { runId: run.id };
}

/**
 * Subscribe a response to receive SSE events from a run.
 * Replays buffered events, then streams live.
 */
export function subscribeToRun(runId: string, res: Response): boolean {
  const run = activeRunsByRunId.get(runId);

  // If run is not active, check if it's a completed run in DB
  if (!run) {
    return false; // caller should check DB for completed run
  }

  // Set SSE headers and force flush
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  // Send initial comment to establish connection
  res.write(":ok\n\n");

  // Replay buffer
  for (const data of run.buffer) {
    res.write(`data: ${data}\n\n`);
  }

  // If already done, send done event and close
  if (run.status !== "running") {
    const doneData = JSON.stringify({
      type: "done",
      status: run.status,
      sessionId: run.sessionId,
      duration: Date.now() - run.startTime,
    });
    res.write(`data: ${doneData}\n\n`);
    res.end();
    return true;
  }

  // Add to live listeners
  run.listeners.add(res);

  // Cleanup on disconnect
  res.on("close", () => {
    run.listeners.delete(res);
  });

  return true;
}

/**
 * Abort a running Claude process.
 */
export function abortRun(runId: string): boolean {
  const run = activeRunsByRunId.get(runId);
  if (!run || run.status !== "running") return false;

  log(`Aborting Claude run ${runId}`, "claude");
  run.process.kill("SIGTERM");

  // Give it 5s then SIGKILL
  setTimeout(() => {
    if (activeRunsByRunId.has(runId)) {
      run.process.kill("SIGKILL");
    }
  }, 5000);

  return true;
}

/**
 * Get info about all currently active runs.
 */
export function getActiveRuns(): ActiveRunInfo[] {
  const runs: ActiveRunInfo[] = [];
  for (const run of activeRunsByRunId.values()) {
    runs.push({
      runId: run.runId,
      projectName: run.projectName,
      status: run.status,
      startTime: run.startTime,
      elapsed: Date.now() - run.startTime,
      mode: run.mode,
      promptSnippet: run.prompt.substring(0, 100),
    });
  }
  return runs;
}

/**
 * Check if a project has an active Claude run.
 */
export function isProjectBusy(projectName: string): boolean {
  return projectLocks.has(projectName);
}

/**
 * Backward-compatible blocking wrapper.
 * Starts a run and waits for it to complete.
 */
export async function runClaude(opts: StartClaudeOpts & { projectId: string; projectName: string }): Promise<{
  runId: string;
  output: string | null;
  sessionId: string | null;
  status: string;
  duration: number;
}> {
  const { runId } = await startClaudeRun(opts);

  return new Promise((resolve, reject) => {
    const checkInterval = setInterval(async () => {
      const run = activeRunsByRunId.get(runId);
      if (!run || run.status !== "running") {
        clearInterval(checkInterval);
        const dbRun = await storage.getClaudeRun(runId);
        if (dbRun) {
          resolve({
            runId: dbRun.id,
            output: dbRun.output,
            sessionId: dbRun.sessionId,
            status: dbRun.status,
            duration: dbRun.duration || 0,
          });
        } else {
          reject(new Error("Run record not found"));
        }
      }
    }, 1000);

    // Safety timeout
    setTimeout(() => {
      clearInterval(checkInterval);
      reject(new Error("Timed out waiting for Claude run"));
    }, 620_000);
  });
}

// ── Internal helpers ──────────────────────────────────────────────

function processStreamEvent(run: ActiveRun, obj: Record<string, unknown>) {
  const type = obj.type as string;

  // Extract text content for fullOutput accumulation
  if (type === "assistant") {
    const message = obj.message as Record<string, unknown> | undefined;
    if (message) {
      const content = message.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            run.fullOutput += block.text;
          }
        }
      }
    }
  }

  // Extract session_id from result events
  if (type === "result") {
    const sessionId = obj.session_id as string | undefined;
    if (sessionId) run.sessionId = sessionId;
    const result = obj.result as string | undefined;
    if (result && !run.fullOutput) run.fullOutput = result;
  }

  const sseData = JSON.stringify(obj);
  broadcast(run, sseData);
}

function broadcast(run: ActiveRun, data: string) {
  run.buffer.push(data);

  for (const res of run.listeners) {
    try {
      res.write(`data: ${data}\n\n`);
      (res as any).flush?.();
    } catch {
      run.listeners.delete(res);
    }
  }
}
