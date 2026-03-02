import { execFile } from "child_process";
import { promisify } from "util";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

const PROJECTS_DIR = "/var/www/scws/projects";

export async function pm2Start(
  projectName: string,
  entryFile: string,
  port: number,
  envVars: Record<string, string> = {},
  startCommand?: string | null,
  memoryLimitMB: number = 256,
): Promise<void> {
  const cwd = `${PROJECTS_DIR}/${projectName}`;
  const pm2Name = `scws-${projectName}`;
  const restartMB = Math.round(memoryLimitMB * 1.2);

  const env = {
    NODE_ENV: "production",
    PORT: String(port),
    BASE_URL: `/${projectName}`,
    ...envVars,
  };

  const envArgs = Object.entries(env)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");

  if (startCommand) {
    await execFileAsync("bash", ["-c",
      `cd "${cwd}" && env ${envArgs} pm2 start bash --name "${pm2Name}" --cwd "${cwd}" --update-env --max-memory-restart ${restartMB}M -- -c "cd '${cwd}' && ${startCommand}"`,
    ], { timeout: 30_000 });
  } else {
    await execFileAsync("bash", ["-c",
      `cd "${cwd}" && env ${envArgs} pm2 start "${entryFile}" --name "${pm2Name}" --cwd "${cwd}" --update-env --node-args="--max-old-space-size=${memoryLimitMB}" --max-memory-restart ${restartMB}M`,
    ], { timeout: 30_000 });
  }

  await execFileAsync("pm2", ["save"], { timeout: 10_000 });
  log(`PM2 started: ${pm2Name} on port ${port} (heap ${memoryLimitMB}MB)`, "pm2");
}

export async function pm2Stop(projectName: string): Promise<void> {
  const pm2Name = `scws-${projectName}`;
  try {
    await execFileAsync("pm2", ["stop", pm2Name], { timeout: 10_000 });
    log(`PM2 stopped: ${pm2Name}`, "pm2");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("not found")) throw err;
    log(`PM2 process not found: ${pm2Name}`, "pm2");
  }
}

export async function pm2Restart(projectName: string): Promise<void> {
  const pm2Name = `scws-${projectName}`;
  await execFileAsync("pm2", ["restart", pm2Name], { timeout: 10_000 });
  log(`PM2 restarted: ${pm2Name}`, "pm2");
}

export async function pm2Delete(projectName: string): Promise<void> {
  const pm2Name = `scws-${projectName}`;
  try {
    await execFileAsync("pm2", ["delete", pm2Name], { timeout: 10_000 });
    await execFileAsync("pm2", ["save"], { timeout: 10_000 });
    log(`PM2 deleted: ${pm2Name}`, "pm2");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("not found")) throw err;
  }
}

export async function pm2Logs(projectName: string, lines: number): Promise<string> {
  const pm2Name = `scws-${projectName}`;
  try {
    const { stdout } = await execFileAsync("pm2", ["logs", pm2Name, "--lines", String(lines), "--nostream"], {
      timeout: 10_000,
    });
    return stdout;
  } catch {
    return "";
  }
}

export async function pm2List(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"], { timeout: 10_000 });
    return stdout;
  } catch {
    return "[]";
  }
}
