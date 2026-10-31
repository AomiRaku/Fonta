import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const [major, minor] = String(config.version).split(".");
const displayVersion = `${major}.${minor}`;
const expected = `FontFox_${displayVersion}_x64.exe`;
const bundleDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");

if (!existsSync(bundleDir)) {
  console.error(`[installer] 找不到 NSIS 输出目录：${bundleDir}`);
  process.exit(1);
}
const candidates = readdirSync(bundleDir)
  .filter((name) => name.toLowerCase().endsWith(".exe") && name !== expected)
  .map((name) => ({ name, path: join(bundleDir, name), time: statSync(join(bundleDir, name)).mtimeMs }))
  .sort((a, b) => b.time - a.time);
if (candidates.length === 0) {
  if (existsSync(join(bundleDir, expected))) {
    console.log(`[installer] 已是目标文件名：${expected}`);
    process.exit(0);
  }
  console.error(`[installer] 没有可重命名的安装包；期望 ${expected}`);
  process.exit(1);
}
const source = candidates[0].path;
const target = join(bundleDir, expected);
if (existsSync(target)) unlinkSync(target);
renameSync(source, target);
console.log(`[installer] ${candidates[0].name} → ${expected}`);
