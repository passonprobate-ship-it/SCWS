import express, { type Request, type Response, type NextFunction } from "express";
import { createServer } from "http";
import { createHash, timingSafeEqual, randomUUID } from "crypto";
import { readFileSync, existsSync } from "fs";
import { readFile, writeFile, readdir, stat, mkdir, rm, unlink } from "fs/promises";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";

import { pool } from "./db.js";
import { storage } from "./storage.js";
import { log } from "./logger.js";
import { asyncHandler } from "./asyncHandler.js";
import {
  createProject, startProject, stopProject, restartProject,
  buildProject, deleteProject, getProjectLogs, importFromUrl,
  ensureProjectExists, detectFramework, detectNeedsDb,
} from "./projects.js";
import { startClaudeRun, subscribeToRun, abortRun, getActiveRuns } from "./claude.js";
import { initRepo, cloneRepo, pushToGithub, pullFromGithub } from "./github.js";
import { deployProject } from "./deploy.js";
import { addProjectNginx } from "./nginx.js";
import {
  initTerminalServer, shutdownTerminals, getActiveTerminalCount,
  getClaudeSessionsList, getTerminalSessionsList, getCapabilities,
} from "./terminal.js";
import {
  readClaudeSettings, writeClaudeSettings, sanitizeAllServers,
  testMcpConnection, listMcpTools, type McpServerConfig,
} from "./mcp.js";
import {
  sanitizeChannelConfig, sanitizeError, validateTelegramBot, sendTelegramMessage,
  validateEmailConfig, validateWhatsApp, testChannel, getDefaultNotificationRules,
  notify,
} from "./notifications.js";
import { pm2List } from "./pm2.js";
import {
  startWatchdog, stopWatchdog, getWatchdogConfig, updateWatchdogConfig, getWatchdogStatus,
} from "./watchdog.js";
import { registerOnboardingRoutes } from "./onboarding.js";
import { registerConnectionsRoutes } from "./connections.js";
import { registerNetworkRoutes } from "./network.js";

const execFileAsync = promisify(execFile);

// CJS build provides __dirname. For ESM dev mode, derive it.
const _dirname = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));

const PROJECTS_DIR = "/var/www/scws/projects";
const USER_HOME = process.env.HOME || "/home/codeman";

// ── Express setup ─────────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);

// Skip JSON parsing for upload endpoints
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/api/upload-zip" || req.path === "/api/files/upload") return next();
  express.json({ limit: "1mb" })(req, res, next);
});

// CORS + security headers
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin || "";
  const allowedOrigins = [
    "http://100.89.2.95", "http://spawn.tail852587.ts.net",
    "http://localhost:4000", "http://127.0.0.1:4000",
  ];
  res.header("Access-Control-Allow-Origin", allowedOrigins.includes(origin) ? origin : allowedOrigins[0]);
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("X-Content-Type-Options", "nosniff");
  res.header("X-Frame-Options", "DENY");
  res.header("Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "connect-src 'self' ws: wss:; img-src 'self' data: blob:; font-src 'self' https://cdn.jsdelivr.net");
  next();
});

app.options("/{*path}", (_req: Request, res: Response) => res.status(200).end());

