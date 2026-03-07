import { createRequire } from "module";
import { readFile, copyFile, mkdir } from "fs/promises";
import { resolve } from "path";

const daemonRequire = createRequire(resolve("daemon/package.json"));
const { build: esbuild } = daemonRequire("esbuild") as typeof import("esbuild");

const allowlist = [
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "pg",
  "uuid",
  "ws",
  "zod",
  "zod-validation-error",
];

async function buildDaemon() {
  await mkdir("daemon/dist", { recursive: true });

  console.log("Building SPAWN daemon...");
  const pkg = JSON.parse(await readFile("daemon/package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["daemon/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "daemon/dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.url": "import_meta_url",
    },
    banner: {
      js: "const import_meta_url = typeof __filename !== 'undefined' ? require('url').pathToFileURL(__filename).href : '';",
    },
    minify: true,
    external: externals,
    nodePaths: [resolve("daemon/node_modules")],
    logLevel: "info",
  });

  // dashboard.html lives in daemon/dist/ already (hand-maintained SPA, not compiled)
  // Only copy if a source version exists outside dist/
  try {
    await copyFile("daemon/dashboard.html", "daemon/dist/dashboard.html");
    console.log("Copied dashboard.html from daemon/ to daemon/dist/");
  } catch {
    console.log("dashboard.html already in daemon/dist/ (no source copy needed)");
  }

  console.log("Build complete: daemon/dist/index.cjs + daemon/dist/dashboard.html");
}

buildDaemon().catch((err) => {
  console.error(err);
  process.exit(1);
});
