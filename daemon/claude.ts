import { execFile } from "child_process";
import { promisify } from "util";
import { storage } from "./storage.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

const PROJECTS_DIR = "/var/www/scws/projects";

// Track active runs per project to prevent concurrent runs
const activeRuns = new Set<string>();

interface RunClaudeOpts {
  projectName: string;
  projectId: string;
  prompt: string;
  mode?: "plan" | "build";
  continueSession?: string;
  maxTurns?: number;
}

interface ClaudeResult {
  runId: string;
  output: string | null;
  sessionId: string | null;
  status: string;
  duration: number;
}

export async function runClaude(opts: RunClaudeOpts): Promise<ClaudeResult> {
  const { projectName, projectId, prompt, mode = "build", continueSession, maxTurns } = opts;

  // Prevent concurrent runs on same project
  if (activeRuns.has(projectName)) {
    throw new Error(`Claude is already running on project "${projectName}". Wait for it to finish.`);
  }

  activeRuns.add(projectName);
  const startTime = Date.now();

  // Create run record
  const run = await storage.createClaudeRun({
    projectId,
    prompt,
    status: "running",
    mode,
  });

  try {
    const args: string[] = ["-p", prompt, "--output-format", "json"];

    if (mode === "build") {
      args.push("--allowedTools", "Bash,Read,Edit,Write,Glob,Grep");
    }
    // plan mode: don't auto-approve tools, Claude will be read-only

    if (continueSession) {
      args.push("--resume", continueSession);
    }

    if (maxTurns) {
      args.push("--max-turns", String(maxTurns));
    }

    log(`Running Claude on "${projectName}" [${mode}]: ${prompt.substring(0, 100)}...`, "claude");

    const { stdout } = await execFileAsync("claude", args, {
      cwd: `${PROJECTS_DIR}/${projectName}`,
      timeout: 600_000, // 10 minute timeout
      env: { ...process.env, HOME: "/root" },
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
    });

    let output: string | null = null;
    let sessionId: string | null = null;

    try {
      const parsed = JSON.parse(stdout);
      output = parsed.result || parsed.text || stdout;
      sessionId = parsed.session_id || null;
    } catch {
      // If not JSON, use raw output
      output = stdout;
    }

    const duration = Date.now() - startTime;

    await storage.updateClaudeRun(run.id, {
      output,
      sessionId,
      status: "completed",
      duration,
    });

    await storage.logActivity({
      projectId,
      action: "claude_run",
      details: `[${mode}] ${prompt.substring(0, 200)} (${Math.round(duration / 1000)}s)`,
    });

    log(`Claude completed on "${projectName}" in ${Math.round(duration / 1000)}s`, "claude");

    return { runId: run.id, output, sessionId, status: "completed", duration };
  } catch (err: unknown) {
    const duration = Date.now() - startTime;
    const msg = err instanceof Error ? err.message : String(err);

    await storage.updateClaudeRun(run.id, {
      output: msg,
      status: "failed",
      duration,
    });

    await storage.logActivity({
      projectId,
      action: "claude_failed",
      details: `[${mode}] ${msg.substring(0, 200)}`,
    });

    log(`Claude failed on "${projectName}": ${msg.substring(0, 200)}`, "error");
    throw new Error(`Claude run failed: ${msg}`);
  } finally {
    activeRuns.delete(projectName);
  }
}