// ── Rate limiting ──
let _rateLimit: any;
try {
  _rateLimit = require("express-rate-limit").rateLimit;
} catch {
  try { _rateLimit = require("express-rate-limit"); } catch { /* not installed */ }
}
if (_rateLimit) {
  app.use("/api/claude/run", _rateLimit({ windowMs: 60000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Too many Claude run requests, try again later" } }));
  app.use("/api/upload-zip", _rateLimit({ windowMs: 60000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: "Too many upload requests, try again later" } }));
  app.use("/api", _rateLimit({ windowMs: 60000, max: 200, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests, try again later" } }));
} else {
  console.warn("[WARN] express-rate-limit not installed — rate limiting disabled");
}

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

function param(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? v[0] : v;
}

// ── Terminal WebSocket server ─────────────────────────────────────

initTerminalServer(httpServer, (token: string) => safeEqual(token, DASHBOARD_TOKEN));

// ── Dashboard ────────────────────────────────────────────────────

let dashboardHtml: string | null = null;

function loadDashboard(): void {
  try {
    dashboardHtml = readFileSync(join(_dirname, "dashboard.html"), "utf-8");
    log("Dashboard HTML loaded", "startup");
  } catch {
    dashboardHtml = null;
    log("Dashboard HTML not found", "startup");
  }
}
loadDashboard();

// ── Health ────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Version ──────────────────────────────────────────────────────

let _versionCache: any = null;
try {
  _versionCache = JSON.parse(readFileSync(join("/var/www/scws", ".spawn-instance.json"), "utf-8"));
} catch { /* no instance file */ }

app.get("/api/version", (_req: Request, res: Response) => {
  if (_versionCache) {
    res.json({ version: _versionCache.version || "unknown", branch: _versionCache.branch || null });
  } else {
    res.json({ version: "unknown" });
  }
});

// ── Dashboard route ──────────────────────────────────────────────

app.get("/", (_req: Request, res: Response) => {
  if (dashboardHtml) {
    res.type("html").send(dashboardHtml);
  } else {
    res.status(404).send("Dashboard not found");
  }
});

app.post("/api/dashboard/reload", asyncHandler("Reload dashboard", async (_req, res) => {
  loadDashboard();
  res.json({ ok: true });
}));

// ── Auth middleware for all /api routes ───────────────────────────

app.use("/api", requireAuth);

// ── Terminal sessions ────────────────────────────────────────────

app.get("/api/terminal/sessions", (_req: Request, res: Response) => {
  res.json({ terminal: getTerminalSessionsList(), claude: getClaudeSessionsList(), capabilities: getCapabilities() });
});

// ── Projects ─────────────────────────────────────────────────────

app.get("/api/projects", asyncHandler("List projects", async (_req, res) => {
  const projects = await storage.getProjects();
  res.json(projects);
}));

app.post("/api/projects", asyncHandler("Create project", async (req, res) => {
  const { name, displayName, description, framework, gitRepo, needsDb } = req.body;
  if (!name || !displayName) {
    res.status(400).json({ error: "name and displayName are required" });
    return;
  }
  if (!/^[a-z0-9-]+$/.test(name) || name.length > 50) {
    res.status(400).json({ error: "Invalid project name (lowercase alphanumeric + hyphens, max 50 chars)" });
    return;
  }
  const project = await createProject({ name, displayName, description, framework: framework || "express", gitRepo, needsDb });
  res.status(201).json(project);
}));

app.get("/api/projects/stats", asyncHandler("Get project stats", async (_req, res) => {
  const projects = await storage.getProjects();
  const pm2Raw = await pm2List();
  let pm2Procs: any[] = [];
  try { pm2Procs = JSON.parse(pm2Raw); } catch { /* ignore */ }
  const pm2Map = new Map<string, any>();
  for (const p of pm2Procs) {
    const name = p.name?.startsWith("scws-") ? p.name.replace(/^scws-/, "") : p.name;
    if (name) pm2Map.set(name, p);
  }
  const stats: Record<string, any> = {};
  for (const p of projects) {
    const proc = pm2Map.get(p.name);
    stats[p.name] = {
      name: p.name,
      status: p.status,
      pm2Status: proc?.pm2_env?.status || null,
      memory: proc?.monit?.memory ? Math.round(proc.monit.memory / 1024 / 1024) : null,
      cpu: proc?.monit?.cpu ?? null,
      restarts: proc?.pm2_env?.restart_time ?? null,
      uptime: proc?.pm2_env?.pm_uptime || null,
    };
  }
  res.json(stats);
}));

app.get("/api/projects/:name", asyncHandler("Get project", async (req, res) => {
  const name = param(req, "name");
  const project = await storage.getProject(name);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const activity = await storage.getProjectActivity(project.id);
  const runs = await storage.listClaudeRuns(project.id);
  res.json({ ...project, activity, runs });
}));

app.patch("/api/projects/:name", asyncHandler("Update project", async (req, res) => {
  const name = param(req, "name");
  const allowedFields = [
    "displayName", "description", "framework", "gitRepo", "gitBranch",
    "dbName", "entryFile", "buildCommand", "startCommand", "envVars",
    "deployTargets", "status",
  ];
  const updates: Record<string, any> = {};
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  const project = await storage.updateProject(name, updates);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  res.json(project);
}));

app.delete("/api/projects/:name", asyncHandler("Delete project", async (req, res) => {
  const name = param(req, "name");
  await deleteProject(name);
  res.json({ ok: true });
}));

app.post("/api/projects/:name/start", asyncHandler("Start project", async (req, res) => {
  const name = param(req, "name");
  await startProject(name);
  res.json({ ok: true });
}));

app.post("/api/projects/:name/stop", asyncHandler("Stop project", async (req, res) => {
  const name = param(req, "name");
  await stopProject(name);
  res.json({ ok: true });
}));

app.post("/api/projects/:name/restart", asyncHandler("Restart project", async (req, res) => {
  const name = param(req, "name");
  await restartProject(name);
  res.json({ ok: true });
}));

app.post("/api/projects/:name/build", asyncHandler("Build project", async (req, res) => {
  const name = param(req, "name");
  const result = await buildProject(name);
  res.json(result);
}));

app.get("/api/projects/:name/logs", asyncHandler("Get project logs", async (req, res) => {
  const name = param(req, "name");
  const lines = parseInt(req.query.lines as string) || 100;
  const logs = await getProjectLogs(name, lines);
  res.json({ logs });
}));

// ── Claude (headless runs) ───────────────────────────────────────

app.post("/api/projects/:name/claude", asyncHandler("Run Claude", async (req, res) => {
  const name = param(req, "name");
  const project = await storage.getProject(name);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const { prompt, mode, continueSession, maxTurns } = req.body;
  if (!prompt) { res.status(400).json({ error: "prompt is required" }); return; }
  if (typeof prompt !== "string" || prompt.length > 50000) {
    res.status(400).json({ error: "prompt must be a string under 50000 characters" });
    return;
  }
  const result = await startClaudeRun({
    projectName: name,
    projectId: project.id,
    prompt,
    mode,
    continueSession,
    maxTurns: maxTurns ? parseInt(maxTurns) : undefined,
  });
  res.json(result);
}));

app.get("/api/projects/:name/claude/runs", asyncHandler("List Claude runs", async (req, res) => {
  const name = param(req, "name");
  const project = await storage.getProject(name);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const limit = parseInt(req.query.limit as string) || 20;
  const runs = await storage.listClaudeRuns(project.id, limit);
  res.json(runs);
}));

app.get("/api/projects/:name/claude/runs/:runId", asyncHandler("Get Claude run", async (req, res) => {
  const runId = param(req, "runId");
  const run = await storage.getClaudeRun(runId);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  res.json(run);
}));

// ── GitHub ───────────────────────────────────────────────────────

app.post("/api/projects/:name/github/init", asyncHandler("Init GitHub repo", async (req, res) => {
  const name = param(req, "name");
  const { repoName, isPrivate } = req.body;
  await initRepo(name, repoName, isPrivate !== false);
  res.json({ ok: true });
}));

app.post("/api/projects/:name/github/clone", asyncHandler("Clone repo", async (req, res) => {
  const name = param(req, "name");
  const { repoUrl } = req.body;
  if (!repoUrl) { res.status(400).json({ error: "repoUrl is required" }); return; }
  if (!/^(https?:\/\/|git@[\w.-]+:)/.test(repoUrl)) {
    res.status(400).json({ error: "Invalid repository URL" });
    return;
  }
  await cloneRepo(repoUrl, name);
  res.json({ ok: true });
}));

app.post("/api/projects/:name/github/push", asyncHandler("Push to GitHub", async (req, res) => {
  const name = param(req, "name");
  const { message } = req.body;
  await pushToGithub(name, message);
  res.json({ ok: true });
}));

app.post("/api/projects/:name/github/pull", asyncHandler("Pull from GitHub", async (req, res) => {
  const name = param(req, "name");
  await pullFromGithub(name);
  res.json({ ok: true });
}));

// ── Deploy ───────────────────────────────────────────────────────

app.post("/api/projects/:name/deploy", asyncHandler("Deploy project", async (req, res) => {
  const name = param(req, "name");
  const { target } = req.body;
  if (!target) { res.status(400).json({ error: "target is required" }); return; }
  await deployProject(name, target);
  res.json({ ok: true });
}));

// ── Project visibility (Tailscale-only toggle) ──────────────────

app.post("/api/projects/:name/visibility", asyncHandler("Toggle project visibility", async (req, res) => {
  const name = param(req, "name");
  const project = await storage.getProject(name);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const { isPublic } = req.body;
  if (typeof isPublic !== "boolean") { res.status(400).json({ error: "isPublic (boolean) required" }); return; }
  await addProjectNginx(name, project.port, project.framework || undefined, isPublic);
  await storage.logActivity({
    projectId: project.id,
    action: "visibility_changed",
    details: `${name} set to ${isPublic ? "public" : "Tailscale-only"}`,
  });
  res.json({ ok: true, isPublic });
}));

// ── Export project as zip ────────────────────────────────────────

app.get("/api/projects/:name/export", (req: Request, res: Response) => {
  const name = param(req, "name");
  const projectDir = `${PROJECTS_DIR}/${name}`;
  if (!existsSync(projectDir)) {
    res.status(404).json({ error: "Project directory not found" });
    return;
  }
  const zipPath = `/tmp/spawn-export-${name}-${Date.now()}.zip`;
  execFile("zip", ["-r", "-x", "node_modules/*", "-x", ".next/*", zipPath, "."], {
    cwd: projectDir,
    timeout: 60_000,
  }, (err) => {
    if (err) {
      res.status(500).json({ error: "Failed to create zip" });
      return;
    }
    res.download(zipPath, `${name}.zip`, () => {
      unlink(zipPath).catch(() => {});
    });
  });
});

// ── Log streaming (SSE) ──────────────────────────────────────────

app.get("/api/projects/:name/logs/stream", (req: Request, res: Response) => {
  const name = param(req, "name");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(":ok\n\n");

  const pm2Name = `scws-${name}`;
  const tail = execFile("pm2", ["logs", pm2Name, "--lines", "50", "--raw"], { timeout: 0 });
  tail.stdout?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
    }
  });
  tail.stderr?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) res.write(`data: ${JSON.stringify({ text: line, stderr: true })}\n\n`);
    }
  });

  req.on("close", () => {
    try { tail.kill(); } catch { /* ignore */ }
  });
});

