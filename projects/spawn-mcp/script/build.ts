import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/index.cjs",
  external: ["pg-native"],
  minify: false,
  sourcemap: true,
  target: "node20",
});

console.log("Build complete: dist/index.cjs");
