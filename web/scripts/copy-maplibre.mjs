// Copies MapLibre's worker and stylesheet into public/maplibre.
// MapLibre builds its worker URL at run time, which bundlers cannot follow, so the
// app points it at this copy (see src/lib/maplibre.ts). Runs on postinstall.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "maplibre-gl", "dist");
const dest = join(root, "public", "maplibre");

if (!existsSync(src)) {
  console.warn(`[copy-maplibre] ${src} not found; skipping.`);
  process.exit(0);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl.css"]) {
  copyFileSync(join(src, file), join(dest, file));
}
console.log(`[copy-maplibre] copied MapLibre worker and CSS to ${dest}`);
