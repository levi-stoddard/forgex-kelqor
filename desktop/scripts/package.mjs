// Packages the KELQOR desktop app for Windows: the app folder (desktop/out/KELQOR-win32-x64) and a per-user
// installer (desktop/out/installer/KELQOR-Setup-<version>.exe). Both are unsigned internal development builds;
// installing needs no administrator rights and touches no system-wide setting.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { createWindowsInstaller } from "electron-winstaller";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(desktop, "..");
const out = path.join(desktop, "out");
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, "node_modules/electron/package.json"), "utf8")).version;
const icon = path.join(desktop, "dist/assets/kelqor.ico");

execFileSync(process.execPath, [path.join(desktop, "scripts/build.mjs")], { stdio: "inherit" });
// Earlier installers are kept in out/kept-installers for rollback (an installer for an older version reinstalls it).
const kept = path.join(out, "kept-installers");
const previous = path.join(out, "installer");
if (fs.existsSync(previous)) {
  for (const f of fs.readdirSync(previous).filter((n) => /^KELQOR-Setup-.+\.exe$/.test(n))) {
    fs.mkdirSync(kept, { recursive: true });
    if (!fs.existsSync(path.join(kept, f))) fs.copyFileSync(path.join(previous, f), path.join(kept, f));
  }
}
// Replace only the previous package and installer; acceptance results in out/acceptance stay.
for (const dir of ["KELQOR-win32-x64", "installer"]) fs.rmSync(path.join(out, dir), { recursive: true, force: true });

// The app ships only its manifest and the built dist folder; sources, scripts and build output stay behind.
const [appDir] = await packager({
  dir: desktop,
  out,
  name: "KELQOR",
  executableName: "KELQOR",
  platform: "win32",
  arch: "x64",
  electronVersion,
  appVersion: pkg.version,
  appCopyright: "KELQOR internal development build",
  icon,
  asar: true,
  prune: true,
  overwrite: true,
  ignore: [/^\/src($|\/)/, /^\/scripts($|\/)/, /^\/out($|\/)/, /^\/tsconfig\.json$/],
  win32metadata: { CompanyName: "KELQOR", ProductName: "KELQOR", FileDescription: "KELQOR Command Center", InternalName: "KELQOR", OriginalFilename: "KELQOR.exe" },
});
console.log(`Packaged ${path.relative(root, appDir)}`);

await createWindowsInstaller({
  appDirectory: appDir,
  outputDirectory: path.join(out, "installer"),
  exe: "KELQOR.exe",
  name: "kelqor",
  title: "KELQOR",
  authors: "KELQOR",
  description: pkg.description,
  version: pkg.version,
  setupExe: `KELQOR-Setup-${pkg.version}.exe`,
  setupIcon: icon,
  noMsi: true,
});
const setup = path.join(out, "installer", `KELQOR-Setup-${pkg.version}.exe`);
console.log(`Installer ${path.relative(root, setup)} (${(fs.statSync(setup).size / 1024 / 1024).toFixed(1)} MB)`);
