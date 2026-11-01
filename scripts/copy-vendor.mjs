// Location in project: scripts/copy-vendor.mjs
// Copies the small ffmpeg.wasm JS wrappers into public/vendor so they are served
// from your own domain (browsers block cross-origin module workers).
// The big ~31 MB ffmpeg-core.wasm is NOT copied (Pages has a 25 MiB per-file limit);
// it is loaded from jsDelivr at runtime instead.
import { cpSync, rmSync, existsSync } from "node:fs";

const copies = [
  ["node_modules/@ffmpeg/ffmpeg/dist/esm", "public/vendor/ffmpeg"],
  ["node_modules/@ffmpeg/util/dist/esm", "public/vendor/util"],
];

rmSync("public/vendor", { recursive: true, force: true });

for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.error(`✗ Missing ${from}. Run "npm install" first.`);
    process.exit(1);
  }
  cpSync(from, to, { recursive: true });
  console.log(`✓ ${from} -> ${to}`);
}
