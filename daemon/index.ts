import express, { type Request, type Response, type NextFunction } from "express";
import { createServer } from "http";
import { createHash, timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { storage } from "./storage.js";

// CJS build provides __dirname. For ESM dev mode, derive it. esbuild warning is harmless.
const _dirname = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
import { pool } from "./db.js";
import { log } from "./logger.js";
import { asyncHandler } from "./asyncHandler.js";
import {
  createProject, startProject, stopProject, restartProject,
  buildProject, deleteProject, getProjectLogs, importFromUrl,
} from "./projects.js";
import { runClaude, startClaudeRun, subscribeToRun, abortRun, getActiveRuns } from "./claude.js";
import { initRepo, cloneRepo, pushToGithub, pullFromGithub } from "./github.js";
import { deployProject } from "./deploy.js";
import { initTerminalServer, shutdownTerminals } from "./terminal.js";
import {
  readClaudeSettings, writeClaudeSettings, sanitizeAllServers,
  testMcpConnection, listMcpTools, type McpServerConfig,
} from "./mcp.js";
import {
  sanitizeChannelConfig, validateTelegramBot, sendTelegramMessage,
  validateEmailConfig, testChannel, getDefaultNotificationRules,
} from "./channels.js";

// ── Express setup ─────────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);

app.use(express.json({ limit: "1mb" }));

// CORS + security headers
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.header("X-Content-Type-Options", "nosniff");
  res.header("X-Frame-Options", "DENY");
  next();
});

app.options("/{*path}", (_req: Request, res: Response) => res.status(200).end());

// Request logger
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    if (!req.path.startsWith("/health")) {
      log(`${req.method} ${req.path} ${res.statusCode} in ${Date.now() - start}ms`, "http");
    }
  });
  next();
});

// ── Auth ──────────────────────────────────────────────────────────

const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "";
if (!DASHBOARD_TOKEN) {
  log("FATAL: DASHBOARD_TOKEN is not set — refusing to start", "startup");
  process.exit(1);
}

function safeEqual(a: string, b: string): boolean {
  const hA = createHash("sha256").update(a).digest();
  const hB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hA, hB);
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Support both Bearer header and query param (for SSE/EventSource which can't set headers)
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : queryToken;

  if (!token) {
    res.status(401).json({ error: "Missing authorization header" });
    return;
  }
  if (!safeEqual(token, DASHBOARD_TOKEN)) {
    res.status(403).json({ error: "Invalid token" });
    return;
  }
  next();
}

// ── Param helper (Express 5 params are string | string[]) ─────────

function param(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? v[0] : v;
}

// ── Terminal WebSocket server ─────────────────────────────────────
initTerminalServer(httpServer, (token) => safeEqual(token, DASHBOARD_TOKEN));

// ── Health check (no auth) ────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ── Dashboard ─────────────────────────────────────────────────────

app.get("/", (_req: Request, res: Response) => {
  try {
    const html = readFileSync(join(_dirname, "dashboard.html"), "utf-8");
    res.type("html").send(html);
  } catch {
    res.status(404).send("Dashboard not found");
  }
});

// ── Protected API routes ──────────────────────────────────────────

app.use("/api", requireAuth);

// ── Projects ──────────────────────────────────────────────────────

app.get("/api/projects", asyncHandler("List projects", async (_req, res) => {
  const list = await storage.getProjects();
  res.json(list);
}));

app.post("/api/projects", asyncHandler("Create project", async (req, res) => {
  const { name, displayName, framework, gitRepo, needsDb, description } = req.body;
  if (!name || !displayName) {
    res.status(400).json({ error: "name and displayName are required" });
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(name)) {
    res.status(400).json({ error: "name must be lowercase alphanumeric with hyphens" });
    return;
  }
  const project = await createProject({
    name,
    displayName,
    description: description || "",
    framework: framework || "express",
    gitRepo: gitRepo || undefined,
    needsDb: needsDb ?? false,
  });
  res.status(201).json(project);
}));

