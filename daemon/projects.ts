import { execFile } from "child_process";
import { promisify } from "util";
import { randomBytes } from "crypto";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { storage } from "./storage.js";
import { log } from "./logger.js";
import { pm2Start, pm2Stop, pm2Restart, pm2Delete, pm2Logs } from "./pm2.js";
import { addProjectNginx, removeProjectNginx } from "./nginx.js";
import type { Project } from "../shared/schema.js";

const execFileAsync = promisify(execFile);

const PROJECTS_DIR = "/var/www/scws/projects";

interface CreateProjectOpts {
  name: string;
  displayName: string;
  description?: string;
  framework?: string;
  gitRepo?: string;
  needsDb?: boolean;
}

// ── Scaffolds ─────────────────────────────────────────────────────

function expressScaffold(name: string, port: number): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name,
      version: "1.0.0",
      type: "module",
      scripts: {
        dev: "tsx src/index.ts",
        build: "tsx script/build.ts",
        start: "node dist/index.js",
      },
      dependencies: { express: "^5.0.1" },
      devDependencies: {
        "@types/express": "^5.0.0",
        "@types/node": "^20.19.0",
        esbuild: "^0.25.0",
        tsx: "^4.20.5",
        typescript: "5.6.3",
      },
    }, null, 2),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        esModuleInterop: true,
        strict: true,
        skipLibCheck: true,
        outDir: "dist",
        noEmit: true,
        lib: ["ES2022"],
        types: ["node"],
      },
      include: ["src/**/*.ts"],
    }, null, 2),
    "src/index.ts": `import express from "express";

const app = express();
const PORT = parseInt(process.env.PORT || "${port}", 10);
const BASE_URL = process.env.BASE_URL || "";

app.get(BASE_URL + "/", (_req, res) => {
  res.json({ project: "${name}", status: "running" });
});

app.get(BASE_URL + "/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(\`${name} listening on port \${PORT}\`);
});
`,
    "script/build.ts": `import { build } from "esbuild";
await build({
  entryPoints: ["src/index.ts"],
  platform: "node",
  bundle: true,
  format: "esm",
  outfile: "dist/index.js",
  external: ["express"],
  minify: true,
});
console.log("Build complete: dist/index.js");
`,
    "CLAUDE.md": `# ${name}\n\nExpress project on SCWS. Port ${port}. Base URL: /${name}\n`,
  };
}

function staticScaffold(name: string): Record<string, string> {
  return {
    "index.html": `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <base href="/${name}/">
  <title>${name}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #0a0a0a; color: #fafafa; }
    h1 { font-size: 2rem; font-weight: 300; }
  </style>
</head>
<body>
  <h1>${name}</h1>
</body>
</html>`,
    "CLAUDE.md": `# ${name}\n\nStatic site on SCWS. Served at /${name}\n`,
  };
}

function nextScaffold(name: string, port: number): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name,
      version: "0.1.0",
      private: true,
      scripts: { dev: "next dev", build: "next build", start: "next start" },
      dependencies: { next: "^16.1.6", react: "^19.2.3", "react-dom": "^19.2.3" },
      devDependencies: { "@types/node": "^20", "@types/react": "^19", typescript: "^5" },
    }, null, 2),
    "next.config.ts": `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {\n  basePath: "/${name}",\n};\n\nexport default nextConfig;\n`,
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], allowJs: true, skipLibCheck: true,
        strict: true, noEmit: true, esModuleInterop: true, module: "esnext",
        moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true,
        jsx: "preserve", incremental: true, plugins: [{ name: "next" }],
        paths: { "@/*": ["./src/*"] },
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
      exclude: ["node_modules"],
    }, null, 2),
    "src/app/layout.tsx": `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n`,
    "src/app/page.tsx": `export default function Home() {\n  return <main><h1>${name}</h1><p>Running on SCWS</p></main>;\n}\n`,
    "CLAUDE.md": `# ${name}\n\nNext.js project on SCWS. Port ${port}. Base path: /${name}\n`,
  };
}

// ── Framework & DB Detection ─────────────────────────────────────

async function detectFramework(projectDir: string): Promise<string> {
  const pkgPath = `${projectDir}/package.json`;
  if (!existsSync(pkgPath)) {
    return existsSync(`${projectDir}/index.html`) ? "static" : "express";
  }
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["next"]) return "next";
    if (deps["express"] || deps["fastify"] || deps["koa"] || deps["hono"]) return "express";
    if (deps["vite"] || deps["@vitejs/plugin-react"]) return "static";
    if (deps["react-scripts"]) return "static";
    return "express";
  } catch {
    return "express";
  }
}