// ── Claude streaming ─────────────────────────────────────────────

app.post("/api/claude/run", asyncHandler("Start Claude run", async (req, res) => {
  const { prompt, projectName, mode, continueSession, maxTurns } = req.body;
  if (!prompt) { res.status(400).json({ error: "prompt is required" }); return; }
  if (typeof prompt !== "string" || prompt.length > 50000) {
    res.status(400).json({ error: "prompt must be a string under 50000 characters" });
    return;
  }
  let projectId: string | undefined;
  if (projectName) {
    let project = await storage.getProject(projectName);
    if (!project) project = await ensureProjectExists(projectName);
    projectId = project.id;
  }
  const result = await startClaudeRun({
    projectName,
    projectId,
    prompt,
    mode,
    continueSession,
    maxTurns: maxTurns ? parseInt(maxTurns) : undefined,
  });
  res.json(result);
}));

app.get("/api/claude/stream/:runId", (req: Request, res: Response) => {
  const runId = param(req, "runId");
  const subscribed = subscribeToRun(runId, res);
  if (!subscribed) {
    // Run not active — check DB
    storage.getClaudeRun(runId).then(run => {
      if (run) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        res.write(`:ok\n\n`);
        res.write(`data: ${JSON.stringify({ type: "done", status: run.status, sessionId: run.sessionId, duration: run.duration })}\n\n`);
        res.end();
      } else {
        res.status(404).json({ error: "Run not found" });
      }
    }).catch(() => {
      res.status(500).json({ error: "Failed to fetch run" });
    });
  }
});

app.post("/api/claude/abort/:runId", asyncHandler("Abort Claude run", async (req, res) => {
  const runId = param(req, "runId");
  const aborted = abortRun(runId);
  res.json({ ok: aborted });
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
  const runId = param(req, "runId");
  const run = await storage.getClaudeRun(runId);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  res.json(run);
}));

app.get("/api/claude/sessions", asyncHandler("List Claude sessions", async (_req, res) => {
  const sessions = await storage.listClaudeSessions();
  res.json(sessions);
}));

// ── Import ───────────────────────────────────────────────────────

