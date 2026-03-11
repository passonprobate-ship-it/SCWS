import * as esbuild from "esbuild";

async function build() {
  const result = await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: "dist/index.cjs",
    sourcemap: true,
    minify: false,
    external: ["pg-native"],
  });

  if (result.errors.length > 0) {
    console.error("Build failed:", result.errors);
    process.exit(1);
  }

  console.log("Build complete: dist/index.cjs");
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
