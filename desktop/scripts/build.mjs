// Builds the KELQOR desktop app into desktop/dist: the main process and preload (bundled for Electron), and the
// packaged interface (React bundle, compiled Tailwind CSS from the web app's theme, the HTML page and the icons).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "@tailwindcss/postcss";
import { build } from "esbuild";
import postcss from "postcss";
import { writeIcons } from "./icon.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(desktop, "dist");
const tsconfig = path.join(desktop, "tsconfig.json");

fs.rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: { main: path.join(desktop, "src/main/main.ts"), preload: path.join(desktop, "src/preload/preload.ts") },
  outdir: dist,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  tsconfig,
  // The project folder whose backend the app starts: where this build was made, or KELQOR_BUILD_PROJECT_DIR for a build
  // staged elsewhere (KELQOR_PROJECT_DIR overrides it at run time).
  define: { __KELQOR_PROJECT_DIR__: JSON.stringify(path.resolve(process.env.KELQOR_BUILD_PROJECT_DIR || path.resolve(desktop, ".."))) },
  legalComments: "none",
  logLevel: "warning",
});

await build({
  entryPoints: [path.join(desktop, "src/renderer/main.tsx")],
  outfile: path.join(dist, "renderer/app.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome130",
  jsx: "automatic",
  minify: true,
  tsconfig,
  alias: { "next/link": path.join(desktop, "src/renderer/shims/next-link.tsx") },
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "warning",
});

const cssInput = path.join(desktop, "src/renderer/styles.css");
const css = await postcss([tailwind({ base: path.join(desktop, "src"), optimize: { minify: true } })]).process(fs.readFileSync(cssInput, "utf8"), { from: cssInput });
fs.writeFileSync(path.join(dist, "renderer/app.css"), css.css);
fs.copyFileSync(path.join(desktop, "src/renderer/index.html"), path.join(dist, "renderer/index.html"));
writeIcons(path.join(dist, "assets"));

const size = (f) => `${(fs.statSync(path.join(dist, f)).size / 1024).toFixed(0)} KB`;
console.log(`Built desktop/dist: main ${size("main.cjs")}, preload ${size("preload.cjs")}, app.js ${size("renderer/app.js")}, app.css ${size("renderer/app.css")}`);
