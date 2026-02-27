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
import { runClaude } from "./claude.js";
import { initRepo, cloneRepo, pushToGithub, pullFromGithub } from "./github.js";
import { deployProject } from "./deploy.js";

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
  log("WARNING: DASHBOARD_TOKEN is empty — API will reject all requests", "startup");
}

function safeEqual(a: string, b: string): boolean {
  const hA = createHash("sha256").update(a).digest();
  const hB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hA, hB);
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing authorization header" });
    return;
  }
  const token = authHeader.slice(7);
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

app.get("/api/activity", asyncHandler("Get activity", async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const activity = await storage.getActivity(limit);
  res.json(activity);
}));

// ── Start server ──────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "4000", 10);

httpServer.listen(PORT, "127.0.0.1", () => {
  log(`SCWS daemon listening on 127.0.0.1:${PORT}`, "startup");
  log(`Dashboard at http://127.0.0.1:${PORT}`, "startup");
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  log("SIGTERM received, shutting down...", "shutdown");
  httpServer.close();
  await pool.end();
  process.exit(0);
});

process.on("SIGINT", async () => {
  log("SIGINT received, shutting down...", "shutdown");
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
