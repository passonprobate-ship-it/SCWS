import { build } from "esbuild";
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
