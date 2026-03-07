import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import type { Express, Request, Response } from "express";
import { storage, type IStorage } from "./storage.js";
import { asyncHandler } from "./asyncHandler.js";

const execAsync = promisify(execFile);
const home = process.env.HOME || "/home/codeman";

interface OnboardingStep {
  id: number;
  name: string;
  label: string;
  status: "complete" | "pending" | "skipped";
  required: boolean;
}

interface OnboardingStatus {
  status: "complete" | "in-progress" | "incomplete";
  steps: OnboardingStep[];
  requiredComplete: number;
  requiredTotal: number;
}

export async function detectOnboardingStatus(): Promise<OnboardingStatus> {
  const steps: OnboardingStep[] = [];

  // Step 1: Daemon health (always complete if we're responding)
  steps.push({
    id: 1,
    name: "daemon",
    label: "Daemon Health",
    status: "complete",
    required: true,
  });

  // Step 2: Claude CLI or OpenCode
  let claudeCliStatus: OnboardingStep["status"] = "pending";
  try {
    const claudePath = path.join(home, ".local/bin/claude");
    if (fs.existsSync(claudePath)) {
      claudeCliStatus = "complete";
    } else {
      await execAsync("which", ["claude"], { timeout: 5000 });
      claudeCliStatus = "complete";
    }
  } catch {}
  // Check for OpenCode as alternative
  if (claudeCliStatus === "pending") {
    try {
      await execAsync("which", ["opencode"], { timeout: 5000 });
      claudeCliStatus = "complete";
    } catch {}
  }
  // Check persisted state as fallback
  if (claudeCliStatus === "pending") {
    const saved = await storage.getConfig("onboard-claude-cli");
    if (saved === "installed") claudeCliStatus = "complete";
  }
  steps.push({
    id: 2,
    name: "claude-cli",
    label: "AI Coding Agent",
    status: claudeCliStatus,
    required: true,
  });

  // Step 3: Claude Auth
  let claudeAuthStatus: OnboardingStep["status"] = "pending";
  try {
    const credsPath = path.join(home, ".claude/.credentials.json");
    if (fs.existsSync(credsPath)) {
      const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
      if (creds.accessToken || creds.claudeAiOauth || creds.apiKey) {
        claudeAuthStatus = "complete";
      }
    }
  } catch {}
  if (claudeAuthStatus === "pending") {
    const saved = await storage.getConfig("onboard-claude-auth");
    if (saved === "authed") claudeAuthStatus = "complete";
  }
  steps.push({
    id: 3,
    name: "claude-auth",
    label: "Claude Code Auth",
    status: claudeAuthStatus,
    required: true,
  });

  // Step 4: GitHub CLI (optional)
  let ghStatus: OnboardingStep["status"] = "pending";
  try {
    await execAsync("gh", ["auth", "status"], { timeout: 10000 });
    ghStatus = "complete";
  } catch {}
  if (ghStatus === "pending") {
    const saved = await storage.getConfig("onboard-gh-cli");
    if (saved === "authed") ghStatus = "complete";
    else if (saved === "skipped") ghStatus = "skipped";
  }
  steps.push({
    id: 4,
    name: "gh-cli",
    label: "GitHub CLI",
    status: ghStatus,
    required: false,
  });

  // Step 5: Claude Settings
  let settingsStatus: OnboardingStep["status"] = "pending";
  try {
    const settingsPath = path.join(home, ".claude/settings.json");
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (settings.mcpServers && settings.mcpServers.spawn) {
        settingsStatus = "complete";
      }
    }
  } catch {}
  if (settingsStatus === "pending") {
    const saved = await storage.getConfig("onboard-claude-settings");
    if (saved === "configured") settingsStatus = "complete";
  }
  steps.push({
    id: 5,
    name: "claude-settings",
    label: "Claude Settings",
    status: settingsStatus,
    required: true,
  });

  // Compute overall status
  const requiredSteps = steps.filter((s) => s.required);
  const requiredComplete = requiredSteps.filter(
    (s) => s.status === "complete"
  ).length;
  const allComplete = requiredComplete === requiredSteps.length;
  const anyStarted = steps.some(
    (s) => s.status === "complete" || s.status === "skipped"
  );

  let overall: OnboardingStatus["status"] = "incomplete";
  if (allComplete) overall = "complete";
  else if (anyStarted) overall = "in-progress";

  return {
    status: overall,
    steps,
    requiredComplete,
    requiredTotal: requiredSteps.length,
  };
}

export async function updateOnboardingStep(
  key: string,
  value: string
): Promise<void> {
  await storage.setConfig(key, value || "");
  await storage.logActivity({
    action: "onboard_update",
    details: `Onboarding: ${key} = ${value || "(cleared)"}`,
  });
}

export function registerOnboardingRoutes(app: Express): void {
  // GET /api/onboard/status — Returns onboarding state (live detection + persisted)
  app.get(
    "/api/onboard/status",
    asyncHandler("Onboarding status", async (_req: Request, res: Response) => {
      const result = await detectOnboardingStatus();
      res.json(result);
    })
  );

  // POST /api/onboard/update — CLI script persists step completion
  app.post(
    "/api/onboard/update",
    asyncHandler(
      "Update onboarding step",
      async (req: Request, res: Response) => {
        const { key, value } = req.body;
        if (!key || typeof key !== "string") {
          res.status(400).json({ error: "key is required" });
          return;
        }
        // Only allow onboard-* keys
        if (!key.startsWith("onboard-")) {
          res.status(400).json({ error: "Only onboard-* keys are allowed" });
          return;
        }
        await updateOnboardingStep(key, value);
        res.json({ ok: true });
      }
    )
  );
}
