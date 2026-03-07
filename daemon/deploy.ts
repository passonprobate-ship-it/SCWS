import { execFile } from "child_process";
import { promisify } from "util";
import { storage } from "./storage.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

const PROJECTS_DIR = "/var/www/scws/projects";

interface DeployTarget {
  name: string;
  host: string;
  user: string;
  remotePath: string;
  pm2Name: string;
  preDeploy?: string;
  postDeploy?: string;
}

async function ssh(host: string, user: string, command: string): Promise<string> {
  const { stdout } = await execFileAsync("ssh", [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    `${user}@${host}`,
    command,
  ], { timeout: 60_000 });
  return stdout.trim();
}

async function scp(localPath: string, host: string, user: string, remotePath: string): Promise<void> {
  await execFileAsync("scp", [
    "-r",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    localPath,
    `${user}@${host}:${remotePath}`,
  ], { timeout: 120_000 });
}

export async function deployProject(projectName: string, targetName: string): Promise<void> {
  const project = await storage.getProject(projectName);
  if (!project) throw new Error(`Project "${projectName}" not found`);

  const targets: DeployTarget[] = JSON.parse(project.deployTargets);
  const target = targets.find(t => t.name === targetName);
  if (!target) throw new Error(`Deploy target "${targetName}" not found for project "${projectName}"`);

  const dir = `${PROJECTS_DIR}/${projectName}`;

  log(`Deploying "${projectName}" to ${target.name} (${target.host})...`, "deploy");

  if (project.buildCommand) {
    log(`Building ${projectName}...`, "deploy");
    await execFileAsync("bash", ["-c", project.buildCommand], {
      cwd: dir,
      timeout: 120_000,
      env: { ...process.env, NODE_ENV: "production" },
    });
  }

  if (target.preDeploy) {
    log(`Running pre-deploy on ${target.host}...`, "deploy");
    await ssh(target.host, target.user, target.preDeploy);
  }

  log(`Copying files to ${target.host}:${target.remotePath}...`, "deploy");
  await scp(`${dir}/dist/`, target.host, target.user, target.remotePath);

  if (target.postDeploy) {
    log(`Running post-deploy on ${target.host}...`, "deploy");
    await ssh(target.host, target.user, target.postDeploy);
  }

  await storage.updateProject(projectName, { lastDeployAt: new Date() });
  await storage.logActivity({
    projectId: project.id,
    action: "deployed",
    details: `Deployed to ${target.name} (${target.host})`,
  });

  log(`Deploy complete: "${projectName}" \u2192 ${target.name} (${target.host})`, "deploy");
}
