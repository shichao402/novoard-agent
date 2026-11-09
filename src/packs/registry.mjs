/**
 * 能力包注册表（ADR-0019 §1）：<packsDir>/<id>/toolset.json。
 * 每次查询都从盘上读 manifest，不做缓存：安装、更新、删除包之后立即生效（A5）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SUPPORTED_SCHEMA_VERSION = 1;

export function parseUses(uses) {
  const text = String(uses ?? "");
  const slash = text.indexOf("/");
  if (slash <= 0) return null;
  return { packId: text.slice(0, slash), toolId: text.slice(slash + 1) };
}

export function createPackRegistry({ packsDir } = {}) {
  function rootOf(packId) {
    return packsDir ? join(packsDir, packId) : null;
  }

  /** → { ok: true, root, manifest } | { ok: false, code, reason } */
  function get(packId) {
    const root = rootOf(packId);
    const file = root ? join(root, "toolset.json") : null;
    if (!file || !existsSync(file)) {
      return { ok: false, code: "pack-missing", reason: `本机未安装能力包 ${packId}` };
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      return { ok: false, code: "manifest-invalid", reason: `能力包 ${packId} 的 toolset.json 无法解析：${error.message}` };
    }
    if (!manifest?.id || !Array.isArray(manifest.tools)) {
      return { ok: false, code: "manifest-invalid", reason: `能力包 ${packId} 的 toolset.json 缺少 id 或 tools` };
    }
    if (Number(manifest.schemaVersion ?? 1) > SUPPORTED_SCHEMA_VERSION) {
      return {
        ok: false,
        code: "schema-too-new",
        reason: `能力包 ${packId} schemaVersion=${manifest.schemaVersion} 高于本机支持的 ${SUPPORTED_SCHEMA_VERSION}，请升级 agent`,
      };
    }
    return { ok: true, root, manifest };
  }

  function lookupTool(packId, toolId) {
    const pack = get(packId);
    if (!pack.ok) return null;
    return pack.manifest.tools.find((t) => t.id === toolId) ?? null;
  }

  /** 本机已装的包 id（目录下有 toolset.json 的子目录）。 */
  function list() {
    if (!packsDir || !existsSync(packsDir)) return [];
    return readdirSync(packsDir).filter((name) => {
      if (name.startsWith(".")) return false;
      try {
        return statSync(join(packsDir, name)).isDirectory() && existsSync(join(packsDir, name, "toolset.json"));
      } catch {
        return false;
      }
    });
  }

  return { get, lookupTool, list, rootOf, packsDir };
}
