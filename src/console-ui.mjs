/**
 * 三端共用的控制台静态资源。
 * Windows / macOS 的 Tauri 壳内嵌同一份构建结果；Linux 和无壳浏览器由本机 Agent 直接提供。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/** 打包后的控制台目录：显式指定、可执行文件旁的 ui/、或仓库里的 desktop/dist。 */
export function resolveConsoleRoot(env = process.env) {
  const explicit = String(env.NOVOARD_UI_DIST ?? "").trim();
  if (explicit && existsSync(join(explicit, "index.html"))) return resolve(explicit);
  const beside = join(resolve(process.execPath, ".."), "ui");
  if (existsSync(join(beside, "index.html"))) return beside;
  try {
    const repo = fileURLToPath(new URL("../desktop/dist", import.meta.url));
    if (existsSync(join(repo, "index.html"))) return resolve(repo);
  } catch {
    return null;
  }
  return null;
}

/**
 * 提供控制台文件。命中时写完响应并返回 true。
 * 没有扩展名的路径回落到 index.html，方便直接打开控制台地址。
 */
export function serveConsole(root, req, res, url) {
  if (!root || (req.method !== "GET" && req.method !== "HEAD")) return false;
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  if (pathname.includes("\0")) return false;
  const rootResolved = resolve(root);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^[/\\]+/, "");
  let file = resolve(rootResolved, relativePath);
  if (!inside(rootResolved, file)) return false;
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (extname(relativePath)) return false;
    file = join(rootResolved, "index.html");
    if (!existsSync(file)) return false;
  }
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": extname(file).toLowerCase() === ".html" ? "no-store" : "public, max-age=3600",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}

function inside(root, file) {
  const rel = relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
