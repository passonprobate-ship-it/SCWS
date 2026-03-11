const { build } = require("esbuild");

build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  outfile: "dist/index.js",
  format: "cjs",
  sourcemap: true,
  external: ["pg-native"],
}).then(() => console.log("Build complete"));