app.post("/api/import", asyncHandler("Import from URL", async (req, res) => {
  const { url } = req.body;
  if (!url) { res.status(400).json({ error: "url is required" }); return; }
  if (!/^(https?:\/\/|git@[\w.-]+:)/.test(url)) {
    res.status(400).json({ error: "Invalid repository URL" });
    return;
  }
  const project = await importFromUrl(url);
  res.json(project);
}));

// ── Upload ZIP ───────────────────────────────────────────────────

app.post("/api/upload-zip", express.json({ limit: "50mb" }), asyncHandler("Upload ZIP", async (req, res) => {
  const { data, filename } = req.body;
  if (!data) { res.status(400).json({ error: "data is required" }); return; }

  const buffer = Buffer.from(data, "base64");
  if (buffer.length > 50 * 1024 * 1024) {
    res.status(400).json({ error: "File too large (max 50MB)" });
    return;
  }

  const origName = (filename || "project.zip").replace(/\.zip$/i, "");
  let name = origName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").substring(0, 20).replace(/-$/, "") || "project";
  let uniqueName = name;
  let suffix = 2;
  while (await storage.getProject(uniqueName)) { uniqueName = `${name}-${suffix++}`; }

  const zipPath = `/tmp/spawn-upload-${randomUUID()}.zip`;
  const projectDir = `${PROJECTS_DIR}/${uniqueName}`;

  try {
    await writeFile(zipPath, buffer);

    // Security: check for path traversal in zip
    const { stdout: zipList } = await execFileAsync("unzip", ["-l", zipPath], { timeout: 10_000 });
    for (const line of zipList.split("\n")) {
      const f = line.trim().split(/\s+/).pop() || "";
      if (f.includes("..") || f.startsWith("/")) {
        throw new Error("Zip contains path traversal entries — rejected for security");
      }
    }

    await mkdir(projectDir, { recursive: true });
    await execFileAsync("unzip", ["-o", zipPath, "-d", projectDir], { timeout: 60_000 });

    // Security: verify extracted paths
    const extractedPaths = await readdir(projectDir, { recursive: true });
    for (const ep of extractedPaths) {
      const resolved = resolve(projectDir, String(ep));
      if (!resolved.startsWith(projectDir)) {
        throw new Error("Extracted file escapes target directory — rejected for security");
      }
    }

    // Hoist single nested folder
    const entries = await readdir(projectDir);
    if (entries.length === 1) {
      const single = `${projectDir}/${entries[0]}`;
      if ((await stat(single)).isDirectory()) {
        await execFileAsync("bash", ["-c", `shopt -s dotglob && mv "${single}"/* "${projectDir}"/ && rmdir "${single}"`], { timeout: 10_000 });
        log(`Hoisted nested folder "${entries[0]}" to project root`, "project");
      }
    }

    if ((await readdir(projectDir)).length === 0) {
      throw new Error("Zip file is empty — no files extracted");
    }

    const framework = await detectFramework(projectDir);
    const needsDb = await detectNeedsDb(projectDir);
    const port = await storage.getNextPort();

    const project = await storage.createProject({
      name: uniqueName,
      displayName: origName,
      description: `Uploaded from ${filename || "zip file"}`,
      port,
      status: "stopped",
      framework,
      entryFile: framework === "next" ? ".next/server.js" : framework === "static" ? "index.html" : "dist/index.js",
      buildCommand: framework === "static" ? null : "npm run build",
      startCommand: framework === "next" ? "npm start" : null,
      envVars: "{}",
      deployTargets: "[]",
    });

    await storage.logActivity({
      projectId: project.id,
      action: "uploaded",
      details: `Uploaded zip: ${filename || "project.zip"} (${framework})`,
    });

    res.json(project);
  } finally {
    unlink(zipPath).catch(() => {});
  }
}));

// ── GitHub repos ─────────────────────────────────────────────────

app.get("/api/github/repos", asyncHandler("List GitHub repos", async (_req, res) => {
  try {
    const { stdout } = await execFileAsync("gh", ["repo", "list", "--json", "name,url,isPrivate,updatedAt", "--limit", "50"], { timeout: 30_000 });
    res.json(JSON.parse(stdout));
  } catch (err: unknown) {
    res.status(500).json({ error: "Failed to list repos", details: err instanceof Error ? err.message : String(err) });
  }
}));

// ── MCP Servers ──────────────────────────────────────────────────

app.get("/api/mcp/servers", asyncHandler("List MCP servers", async (_req, res) => {
  const settings = await readClaudeSettings();
  const servers = settings.mcpServers || {};
  res.json(sanitizeAllServers(servers));
}));

app.post("/api/mcp/servers", asyncHandler("Add MCP server", async (req, res) => {
  const { name, type, url, command, args, headers, env } = req.body;
  if (!name || !type) { res.status(400).json({ error: "name and type are required" }); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 100) {
    res.status(400).json({ error: "Invalid server name" });
    return;
  }
  const settings = await readClaudeSettings();
  if (!settings.mcpServers) settings.mcpServers = {};
  const config: McpServerConfig = { type };
  if (url) config.url = url;
  if (command) config.command = command;
  if (args) config.args = args;
  if (headers) config.headers = headers;
  if (env) config.env = env;
  settings.mcpServers[name] = config;
  await writeClaudeSettings(settings);
  await storage.logActivity({ action: "mcp_added", details: `Added MCP server: ${name} (${type})` });
  res.json({ ok: true });
}));

