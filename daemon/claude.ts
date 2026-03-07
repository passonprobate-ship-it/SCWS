import { spawn, type ChildProcess } from "child_process";
import { writeFile, rm } from "fs/promises";
import type { Response } from "express";
import { storage } from "./storage.js";
import { log } from "./logger.js";
import { readClaudeSettings, type McpServerConfig } from "./mcp.js";
import { notify } from "./notifications.js";

const PROJECTS_DIR = "/var/www/scws/projects";
const USER_HOME = process.env.HOME || "/home/codeman";
const CLAUDE_PATH = `${USER_HOME}/.local/bin/claude`;

// ── Types ────────────────────────────────────────────────────────

export interface StartClaudeOpts {
  projectName?: string;
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
  buffer: string[];
  listeners: Set<Response>;
  startTime: number;
  status: "running" | "completed" | "failed";
  fullOutput: string;
  sessionId: string | null;
}

// ── State ────────────────────────────────────────────────────────

const activeRunsByRunId = new Map<string, ActiveRun>();
const projectLocks = new Set<string>();

// ── Public API ───────────────────────────────────────────────────

export async function startClaudeRun(opts: StartClaudeOpts): Promise<{ runId: string }> {
  const { projectName, projectId, prompt, mode = "build", continueSession, maxTurns } = opts;

  if (projectName && projectLocks.has(projectName)) {
    throw new Error(`Claude is already running on project "${projectName}". Wait for it to finish.`);
  }
  if (projectName) projectLocks.add(projectName);

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

  // Per-project MCP overrides
  let mcpTmpConfig: string | null = null;
  if (projectName) {
    const overrideJson = await storage.getConfig(`mcp-override:${projectName}`);
    if (overrideJson) {
      try {
        const override = JSON.parse(overrideJson);
        const settings = await readClaudeSettings();
        const allServers = settings.mcpServers || {};
        const filtered: Record<string, McpServerConfig> = {};
        for (const [name, enabled] of Object.entries(override.servers as Record<string, boolean>)) {
          if (enabled && allServers[name]) {
            filtered[name] = allServers[name];
          }
        }
        mcpTmpConfig = `/tmp/mcp-config-${run.id}.json`;
        await writeFile(mcpTmpConfig, JSON.stringify({ mcpServers: filtered }));
        args.push("--mcp-config", mcpTmpConfig);
        log(`Using per-project MCP config (${Object.keys(filtered).length} servers)`, "claude");
      } catch (err: any) {
        log(`Failed to build MCP config: ${err.message}`, "claude");
      }
    }
  }

  const cwd = projectName ? `${PROJECTS_DIR}/${projectName}` : "/var/www/scws";
  log(`Starting Claude [${mode}] on "${projectName || 'system'}": ${prompt.substring(0, 100)}...`, "claude");

  const scriptCmd = [CLAUDE_PATH, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const child = spawn("script", ["-qec", scriptCmd, "/dev/null"], {
    cwd,
    env: { ...process.env, HOME: USER_HOME, PATH: `${process.env.PATH}:${USER_HOME}/.local/bin` },
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

  let lineBuf = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    lineBuf += chunk.toString().replace(/\r/g, "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        processStreamEvent(activeRun, obj);
      } catch {
        const sseData = JSON.stringify({ type: "text", text: line });
        broadcast(activeRun, sseData);
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      const sseData = JSON.stringify({ type: "stderr", text });
      broadcast(activeRun, sseData);
    }
  });

  child.on("close", async (code) => {
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

    const doneData = JSON.stringify({
      type: "done",
      status: activeRun.status,
      sessionId: activeRun.sessionId,
      duration,
      exitCode: code,
    });
    broadcast(activeRun, doneData);

    for (const res of activeRun.listeners) {
      try { res.end(); } catch { /* ignore */ }
    }
    activeRun.listeners.clear();

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

    const notifyEvent = activeRun.status === "completed" ? "claude_completed" : "claude_failed";
    notify(notifyEvent, `Claude ${activeRun.status} on "${projectName || "system"}" (${Math.round(duration / 1000)}s)`).catch(() => {});

    log(`Claude ${activeRun.status} on "${projectName || 'system'}" in ${Math.round(duration / 1000)}s`, "claude");

    activeRunsByRunId.delete(run.id);
    if (projectName) projectLocks.delete(projectName);
    if (mcpTmpConfig) rm(mcpTmpConfig, { force: true }).catch(() => {});
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

export function subscribeToRun(runId: string, res: Response): boolean {
  const run = activeRunsByRunId.get(runId);
  if (!run) return false;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(":ok\n\n");

  for (const data of run.buffer) {
    res.write(`data: ${data}\n\n`);
  }

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

  run.listeners.add(res);
  res.on("close", () => { run.listeners.delete(res); });
  return true;
}

export function abortRun(runId: string): boolean {
  const run = activeRunsByRunId.get(runId);
  if (!run || run.status !== "running") return false;

  log(`Aborting Claude run ${runId}`, "claude");
  run.process.kill("SIGTERM");

  setTimeout(() => {
    if (activeRunsByRunId.has(runId)) {
      run.process.kill("SIGKILL");
    }
  }, 5000);

  return true;
}

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

export function isProjectBusy(projectName: string): boolean {
  return projectLocks.has(projectName);
}

// ── Internal helpers ──────────────────────────────────────────────

function processStreamEvent(run: ActiveRun, obj: Record<string, unknown>) {
  const type = obj.type as string;

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
