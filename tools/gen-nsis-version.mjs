import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const [major, minor] = String(config.version).split(".");
writeFileSync(
  join(root, "src-tauri", "nsis", "version.nsh"),
  `!define DISPLAYVERSION "${major}.${minor}"\n`,
  "utf8",
);
console.log(`[installer] display version ${major}.${minor}`);
