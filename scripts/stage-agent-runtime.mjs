/**
 * 把会话进程和 CodeBuddy SDK 放到桌面壳资源目录。
 * SEA 不能把 CLI 打进单个 exe，安装后的客户端用系统 Node 跑这份资源。
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "desktop", "src-tauri", "resources", "agent-runtime");
const FILES = ["chat-worker.mjs", "session-store.mjs", "chat-events.mjs", "novoard-tools.mjs", "novoard-skill.mjs", "jsonl.mjs", "codebuddy-config.mjs", "edition.mjs", "edition.gen.mjs"];

mkdirSync(DEST, { recursive: true });
for (const file of FILES) {
  cpSync(join(ROOT, "src", file), join(DEST, file));
}

const modules = join(DEST, "node_modules");
const marker = join(modules, "@tencent-ai", "agent-sdk", "package.json");
if (!existsSync(marker)) {
  console.log("复制 CodeBuddy SDK 到桌面资源，第一次会比较久。");
  cpSync(join(ROOT, "node_modules"), modules, { recursive: true, dereference: true });
}
console.log(`会话运行时已就位：${DEST}`);
