import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

async function main() {
  const start = performance.now();

  await build({
    entryPoints: [path.join(root, "src/index.ts")],
    outfile: path.join(root, "dist/index.js"),
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: true,
    minify: false,
    external: [],
  });

  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`Built dist/index.js in ${elapsed}ms`);
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