app.get("/api/projects/:name", asyncHandler("Get project", async (req, res) => {
  const project = await storage.getProject(param(req, "name"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  res.json(project);
}));

app.patch("/api/projects/:name", asyncHandler("Update project", async (req, res) => {
  const project = await storage.updateProject(param(req, "name"), req.body);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  res.json(project);
}));

app.delete("/api/projects/:name", asyncHandler("Delete project", async (req, res) => {
  await deleteProject(param(req, "name"));
  res.json({ ok: true });
}));

app.post("/api/projects/:name/start", asyncHandler("Start project", async (req, res) => {
  await startProject(param(req, "name"));
  res.json({ ok: true });
}));

app.post("/api/projects/:name/stop", asyncHandler("Stop project", async (req, res) => {
  await stopProject(param(req, "name"));
  res.json({ ok: true });
}));

app.post("/api/projects/:name/restart", asyncHandler("Restart project", async (req, res) => {
  await restartProject(param(req, "name"));
  res.json({ ok: true });
}));

app.post("/api/projects/:name/build", asyncHandler("Build project", async (req, res) => {
  const result = await buildProject(param(req, "name"));
  res.json(result);
}));

app.get("/api/projects/:name/logs", asyncHandler("Get project logs", async (req, res) => {
  const lines = parseInt(req.query.lines as string) || 50;
  const logs = await getProjectLogs(param(req, "name"), lines);
  res.json({ logs });
}));

// ── Claude CLI ────────────────────────────────────────────────────

app.post("/api/projects/:name/claude", asyncHandler("Run Claude", async (req, res) => {
  const { prompt, mode } = req.body;
  if (!prompt) { res.status(400).json({ error: "prompt is required" }); return; }
  const project = await storage.getProject(param(req, "name"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = await runClaude({
    projectName: param(req, "name"),
    projectId: project.id,
    prompt,
    mode: mode || "build",
  });
  res.json(result);
}));

app.get("/api/projects/:name/claude/runs", asyncHandler("List Claude runs", async (req, res) => {
  const project = await storage.getProject(param(req, "name"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const limit = parseInt(req.query.limit as string) || 20;
  const runs = await storage.listClaudeRuns(project.id, limit);
  res.json(runs);
}));

app.get("/api/projects/:name/claude/runs/:runId", asyncHandler("Get Claude run", async (req, res) => {
  const run = await storage.getClaudeRun(param(req, "runId"));
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  res.json(run);
}));

// ── GitHub ────────────────────────────────────────────────────────

app.post("/api/projects/:name/github/init", asyncHandler("Init GitHub repo", async (req, res) => {
  const { repoName, isPrivate } = req.body;
  await initRepo(param(req, "name"), repoName, isPrivate ?? true);
  res.json({ ok: true });
}));

app.post("/api/projects/:name/github/clone", asyncHandler("Clone repo", async (req, res) => {
  const { repoUrl } = req.body;
  if (!repoUrl) { res.status(400).json({ error: "repoUrl is required" }); return; }
  await cloneRepo(repoUrl, param(req, "name"));
  res.json({ ok: true });
}));

app.post("/api/projects/:name/github/push", asyncHandler("Push to GitHub", async (req, res) => {
  const { message } = req.body;
  await pushToGithub(param(req, "name"), message);
  res.json({ ok: true });
}));

app.post("/api/projects/:name/github/pull", asyncHandler("Pull from GitHub", async (req, res) => {
  await pullFromGithub(param(req, "name"));
  res.json({ ok: true });
}));

// ── Deploy ────────────────────────────────────────────────────────

app.post("/api/projects/:name/deploy", asyncHandler("Deploy project", async (req, res) => {
  const { targetName } = req.body;
  if (!targetName) { res.status(400).json({ error: "targetName is required" }); return; }
  await deployProject(param(req, "name"), targetName);
  res.json({ ok: true });
}));

// ── Live Log Streaming (SSE) ─────────────────────────────────────

app.get("/api/projects/:name/logs/stream", (req: Request, res: Response) => {
  // Auth check (SSE can't use custom headers from EventSource)
  const authToken = req.headers.authorization?.slice(7) || (req.query.token as string);
  if (!authToken || !safeEqual(authToken, DASHBOARD_TOKEN)) {
    res.status(403).json({ error: "Unauthorized" });
    return;
  }

  const projectName = param(req, "name");
  const pm2Name = `scws-${projectName}`;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const { spawn: sp } = require("child_process");
  const tail = sp("pm2", ["logs", pm2Name, "--raw", "--lines", "50"], {
    env: { ...process.env, HOME: process.env.HOME || "/home/codeman" },
  });

  tail.stdout?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter((l: string) => l.trim());
    for (const line of lines) {
      res.write(`data: ${JSON.stringify({ type: "log", text: line })}\n\n`);
    }
  });

  tail.stderr?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter((l: string) => l.trim());
    for (const line of lines) {
      res.write(`data: ${JSON.stringify({ type: "error", text: line })}\n\n`);
    }
  });

  tail.on("close", () => {
    try { res.end(); } catch { /* ignore */ }
  });

  req.on("close", () => {
    tail.kill("SIGTERM");
  });
});

// ── Global Claude Terminal ────────────────────────────────────────

app.post("/api/claude/run", asyncHandler("Start Claude run", async (req, res) => {
  const { projectName, prompt, mode, continueSession, maxTurns } = req.body;
  if (!prompt) { res.status(400).json({ error: "prompt is required" }); return; }

  let projectId: string | undefined;
  if (projectName) {
    const project = await storage.getProject(projectName);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    projectId = project.id;
  }

  const { runId } = await startClaudeRun({
    projectName: projectName || undefined,
    projectId,
    prompt,
    mode: mode || "build",
    continueSession,
    maxTurns,
  });

  res.status(201).json({ runId });
}));

app.get("/api/claude/stream/:runId", (req: Request, res: Response) => {
  // Auth check (EventSource can't send custom headers)
  const authToken = req.headers.authorization?.slice(7) || (req.query.token as string);
  if (!authToken || !safeEqual(authToken, DASHBOARD_TOKEN)) {
    res.status(403).json({ error: "Unauthorized" });
    return;
  }

  const runId = param(req, "runId");
  const subscribed = subscribeToRun(runId, res);

  if (!subscribed) {
    // Run is not active — return completed run from DB
    storage.getClaudeRun(runId).then(run => {
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      // Send as SSE with replay
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (run.output) {
        res.write(`data: ${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: run.output }] } })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: "done", status: run.status, sessionId: run.sessionId, duration: run.duration })}\n\n`);
      res.end();
    }).catch(() => {
      res.status(500).json({ error: "Failed to fetch run" });
    });
  }
});

app.post("/api/claude/abort/:runId", asyncHandler("Abort Claude run", async (req, res) => {
  const success = abortRun(param(req, "runId"));
  if (!success) { res.status(404).json({ error: "No active run found" }); return; }
  res.json({ ok: true });
}));

app.get("/api/claude/active", asyncHandler("Get active Claude runs", async (_req, res) => {
  res.json(getActiveRuns());
}));

app.get("/api/claude/runs", asyncHandler("List all Claude runs", async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;
  const runs = await storage.listAllClaudeRuns(limit, offset);
  res.json(runs);
}));

app.get("/api/claude/runs/:runId", asyncHandler("Get Claude run", async (req, res) => {
  const run = await storage.getClaudeRun(param(req, "runId"));
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  res.json(run);
}));

app.get("/api/claude/sessions", asyncHandler("List Claude sessions", async (_req, res) => {
  const sessions = await storage.listClaudeSessions();
  res.json(sessions);
}));

// ── Import from URL ──────────────────────────────────────────────

app.post("/api/import", asyncHandler("Import from URL", async (req, res) => {
  const { repoUrl } = req.body;
  if (!repoUrl) {
    res.status(400).json({ error: "repoUrl is required" });
    return;
  }
  const project = await importFromUrl(repoUrl);
  res.status(201).json(project);
}));

// ── GitHub Repos ─────────────────────────────────────────────────

app.get("/api/github/repos", asyncHandler("List GitHub repos", async (req, res) => {
  const { execFile: ef } = await import("child_process");
  const { promisify: p } = await import("util");
  const exec = p(ef);

  const limit = parseInt(req.query.limit as string) || 30;
  const { stdout } = await exec("gh", [
    "repo", "list", "--json", "name,url,description,isPrivate,updatedAt,primaryLanguage",
    "--limit", String(limit), "--sort", "updated",
  ], { timeout: 30_000 });

  res.json(JSON.parse(stdout));
}));

// ── MCP Server Management ────────────────────────────────────────

app.get("/api/mcp/servers", asyncHandler("List MCP servers", async (_req, res) => {
  const settings = await readClaudeSettings();
  const servers = settings.mcpServers || {};
  res.json({ servers: sanitizeAllServers(servers) });
}));

app.post("/api/mcp/servers", asyncHandler("Add MCP server", async (req, res) => {
  const { name, type, url, headers, command, args } = req.body;
  if (!name || !type) {
    res.status(400).json({ error: "name and type are required" });
    return;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    res.status(400).json({ error: "name must be alphanumeric with hyphens/underscores" });
    return;
  }

  const settings = await readClaudeSettings();
  if (!settings.mcpServers) settings.mcpServers = {};
  if (settings.mcpServers[name]) {
    res.status(409).json({ error: `Server "${name}" already exists` });
    return;
  }

  const config: McpServerConfig = { type };
  if (url) config.url = url;
  if (headers) config.headers = headers;
  if (command) config.command = command;
  if (args) config.args = args;

  settings.mcpServers[name] = config;
  await writeClaudeSettings(settings);
  res.status(201).json({ ok: true });
}));

app.patch("/api/mcp/servers/:name", asyncHandler("Edit MCP server", async (req, res) => {
  const name = param(req, "name");
  const settings = await readClaudeSettings();
  if (!settings.mcpServers?.[name]) {
    res.status(404).json({ error: `Server "${name}" not found` });
    return;
  }

  const existing = settings.mcpServers[name];
  const { type, url, headers, command, args } = req.body;

  if (type !== undefined) existing.type = type;
  if (url !== undefined) existing.url = url;
  if (command !== undefined) existing.command = command;
  if (args !== undefined) existing.args = args;

  // Headers: merge, preserving existing auth if new value is empty/masked
  if (headers && typeof headers === "object") {
    if (!existing.headers) existing.headers = {};
    for (const [key, val] of Object.entries(headers) as [string, string][]) {
      if (val && val !== "***" && val !== "Bearer ***") {
        existing.headers[key] = val;
      }
      // If blank or masked, keep existing value
    }
  }

  await writeClaudeSettings(settings);
  res.json({ ok: true });
}));

app.delete("/api/mcp/servers/:name", asyncHandler("Delete MCP server", async (req, res) => {
  const name = param(req, "name");
  const settings = await readClaudeSettings();
  if (!settings.mcpServers?.[name]) {
    res.status(404).json({ error: `Server "${name}" not found` });
    return;
  }
  delete settings.mcpServers[name];
  await writeClaudeSettings(settings);
  res.json({ ok: true });
}));

app.post("/api/mcp/servers/:name/test", asyncHandler("Test MCP server", async (req, res) => {
  const name = param(req, "name");
  const settings = await readClaudeSettings();
  const config = settings.mcpServers?.[name];
  if (!config) {
    res.status(404).json({ error: `Server "${name}" not found` });
    return;
  }
  const result = await testMcpConnection(config);
  res.json(result);
}));

app.get("/api/mcp/servers/:name/tools", asyncHandler("List MCP tools", async (req, res) => {
  const name = param(req, "name");
  const settings = await readClaudeSettings();
  const config = settings.mcpServers?.[name];
  if (!config) {
    res.status(404).json({ error: `Server "${name}" not found` });
    return;
  }
  const result = await listMcpTools(config);
  res.json(result);
}));

app.get("/api/mcp/config/project/:name", asyncHandler("Get project MCP config", async (req, res) => {
  const name = param(req, "name");
  const raw = await storage.getConfig(`mcp-override:${name}`);
  res.json(raw ? JSON.parse(raw) : { servers: {} });
}));

app.patch("/api/mcp/config/project/:name", asyncHandler("Set project MCP config", async (req, res) => {
  const name = param(req, "name");
  const { servers } = req.body;
  if (!servers || typeof servers !== "object") {
    res.status(400).json({ error: "servers object is required" });
    return;
  }
  await storage.setConfig(`mcp-override:${name}`, JSON.stringify({ servers }));
  res.json({ ok: true });
}));

// ── Channels ──────────────────────────────────────────────────────

app.get("/api/channels", asyncHandler("List channels", async (_req, res) => {
  const list = await storage.getChannels();
  const sanitized = list.map(ch => ({
    ...ch,
    config: JSON.stringify(sanitizeChannelConfig(ch.type, JSON.parse(ch.config))),
  }));
  res.json(sanitized);
}));

app.post("/api/channels", asyncHandler("Create channel", async (req, res) => {
  const { type, name, config } = req.body;
  if (!type || !name) { res.status(400).json({ error: "type and name required" }); return; }
  if (!["telegram", "email"].includes(type)) { res.status(400).json({ error: "Unsupported type" }); return; }

  const channelConfig = { ...config };

  if (type === "telegram") {
    if (!channelConfig.botToken) { res.status(400).json({ error: "botToken required" }); return; }
    const validation = await validateTelegramBot(channelConfig.botToken);
    if (!validation.ok) { res.status(400).json({ error: validation.error }); return; }
    channelConfig.botUsername = validation.username;
  }

  if (type === "email") {
    if (!channelConfig.apiKey || !channelConfig.inboxId || !channelConfig.recipientEmail) {
      res.status(400).json({ error: "apiKey, inboxId, and recipientEmail required" }); return;
    }
    const validation = await validateEmailConfig(channelConfig.apiKey, channelConfig.inboxId);
    if (!validation.ok) { res.status(400).json({ error: validation.error }); return; }
    channelConfig.inboxAddress = validation.address;
  }

  const channel = await storage.createChannel({
    type,
    name,
    config: JSON.stringify(channelConfig),
    enabled: 1,
    verified: type === "email" ? 1 : 0,
    status: type === "email" ? "connected" : "pending",
  });

  await storage.logActivity({ action: "channel_created", details: `Created ${type} channel "${name}"` });

  res.status(201).json({
    ...channel,
    config: JSON.stringify(sanitizeChannelConfig(type, channelConfig)),
  });
}));

app.patch("/api/channels/:id", asyncHandler("Update channel", async (req, res) => {
  const id = param(req, "id");
  const existing = await storage.getChannel(id);
  if (!existing) { res.status(404).json({ error: "Channel not found" }); return; }

  const updates: Record<string, unknown> = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;

  if (req.body.config) {
    const existingConfig = JSON.parse(existing.config);
    for (const [key, val] of Object.entries(req.body.config)) {
      if (val && typeof val === "string" && !val.startsWith("***")) {
        existingConfig[key] = val;
      }
    }
    updates.config = JSON.stringify(existingConfig);
  }

  const updated = await storage.updateChannel(id, updates as any);
  res.json({
    ...updated,
    config: JSON.stringify(sanitizeChannelConfig(existing.type, JSON.parse(updated!.config))),
  });
}));

app.delete("/api/channels/:id", asyncHandler("Delete channel", async (req, res) => {
  const id = param(req, "id");
  const existing = await storage.getChannel(id);
  if (!existing) { res.status(404).json({ error: "Channel not found" }); return; }
  await storage.deleteChannel(id);
  await storage.logActivity({ action: "channel_deleted", details: `Deleted ${existing.type} channel "${existing.name}"` });
  res.json({ ok: true });
}));

app.post("/api/channels/:id/test", asyncHandler("Test channel", async (req, res) => {
  const id = param(req, "id");
  const result = await testChannel(id);
  res.json(result);
}));

app.post("/api/channels/:id/verify-telegram", asyncHandler("Verify Telegram", async (req, res) => {
  const id = param(req, "id");
  const { chatId } = req.body;
  if (!chatId) { res.status(400).json({ error: "chatId required" }); return; }

  const channel = await storage.getChannel(id);
  if (!channel || channel.type !== "telegram") {
    res.status(404).json({ error: "Telegram channel not found" }); return;
  }

  const config = JSON.parse(channel.config);
  config.chatId = String(chatId);

  const result = await sendTelegramMessage(config.botToken, config.chatId, "<b>[SPAWN]</b> Connected! Notifications enabled.");
  if (!result.ok) { res.json({ ok: false, error: result.error }); return; }

  await storage.updateChannel(id, {
    config: JSON.stringify(config),
    verified: 1,
    status: "connected",
    lastTestedAt: new Date(),
  });

  res.json({ ok: true });
}));

app.get("/api/notifications", asyncHandler("List notifications", async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const list = await storage.getNotifications(limit);
  res.json(list);
}));

app.get("/api/channels/config/rules", asyncHandler("Get notification rules", async (_req, res) => {
  const raw = await storage.getConfig("notification-rules");
  res.json(raw ? JSON.parse(raw) : getDefaultNotificationRules());
}));

app.patch("/api/channels/config/rules", asyncHandler("Update notification rules", async (req, res) => {
  await storage.setConfig("notification-rules", JSON.stringify(req.body));
  res.json({ ok: true });
}));

app.get("/api/channels/mcp-proxy", asyncHandler("Proxy MCP channels", async (_req, res) => {
  const mcpUrl = await storage.getConfig("mcp-server-url");
  const mcpToken = await storage.getConfig("mcp-server-token");
  if (!mcpUrl || !mcpToken) { res.json({ channels: [], configured: false }); return; }
  try {
    const resp = await fetch(`${mcpUrl}/api/channels`, {
      headers: { Authorization: `Bearer ${mcpToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const channels = await resp.json();
    res.json({ channels, configured: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({ channels: [], configured: true, error: msg });
  }
}));

// ── System ────────────────────────────────────────────────────────

app.get("/api/system", asyncHandler("System info", async (_req, res) => {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const [diskResult, memResult, uptimeResult] = await Promise.allSettled([
    execFileAsync("df", ["-h", "/"]).then(r => r.stdout.trim()),
    execFileAsync("free", ["-m"]).then(r => r.stdout.trim()),
    execFileAsync("uptime", ["-p"]).then(r => r.stdout.trim()),
  ]);

  const projects = await storage.getProjects();
  const running = projects.filter(p => p.status === "running").length;

  res.json({
    disk: diskResult.status === "fulfilled" ? diskResult.value : null,
    memory: memResult.status === "fulfilled" ? memResult.value : null,
    uptime: uptimeResult.status === "fulfilled" ? uptimeResult.value : null,
    projects: { total: projects.length, running },
    daemon: { uptime: process.uptime(), pid: process.pid, nodeVersion: process.version },
  });
}));

app.get("/api/system/pm2", asyncHandler("PM2 process list", async (_req, res) => {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"], {
      timeout: 10_000,
      env: { ...process.env, HOME: process.env.HOME || "/home/codeman" },
    });
    const processes = JSON.parse(stdout).map((p: Record<string, unknown>) => {
      const env = (p.pm2_env || {}) as Record<string, unknown>;
      const monit = (p.monit || {}) as Record<string, unknown>;
      return {
        name: p.name,
        pid: env.pm_id,
        status: env.status,
        cpu: monit.cpu || 0,
        memory: monit.memory || 0,
        uptime: env.pm_uptime ? Date.now() - (env.pm_uptime as number) : 0,
        restarts: env.restart_time || 0,
      };
    });
    res.json(processes);
  } catch {
    res.json([]);
  }
}));

app.get("/api/activity", asyncHandler("Get activity", async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const activity = await storage.getActivity(limit);
  res.json(activity);
}));

// ── Start server ──────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "4000", 10);

httpServer.listen(PORT, "127.0.0.1", () => {
  log(`SPAWN daemon listening on 127.0.0.1:${PORT}`, "startup");
  log(`Dashboard at http://127.0.0.1:${PORT}`, "startup");
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  log("SIGTERM received, shutting down...", "shutdown");
  shutdownTerminals();
  httpServer.close();
  await pool.end();
  process.exit(0);
});

process.on("SIGINT", async () => {
  log("SIGINT received, shutting down...", "shutdown");
  shutdownTerminals();
  httpServer.close();
  await pool.end();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}`, "error");
  console.error(err.stack);
});

process.on("unhandledRejection", (reason) => {
  log(`Unhandled rejection: ${reason}`, "error");
});