app.patch("/api/mcp/servers/:name", asyncHandler("Edit MCP server", async (req, res) => {
  const name = param(req, "name");
  const settings = await readClaudeSettings();
  if (!settings.mcpServers?.[name]) { res.status(404).json({ error: "Server not found" }); return; }
  const current = settings.mcpServers[name];
  const { type, url, command, args, headers, env } = req.body;
  if (type !== undefined) current.type = type;
  if (url !== undefined) current.url = url;
  if (command !== undefined) current.command = command;
  if (args !== undefined) current.args = args;
  if (headers !== undefined) current.headers = headers;
  if (env !== undefined) current.env = env;
  settings.mcpServers[name] = current;
  await writeClaudeSettings(settings);
  res.json({ ok: true });
}));

app.delete("/api/mcp/servers/:name", asyncHandler("Delete MCP server", async (req, res) => {
  const name = param(req, "name");
  const settings = await readClaudeSettings();
  if (!settings.mcpServers?.[name]) { res.status(404).json({ error: "Server not found" }); return; }
  delete settings.mcpServers[name];
  await writeClaudeSettings(settings);
  await storage.logActivity({ action: "mcp_removed", details: `Removed MCP server: ${name}` });
  res.json({ ok: true });
}));

app.post("/api/mcp/servers/:name/test", asyncHandler("Test MCP server", async (req, res) => {
  const name = param(req, "name");
  const settings = await readClaudeSettings();
  const config = settings.mcpServers?.[name];
  if (!config) { res.status(404).json({ error: "Server not found" }); return; }
  const result = await testMcpConnection(config);
  res.json(result);
}));

app.get("/api/mcp/servers/:name/tools", asyncHandler("List MCP tools", async (req, res) => {
  const name = param(req, "name");
  const settings = await readClaudeSettings();
  const config = settings.mcpServers?.[name];
  if (!config) { res.status(404).json({ error: "Server not found" }); return; }
  const result = await listMcpTools(config);
  res.json(result);
}));

app.post("/api/mcp/servers/:name/restart", asyncHandler("Restart local MCP server", async (req, res) => {
  const name = param(req, "name");
  // Find the PM2 process for this MCP server
  try {
    const pm2Name = `scws-${name}`;
    await execFileAsync("pm2", ["restart", pm2Name], { timeout: 10_000 });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: `Failed to restart: ${err instanceof Error ? err.message : err}` });
  }
}));

// ── Per-project MCP config ───────────────────────────────────────

app.get("/api/mcp/config/project/:name", asyncHandler("Get project MCP config", async (req, res) => {
  const name = param(req, "name");
  const raw = await storage.getConfig(`mcp-override:${name}`);
  res.json(raw ? JSON.parse(raw) : null);
}));

app.patch("/api/mcp/config/project/:name", asyncHandler("Set project MCP config", async (req, res) => {
  const name = param(req, "name");
  const config = req.body;
  if (!config) { res.status(400).json({ error: "Config object required" }); return; }
  await storage.setConfig(`mcp-override:${name}`, JSON.stringify(config));
  res.json({ ok: true });
}));

// ── Channels & Notifications ─────────────────────────────────────

app.get("/api/channels", asyncHandler("List channels", async (_req, res) => {
  const channels = await storage.getChannels();
  const safe = channels.map(ch => ({
    ...ch,
    config: JSON.stringify(sanitizeChannelConfig(ch.type, JSON.parse(ch.config))),
  }));
  res.json(safe);
}));

app.post("/api/channels", asyncHandler("Create channel", async (req, res) => {
  const { type, name, config } = req.body;
  if (!type || !name) { res.status(400).json({ error: "type and name are required" }); return; }
  const channel = await storage.createChannel({
    type,
    name,
    config: typeof config === "string" ? config : JSON.stringify(config || {}),
  });
  res.json(channel);
}));

app.patch("/api/channels/:id", asyncHandler("Update channel", async (req, res) => {
  const id = param(req, "id");
  const updates: Record<string, any> = {};
  for (const key of ["name", "type", "config", "enabled", "verified", "status", "statusMessage"]) {
    if (req.body[key] !== undefined) {
      updates[key] = key === "config" && typeof req.body[key] === "object"
        ? JSON.stringify(req.body[key])
        : req.body[key];
    }
  }
  const channel = await storage.updateChannel(id, updates);
  if (!channel) { res.status(404).json({ error: "Channel not found" }); return; }
  res.json(channel);
}));

app.delete("/api/channels/:id", asyncHandler("Delete channel", async (req, res) => {
  const id = param(req, "id");
  const channel = await storage.getChannel(id);
  if (!channel) { res.status(404).json({ error: "Channel not found" }); return; }
  await storage.deleteChannel(id);
  await storage.logActivity({ action: "channel_deleted", details: `Deleted channel: ${channel.name}` });
  res.json({ ok: true });
}));

app.post("/api/channels/:id/test", asyncHandler("Test channel", async (req, res) => {
  const id = param(req, "id");
  const result = await testChannel(id);
  res.json(result);
}));

