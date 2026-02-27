import { build as esbuild } from "esbuild";
import { rm, readFile, copyFile } from "fs/promises";

const allowlist = [
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "pg",
  "uuid",
  "ws",
  "zod",
  "zod-validation-error",
];

async function buildDaemon() {
  await rm("dist", { recursive: true, force: true });

  console.log("Building SPAWN daemon...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
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
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  console.log("Copying dashboard.html...");
  await copyFile("daemon/dashboard.html", "dist/dashboard.html");

  console.log("Build complete: dist/index.cjs + dist/dashboard.html");
}

buildDaemon().catch((err) => {
  console.error(err);
  process.exit(1);
});
