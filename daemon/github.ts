import { execFile } from "child_process";
import { promisify } from "util";
import { storage } from "./storage.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

const PROJECTS_DIR = "/var/www/scws/projects";

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 120_000 });
  return stdout.trim();
}

export async function initRepo(projectName: string, repoName?: string, isPrivate = true): Promise<void> {
  const dir = `${PROJECTS_DIR}/${projectName}`;
  const repo = repoName || projectName;

  await git(["init"], dir);
  await git(["add", "-A"], dir);
  await git(["commit", "-m", "Initial commit from SCWS"], dir);

  const visibility = isPrivate ? "--private" : "--public";
  await execFileAsync("gh", ["repo", "create", repo, visibility, "--source=.", "--push"], {
    cwd: dir,
    timeout: 60_000,
  });

  // Get the repo URL
  const remoteUrl = await git(["remote", "get-url", "origin"], dir);
  await storage.updateProject(projectName, { gitRepo: remoteUrl });

  await storage.logActivity({
    projectId: (await storage.getProject(projectName))?.id,
    action: "github_init",
    details: `Created repo: ${repo} (${isPrivate ? "private" : "public"})`,
  });

  log(`GitHub repo created: ${repo}`, "github");
}

export async function cloneRepo(repoUrl: string, projectName: string): Promise<void> {
  const dir = `${PROJECTS_DIR}/${projectName}`;

  await execFileAsync("git", ["clone", repoUrl, dir], { timeout: 120_000 });

  await storage.updateProject(projectName, { gitRepo: repoUrl });

  await storage.logActivity({
    projectId: (await storage.getProject(projectName))?.id,
    action: "github_clone",
    details: `Cloned: ${repoUrl}`,
  });

  log(`Cloned ${repoUrl} into ${projectName}`, "github");
}

export async function pushToGithub(projectName: string, message?: string): Promise<void> {
  const dir = `${PROJECTS_DIR}/${projectName}`;
  const commitMsg = message || `Update from SCWS (${new Date().toISOString()})`;

  // Stage all changes
  await git(["add", "-A"], dir);

  // Check if there are changes to commit
  try {
    await git(["diff", "--cached", "--quiet"], dir);
    // If no error, there are no staged changes
    log(`No changes to commit for ${projectName}`, "github");
    return;
  } catch {
    // There are staged changes — commit them
  }

  await git(["commit", "-m", commitMsg], dir);
  await git(["push"], dir);

  await storage.logActivity({
    projectId: (await storage.getProject(projectName))?.id,
    action: "github_push",
    details: commitMsg,
  });

  log(`Pushed ${projectName} to GitHub`, "github");
}

export async function pullFromGithub(projectName: string): Promise<void> {
  const dir = `${PROJECTS_DIR}/${projectName}`;

  const output = await git(["pull"], dir);

  await storage.logActivity({
    projectId: (await storage.getProject(projectName))?.id,
    action: "github_pull",
    details: output.substring(0, 200),
  });

  log(`Pulled latest for ${projectName}`, "github");
}