app.post("/api/channels/:id/verify-telegram", asyncHandler("Verify Telegram", async (req, res) => {
  const id = param(req, "id");
  const channel = await storage.getChannel(id);
  if (!channel || channel.type !== "telegram") {
    res.status(400).json({ error: "Channel not found or not Telegram" });
    return;
  }
  const config = JSON.parse(channel.config);
  const botResult = await validateTelegramBot(config.botToken);
  if (!botResult.ok) { res.json(botResult); return; }
  // Get updates to find chat ID
  try {
    const updatesRes = await fetch(`https://api.telegram.org/bot${config.botToken}/getUpdates`, {
      signal: AbortSignal.timeout(10_000),
    });
    const updates = await updatesRes.json() as any;
    if (updates.ok && updates.result?.length > 0) {
      const chatId = String(updates.result[updates.result.length - 1].message?.chat?.id);
      if (chatId) {
        config.chatId = chatId;
        config.botUsername = botResult.username;
        await storage.updateChannel(id, {
          config: JSON.stringify(config),
          verified: 1,
          status: "connected",
        });
        await sendTelegramMessage(config.botToken, chatId,
          "<b>[SPAWN]</b> Telegram notifications connected successfully!");
        res.json({ ok: true, chatId });
        return;
      }
    }
    res.json({ ok: false, error: "No messages found. Send /start to the bot first." });
  } catch (err: unknown) {
    res.json({ ok: false, error: sanitizeError(err) });
  }
}));

app.get("/api/notifications", asyncHandler("List notifications", async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const notifications = await storage.getNotifications(limit);
  res.json(notifications);
}));

app.get("/api/channels/config/rules", asyncHandler("Get notification rules", async (_req, res) => {
  const raw = await storage.getConfig("notification-rules");
  res.json(raw ? JSON.parse(raw) : getDefaultNotificationRules());
}));

app.patch("/api/channels/config/rules", asyncHandler("Update notification rules", async (req, res) => {
  await storage.setConfig("notification-rules", JSON.stringify(req.body));
  res.json({ ok: true });
}));

// ── Notify dispatch ──────────────────────────────────────────────

app.post("/api/notify", asyncHandler("Dispatch notification", async (req, res) => {
  const { event, message } = req.body;
  if (!event || !message) { res.status(400).json({ error: "event and message are required" }); return; }
  await notify(event, message);
  res.json({ ok: true });
}));

// ── Activity ─────────────────────────────────────────────────────

app.post("/api/activity", asyncHandler("Log activity", async (req, res) => {
  const { projectId, action, details } = req.body;
  if (!action) { res.status(400).json({ error: "action is required" }); return; }
  const activity = await storage.logActivity({ projectId, action, details: details || "" });
  res.json(activity);
}));

app.get("/api/activity", asyncHandler("Get activity", async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const activity = await storage.getActivity(limit);
  res.json(activity);
}));

// ── Image upload ─────────────────────────────────────────────────

app.post("/api/upload-image", asyncHandler("Upload image", async (req, res) => {
  const { data, filename, projectName } = req.body;
  if (!data || !projectName) { res.status(400).json({ error: "data and projectName are required" }); return; }
  const buffer = Buffer.from(data, "base64");
  if (buffer.length > 10 * 1024 * 1024) { res.status(400).json({ error: "Image too large (max 10MB)" }); return; }
  const dir = `${PROJECTS_DIR}/${projectName}/public/images`;
  await mkdir(dir, { recursive: true });
  const safeName = (filename || `upload-${Date.now()}.png`).replace(/[^a-zA-Z0-9._-]/g, "_");
  await writeFile(`${dir}/${safeName}`, buffer);
  res.json({ ok: true, path: `public/images/${safeName}` });
}));

// ── System info ──────────────────────────────────────────────────

app.get("/api/system", asyncHandler("System info", async (_req, res) => {
  const info: Record<string, any> = {};
  try {
    const { stdout: hostname } = await execFileAsync("hostname", [], { timeout: 5000 });
    info.hostname = hostname.trim();
  } catch { info.hostname = "unknown"; }
  try {
    const { stdout: uptime } = await execFileAsync("uptime", ["-p"], { timeout: 5000 });
    info.uptime = uptime.trim();
  } catch { info.uptime = "unknown"; }
  try {
    const { stdout: free } = await execFileAsync("free", ["-m"], { timeout: 5000 });
    info.memory = free;
  } catch { info.memory = "unknown"; }
  try {
    const { stdout: df } = await execFileAsync("df", ["-h", "/"], { timeout: 5000 });
    info.disk = df;
  } catch { info.disk = "unknown"; }
  try {
    const temp = await readFile("/sys/class/thermal/thermal_zone0/temp", "utf8");
    info.cpuTemp = (parseInt(temp.trim()) / 1000).toFixed(1) + "\u00B0C";
  } catch { info.cpuTemp = null; }
  try {
    const { stdout: tailscale } = await execFileAsync("tailscale", ["status", "--json"], { timeout: 5000 });
    const tsData = JSON.parse(tailscale);
    info.tailscale = { ip: tsData.Self?.TailscaleIPs?.[0], hostname: tsData.Self?.HostName, online: tsData.Self?.Online };
  } catch { info.tailscale = null; }
  res.json(info);
}));

app.get("/api/system/pm2", asyncHandler("PM2 process list", async (_req, res) => {
  const raw = await pm2List();
  try {
    const procs = JSON.parse(raw);
    res.json(procs.map((p: any) => ({
      name: p.name,
      status: p.pm2_env?.status,
      cpu: p.monit?.cpu,
      memory: p.monit?.memory ? Math.round(p.monit.memory / 1024 / 1024) : null,
      restarts: p.pm2_env?.restart_time,
      uptime: p.pm2_env?.pm_uptime,
      pid: p.pid,
    })));
  } catch {
    res.json([]);
  }
}));

// ── Watchdog ─────────────────────────────────────────────────────

app.get("/api/watchdog/config", asyncHandler("Watchdog config", async (_req, res) => {
  res.json(await getWatchdogConfig());
}));

app.patch("/api/watchdog/config", asyncHandler("Update watchdog config", async (req, res) => {
  res.json(await updateWatchdogConfig(req.body));
}));

app.get("/api/watchdog/status", asyncHandler("Watchdog status", async (_req, res) => {
  res.json(getWatchdogStatus());
}));