async function detectNeedsDb(projectDir: string): Promise<boolean> {
  if (existsSync(`${projectDir}/drizzle.config.ts`) || existsSync(`${projectDir}/drizzle.config.js`)) return true;
  if (existsSync(`${projectDir}/prisma/schema.prisma`)) return true;
  const envExample = `${projectDir}/.env.example`;
  if (existsSync(envExample)) {
    const content = await readFile(envExample, "utf-8");
    if (content.includes("DATABASE_URL")) return true;
  }
  return false;
}

async function injectNextBasePath(projectDir: string, name: string): Promise<void> {
  const configFiles = ["next.config.ts", "next.config.js", "next.config.mjs"];
  let configPath: string | null = null;
  for (const f of configFiles) {
    if (existsSync(`${projectDir}/${f}`)) {
      configPath = `${projectDir}/${f}`;
      break;
    }
  }

  if (!configPath) {
    await writeFile(`${projectDir}/next.config.ts`,
      `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {\n  basePath: "/${name}",\n};\n\nexport default nextConfig;\n`
    );
    log(`Created next.config.ts with basePath: /${name}`, "project");
    return;
  }

  let content = await readFile(configPath, "utf-8");

  if (content.includes("basePath")) {
    content = content.replace(/basePath:\s*["'][^"']*["']/, `basePath: "/${name}"`);
  } else {
    // Try typed pattern first: `const x: NextConfig = {`
    const typed = content.replace(
      /const\s+\w+:\s*NextConfig\s*=\s*\{/,
      `$&\n  basePath: "/${name}",`
    );
    if (typed !== content) {
      content = typed;
    } else {
      // Fallback: `export default {` or `module.exports = {`
      content = content.replace(
        /(export\s+default\s*\{|module\.exports\s*=\s*\{)/,
        `$1\n  basePath: "/${name}",`
      );
    }
  }

  await writeFile(configPath, content, "utf-8");
  log(`Injected basePath: /${name} into ${configPath}`, "project");
}

// ── Short Name Generation ────────────────────────────────────────

export function generateShortName(repoUrl: string): string {
  let name = repoUrl.split("/").pop() || "project";
  name = name.replace(/\.git$/, "");

  // Strip common prefixes/suffixes
  name = name.replace(/^(app\.|the-)/, "");
  name = name.replace(/(\.(cloud|com|io|org|dev|app))$/i, "");
  name = name.replace(/-(app|frontend|web|site|client|ui)$/i, "");

  // Normalize
  name = name.toLowerCase().replace(/\./g, "-").replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

  // Truncate if too long
  if (name.length > 20) {
    const parts = name.split("-");
    name = parts.slice(0, 3).join("-");
    if (name.length > 20) name = name.substring(0, 20).replace(/-$/, "");
  }

  return name || "project";
}

// ── Auto-Import from URL ─────────────────────────────────────────

export async function importFromUrl(repoUrl: string): Promise<Project> {
  // Generate short name, resolve conflicts
  const baseName = generateShortName(repoUrl);
  let name = baseName;
  let suffix = 2;
  while (await storage.getProject(name)) {
    name = `${baseName}-${suffix++}`;
  }

  const projectDir = `${PROJECTS_DIR}/${name}`;
  log(`Importing "${name}" from ${repoUrl}...`, "project");

  // Clone
  await mkdir(projectDir, { recursive: true });
  await execFileAsync("git", ["clone", repoUrl, projectDir], { timeout: 180_000 });
  log(`Cloned ${repoUrl} → ${name}`, "project");

  // Detect framework
  const framework = await detectFramework(projectDir);
  log(`Detected framework: ${framework}`, "project");

  // Detect DB needs
  const needsDb = await detectNeedsDb(projectDir);

  // Allocate port
  const port = await storage.getNextPort();

  // Create DB if needed
  let dbName: string | undefined;
  if (needsDb) {
    dbName = `${name.replace(/-/g, "_")}_db`;
    try {
      await execFileAsync("sudo", ["-u", "postgres", "psql", "-c",
        `CREATE DATABASE ${dbName} OWNER scws;`], { timeout: 10_000 });
      log(`Created database: ${dbName}`, "project");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already exists")) throw err;
    }
  }

  // Inject basePath for Next.js
  if (framework === "next") {
    await injectNextBasePath(projectDir, name);
  }

  // Generate .env
  const envLines = [`PORT=${port}`, `BASE_URL=/${name}`, `NODE_ENV=production`];
  if (dbName) {
    envLines.push(`DATABASE_URL=postgresql://scws:${process.env.SCWS_DB_PASSWORD || "scws"}@localhost:5432/${dbName}`);
  }
  if (framework === "next") {
    envLines.push(`AUTH_SECRET=${randomBytes(32).toString("hex")}`);
    envLines.push(`AUTH_URL=https://scws.duckdns.org/${name}`);
    envLines.push(`NEXTAUTH_URL=https://scws.duckdns.org/${name}`);
  }
  await writeFile(`${projectDir}/.env`, envLines.join("\n") + "\n", "utf-8");

  // npm install — include devDeps (needed for build tools like typescript)
  if (existsSync(`${projectDir}/package.json`)) {
    log(`Installing dependencies for ${name}...`, "project");
    const installEnv = { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" };
    delete installEnv.NODE_ENV; // Ensure devDeps are installed (NODE_ENV=production skips them)
    await execFileAsync("npm", ["install"], {
      cwd: projectDir,
      timeout: 300_000,
      env: installEnv,
    });
  }

  // Determine commands
  let entryFile = "dist/index.js";
  let buildCommand: string | null = "npm run build";
  let startCommand: string | null = null;

  if (framework === "next") {
    entryFile = ".next/server.js";
    startCommand = "npm start";
  } else if (framework === "static") {
    entryFile = "index.html";
    buildCommand = null;
    startCommand = null;
  }

  // Display name from repo
  const displayName = repoUrl.split("/").pop()?.replace(/\.git$/, "") || name;

  // Save to DB
  const project = await storage.createProject({
    name,
    displayName,
    description: `Imported from ${repoUrl}`,
    port,
    status: "stopped",
    framework,
    gitRepo: repoUrl,
    dbName: dbName || null,
    entryFile,
    buildCommand,
    startCommand,
    envVars: "{}",
    deployTargets: "[]",
  });

  // Setup nginx (pass framework for Next.js-specific config)
  await addProjectNginx(name, port, framework);

  // Log activity
  await storage.logActivity({
    projectId: project.id,
    action: "imported",
    details: `Auto-imported ${framework} project from ${repoUrl} on port ${port}`,
  });

  log(`Project "${name}" imported successfully`, "project");
  return project;
}

// ── Create ────────────────────────────────────────────────────────

export async function createProject(opts: CreateProjectOpts): Promise<Project> {
  const { name, displayName, description, framework = "express", gitRepo, needsDb } = opts;

  // Check uniqueness
  const existing = await storage.getProject(name);
  if (existing) throw new Error(`Project "${name}" already exists`);

  // Allocate port
  const port = await storage.getNextPort();
  const projectDir = `${PROJECTS_DIR}/${name}`;

  log(`Creating project "${name}" (${framework}, port ${port})`, "project");

  // Create directory
  await mkdir(projectDir, { recursive: true });

  if (gitRepo) {
    // Clone from git
    await execFileAsync("git", ["clone", gitRepo, projectDir], { timeout: 120_000 });
    log(`Cloned ${gitRepo}`, "project");
  } else {
    // Scaffold based on framework
    let files: Record<string, string>;

    switch (framework) {
      case "static":
        files = staticScaffold(name);
        break;
      case "next":
        files = nextScaffold(name, port);
        break;
      case "express":
      default:
        files = expressScaffold(name, port);
        break;
    }

    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = `${projectDir}/${filePath}`;
      const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      await writeFile(fullPath, content, "utf-8");
    }
  }

  // Create database if requested
  let dbName: string | undefined;
  if (needsDb) {
    dbName = `${name.replace(/-/g, "_")}_db`;
    try {
      await execFileAsync("sudo", ["-u", "postgres", "psql", "-c",
        `CREATE DATABASE ${dbName} OWNER scws;`], { timeout: 10_000 });
      log(`Created database: ${dbName}`, "project");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already exists")) throw err;
    }
  }

  // Generate .env
  const envLines = [
    `PORT=${port}`,
    `BASE_URL=/${name}`,
    `NODE_ENV=production`,
  ];
  if (dbName) {
    envLines.push(`DATABASE_URL=postgresql://scws:${process.env.SCWS_DB_PASSWORD || "scws"}@localhost:5432/${dbName}`);
  }
  await writeFile(`${projectDir}/.env`, envLines.join("\n") + "\n", "utf-8");

  // Install dependencies (non-static projects) — include devDeps for build tools
  if (framework !== "static" && existsSync(`${projectDir}/package.json`)) {
    log(`Installing dependencies for ${name}...`, "project");
    const installEnv = { ...process.env };
    delete installEnv.NODE_ENV;
    await execFileAsync("npm", ["install"], { cwd: projectDir, timeout: 300_000, env: installEnv });
  }

  // Determine entry and build commands
  let entryFile = "dist/index.js";
  let buildCommand: string | undefined = "npm run build";
  let startCommand: string | undefined;

  if (framework === "next") {
    entryFile = ".next/server.js";
    startCommand = "npm start";
  } else if (framework === "static") {
    entryFile = "index.html";
    buildCommand = undefined;
    startCommand = undefined;
  }

  // Save to DB
  const project = await storage.createProject({
    name,
    displayName,
    description: description || "",
    port,
    status: "stopped",
    framework,
    gitRepo: gitRepo || null,
    dbName: dbName || null,
    entryFile,
    buildCommand: buildCommand || null,
    startCommand: startCommand || null,
    envVars: "{}",
    deployTargets: "[]",
  });

  // Setup nginx routing (pass framework for Next.js-specific config)
  await addProjectNginx(name, port, framework);

  // Log activity
  await storage.logActivity({
    projectId: project.id,
    action: "created",
    details: `Created ${framework} project "${displayName}" on port ${port}`,
  });

  log(`Project "${name}" created successfully`, "project");
  return project;
}

// ── Start ─────────────────────────────────────────────────────────

export async function startProject(name: string): Promise<void> {
  const project = await storage.getProject(name);
  if (!project) throw new Error(`Project "${name}" not found`);

  const envVars = JSON.parse(project.envVars) as Record<string, string>;
  if (project.dbName) {
    envVars.DATABASE_URL = `postgresql://scws:${process.env.SCWS_DB_PASSWORD || "scws"}@localhost:5432/${project.dbName}`;
  }

  await pm2Start(name, project.entryFile, project.port, envVars, project.startCommand);
  await storage.updateProject(name, { status: "running" });
  await storage.logActivity({
    projectId: project.id,
    action: "started",
    details: `Started on port ${project.port}`,
  });
}

// ── Stop ──────────────────────────────────────────────────────────

export async function stopProject(name: string): Promise<void> {
  const project = await storage.getProject(name);
  if (!project) throw new Error(`Project "${name}" not found`);

  await pm2Stop(name);
  await storage.updateProject(name, { status: "stopped" });
  await storage.logActivity({
    projectId: project.id,
    action: "stopped",
    details: "Stopped",
  });
}

// ── Restart ───────────────────────────────────────────────────────

export async function restartProject(name: string): Promise<void> {
  const project = await storage.getProject(name);
  if (!project) throw new Error(`Project "${name}" not found`);

  await pm2Restart(name);
  await storage.updateProject(name, { status: "running" });
  await storage.logActivity({
    projectId: project.id,
    action: "restarted",
    details: "Restarted",
  });
}

// ── Build ─────────────────────────────────────────────────────────

export async function buildProject(name: string): Promise<{ output: string }> {
  const project = await storage.getProject(name);
  if (!project) throw new Error(`Project "${name}" not found`);
  if (!project.buildCommand) throw new Error(`Project "${name}" has no build command`);

  const projectDir = `${PROJECTS_DIR}/${name}`;
  await storage.updateProject(name, { status: "building" });

  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-c", project.buildCommand], {
      cwd: projectDir,
      timeout: 300_000,
      env: { ...process.env, NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=4096" },
    });

    await storage.updateProject(name, {
      status: "stopped",
      lastBuildAt: new Date(),
    });
    await storage.logActivity({
      projectId: project.id,
      action: "built",
      details: "Build succeeded",
    });

    const output = (stdout + "\n" + stderr).trim();
    log(`Build completed for "${name}"`, "project");
    return { output };
  } catch (err: unknown) {
    await storage.updateProject(name, { status: "error" });
    const msg = err instanceof Error ? err.message : String(err);
    await storage.logActivity({
      projectId: project.id,
      action: "build_failed",
      details: msg,
    });
    throw new Error(`Build failed: ${msg}`);
  }
}

// ── Delete ────────────────────────────────────────────────────────

export async function deleteProject(name: string): Promise<void> {
  const project = await storage.getProject(name);
  if (!project) throw new Error(`Project "${name}" not found`);

  log(`Deleting project "${name}"...`, "project");

  // Stop and remove PM2 process
  await pm2Delete(name);

  // Remove nginx config
  await removeProjectNginx(name);

  // Remove project directory
  const projectDir = `${PROJECTS_DIR}/${name}`;
  if (existsSync(projectDir)) {
    await rm(projectDir, { recursive: true, force: true });
  }

  // Drop database if exists
  if (project.dbName) {
    try {
      await execFileAsync("sudo", ["-u", "postgres", "psql", "-c",
        `DROP DATABASE IF EXISTS ${project.dbName};`], { timeout: 10_000 });
      log(`Dropped database: ${project.dbName}`, "project");
    } catch (err: unknown) {
      log(`Failed to drop database ${project.dbName}: ${err}`, "error");
    }
  }

  // Remove from DB
  await storage.deleteProject(name);
  await storage.logActivity({
    action: "deleted",
    details: `Deleted project "${name}"`,
  });

  log(`Project "${name}" deleted`, "project");
}

// ── Logs ──────────────────────────────────────────────────────────

export async function getProjectLogs(name: string, lines: number): Promise<string> {
  const project = await storage.getProject(name);
  if (!project) throw new Error(`Project "${name}" not found`);
  return pm2Logs(name, lines);
}
