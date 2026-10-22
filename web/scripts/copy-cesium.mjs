// Copies Cesium's prebuilt bundle and static assets into public/cesium.
// Runs on postinstall so `npm install` is all a fresh checkout needs.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "cesium", "Build", "Cesium");
const dest = join(root, "public", "cesium");

if (!existsSync(src)) {
  console.warn(`[copy-cesium] ${src} not found; skipping.`);
  process.exit(0);
}
rmSync(dest, { recursive: true, force: true });
for (const part of ["Cesium.js", "Workers", "ThirdParty", "Assets", "Widgets"]) {
  cpSync(join(src, part), join(dest, part), { recursive: true });
}
console.log(`[copy-cesium] copied Cesium build to ${dest}`);