// ── Memory metrics ───────────────────────────────────────────────

app.get("/api/metrics/memory", asyncHandler("Memory metrics", async (_req, res) => {
  const limit = 50;
  const rows = await pool.query(
    `SELECT details, created_at FROM activity_log WHERE action='memory_snapshot' ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  res.json(rows.rows.map((r: any) => {
    try { return { ...JSON.parse(r.details), timestamp: r.created_at }; } catch { return null; }
  }).filter(Boolean));
}));

// ── AI Tools ────────────────────────────────────────────────────

app.get("/api/ai-tools", asyncHandler("List available AI tools", async (_req, res) => {
  const claudeAvail = existsSync(`${USER_HOME}/.local/bin/claude`);
  const caps = getCapabilities();
  res.json({ claude: claudeAvail, opencode: caps.opencode });
}));

app.get("/api/claude-terminal/context/:projectName", asyncHandler("Preview Claude context", async (req, res) => {
  const projectName = req.params.projectName as string;
  const parts: string[] = ["You are working on the SPAWN project: " + projectName];
  try {
    const proj = await storage.getProject(projectName);
    if (proj) {
      parts.push("Framework: " + (proj.framework || "unknown"));
      parts.push("Port: " + (proj.port || "unassigned"));
      parts.push("Status: " + (proj.status || "unknown"));
      if (proj.description) parts.push("Description: " + proj.description);
      if (proj.gitRepo) parts.push("Git: " + proj.gitRepo);
      if (proj.dbName) parts.push("Database: " + proj.dbName);
      try {
        const activity = await storage.getProjectActivity(proj.id, 5);
        if (activity?.length) {
          parts.push("Recent activity:");
          for (const a of activity) {
            parts.push("  - " + a.action + ": " + (a.details || "").substring(0, 120));
          }
        }
      } catch {}
    }
  } catch {}
  try {
    const memRows = await pool.query(
      "SELECT key, value FROM spawn_memories WHERE key ILIKE $1 ORDER BY updated_at DESC LIMIT 5",
      ["%" + projectName + "%"],
    );
    if (memRows.rows.length) {
      parts.push("Related memories:");
      for (const m of memRows.rows) {
        parts.push("  [" + m.key + "]: " + (m.value || "").substring(0, 200));
      }
    }
  } catch {}
  res.json({ context: parts.join("\n") });
}));

// ── Register modular route groups ────────────────────────────────

registerOnboardingRoutes(app);
registerConnectionsRoutes(app);
registerNetworkRoutes(app);

// ── Tailscale Funnel ─────────────────────────────────────────────

app.get("/api/tailscale/funnel/status", asyncHandler("Tailscale Funnel status", async (_req, res) => {
  try {
    const { stdout } = await execFileAsync("tailscale", ["funnel", "status", "--json"], { timeout: 10_000 });
    res.json(JSON.parse(stdout));
  } catch {
    res.json({ enabled: false });
  }
}));

app.post("/api/tailscale/funnel/enable", asyncHandler("Enable Tailscale Funnel", async (req, res) => {
  const { port } = req.body;
  const targetPort = port || 80;
  await execFileAsync("tailscale", ["funnel", String(targetPort)], { timeout: 30_000 });
  await storage.logActivity({ action: "funnel_enabled", details: `Tailscale Funnel enabled on port ${targetPort}` });
  res.json({ ok: true });
}));

app.post("/api/tailscale/funnel/disable", asyncHandler("Disable Tailscale Funnel", async (_req, res) => {
  await execFileAsync("tailscale", ["funnel", "off"], { timeout: 10_000 });
  await storage.logActivity({ action: "funnel_disabled", details: "Tailscale Funnel disabled" });
  res.json({ ok: true });
}));

// ── System Quick Actions ─────────────────────────────────────────

app.post("/api/system/quick-action", asyncHandler("System quick action", async (req, res) => {
  const { action } = req.body;
  if (!action) { res.status(400).json({ error: "action is required" }); return; }

  switch (action) {
    case "pm2-save":
      await execFileAsync("pm2", ["save"], { timeout: 10_000 });
      res.json({ ok: true, output: "PM2 process list saved" });
      break;
    case "nginx-reload":
      await execFileAsync("sudo", ["nginx", "-s", "reload"], { timeout: 10_000 });
      res.json({ ok: true, output: "nginx reloaded" });
      break;
    case "clear-caches":
      await execFileAsync("sudo", ["sh", "-c", "sync; echo 3 > /proc/sys/vm/drop_caches"], { timeout: 5000 });
      res.json({ ok: true, output: "System caches cleared" });
      break;
    default:
      res.status(400).json({ error: `Unknown action: ${action}` });
  }
}));

// ── Server startup ───────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "4000", 10);

httpServer.listen(PORT, "127.0.0.1", () => {
  log(`SPAWN daemon listening on 127.0.0.1:${PORT}`, "startup");
  log(`Dashboard at http://127.0.0.1:${PORT}`, "startup");

  // Boot reconciliation
  bootReconcile().catch(err => log(`Boot reconciliation failed: ${err}`, "error"));

  // Kill orphaned Claude/OpenCode processes from before boot
  killBootOrphanedProcesses().catch(err => log(`Boot orphan cleanup failed: ${err}`, "error"));

  // Start watchdog
  startWatchdog().catch(err => log(`Watchdog start failed: ${err}`, "error"));

  // Memory snapshot every 10 minutes
  setInterval(memorySnapshot, 600_000);

  // Activity log pruning every 24 hours
  setInterval(pruneActivityLog, 86_400_000);

  // Set OOM scores
  execFile("/var/www/scws/scripts/set-oom-scores.sh", [], { timeout: 10_000 }, (err) => {
    if (err) log("OOM scores failed: " + err.message, "error");
    else log("OOM scores applied on startup", "startup");
  });
});

// ── Boot reconciliation ──────────────────────────────────────────

async function bootReconcile(): Promise<void> {
  try {
    const pm2Raw = await pm2List();
    const pm2Procs = JSON.parse(pm2Raw);
    const pm2Running = new Map<string, string>();
    for (const p of pm2Procs) {
      if (!p.name || p.name === "scws-daemon" || p.pm2_env?.status !== "online") continue;
      const projectName = p.name.startsWith("scws-") ? p.name.replace(/^scws-/, "") : p.name;
      pm2Running.set(projectName, p.name);
    }

    const projects = await storage.getProjects();
    for (const p of projects) {
      if (p.name === "spawn-mcp") {
        log("Boot reconcile: skipping autostart project spawn-mcp", "startup");
        continue;
      }
      const pm2Name = pm2Running.get(p.name);
      if (pm2Name) {
        try { await execFileAsync("pm2", ["stop", pm2Name], { timeout: 10_000 }); } catch { /* ignore */ }
        await storage.updateProject(p.name, { status: "stopped" });
        log(`Boot reconcile: stopped resurrected "${p.name}" (pm2: ${pm2Name})`, "startup");
      } else if (p.status === "running") {
        await storage.updateProject(p.name, { status: "stopped" });
        log(`Boot reconcile: reset stale status for "${p.name}"`, "startup");
      }
    }
    log(`Boot reconciliation complete (${projects.length} projects checked)`, "startup");
  } catch (err) {
    log(`Boot reconciliation failed: ${err}`, "error");
  }
}

// ── Kill orphaned Claude/OpenCode processes ──────────────────────

async function killBootOrphanedProcesses(): Promise<void> {
  try {
    for (const pat of ["/.local/bin/claude", "opencode"]) {
      try {
        const { stdout } = await execFileAsync("pgrep", ["-f", pat], { timeout: 5000 });
        const pids = stdout.trim().split("\n").filter(Boolean);
        for (const pid of pids) {
          try {
            await execFileAsync("kill", ["-9", pid], { timeout: 5000 });
            log(`Killed orphaned process ${pid} (${pat})`, "startup");
          } catch { /* ignore */ }
        }
      } catch { /* no matching processes */ }
    }
  } catch (err) {
    log(`Boot orphan cleanup failed: ${err}`, "error");
  }
}

// ── Memory snapshot ──────────────────────────────────────────────

async function memorySnapshot(): Promise<void> {
  try {
    const { stdout: freeOut } = await execFileAsync("free", ["-m"], { timeout: 5000 });
    const memLine = freeOut.split("\n").find(l => l.startsWith("Mem:"));
    const swapLine = freeOut.split("\n").find(l => l.startsWith("Swap:"));
    if (memLine) {
      const parts = memLine.split(/\s+/);
      const total = parseInt(parts[1]) || 0;
      const used = parseInt(parts[2]) || 0;
      const avail = parseInt(parts[6]) || 0;
      let swapUsed = 0;
      if (swapLine) {
        const sp = swapLine.split(/\s+/);
        swapUsed = parseInt(sp[2]) || 0;
      }

      const { stdout: pm2j } = await execFileAsync("pm2", ["jlist"], { timeout: 10_000 });
      const procs: Array<{ name: string; mem: number }> = [];
      try {
        for (const p of JSON.parse(pm2j)) {
          if (p.monit?.memory > 0) {
            procs.push({ name: p.name, mem: Math.round(p.monit.memory / 1024 / 1024) });
          }
        }
      } catch { /* ignore */ }

      await storage.logActivity({
        action: "memory_snapshot",
        details: JSON.stringify({
          total, used, available: avail, swap_used: swapUsed,
          pct: Math.round(used / total * 100),
          processes: procs,
        }),
      });
    }
  } catch (err: any) {
    log("Memory snapshot error: " + (err.message || err), "error");
  }
}

// ── Activity log pruning ─────────────────────────────────────────

async function pruneActivityLog(): Promise<void> {
  try {
    const r1 = await pool.query("DELETE FROM activity_log WHERE action='memory_snapshot' AND created_at < NOW() - INTERVAL '7 days'");
    const r2 = await pool.query("DELETE FROM activity_log WHERE action!='memory_snapshot' AND created_at < NOW() - INTERVAL '30 days'");
    const deleted = (r1.rowCount || 0) + (r2.rowCount || 0);
    if (deleted > 0) log(`Activity log pruned: ${deleted} old rows removed`, "maintenance");
  } catch (err: any) {
    log("Activity prune error: " + (err.message || err), "error");
  }
}

// ── Graceful shutdown ────────────────────────────────────────────

process.on("SIGTERM", async () => {
  log("SIGTERM received, shutting down...", "shutdown");
  stopWatchdog();
  shutdownTerminals();
  httpServer.close();
  await pool.end();
  process.exit(0);
});

process.on("SIGINT", async () => {
  log("SIGINT received, shutting down...", "shutdown");
  stopWatchdog();
  shutdownTerminals();
  httpServer.close();
  await pool.end();
  process.exit(0);
});

process.on("uncaughtException", (err: Error) => {
  log(`Uncaught exception: ${err.message}`, "error");
  console.error(err.stack);
  setTimeout(() => process.exit(1), 1000);
});

process.on("unhandledRejection", (err: unknown) => {
  log(`Unhandled rejection: ${err}`, "error");
});
