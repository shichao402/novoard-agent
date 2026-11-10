/**
 * target 诊断（PRD-7 A6）：在真正运行之前判断 uses step 能不能跑，并告诉用户该点哪里。
 * 一共六种 code，全部是 error 级别（会失败的事）：
 *   git-missing          包没装，本机也没有 git，装不了
 *   pack-missing         包没装，Hub 登记了来源，点「安装」即可
 *   source-unknown       包没装，Hub 也没登记来源
 *   deps-not-ready       包装了，但 python 依赖没准备好
 *   tool-missing         包里没有这个工具，或 manifest 读不了 / schemaVersion 高于本机
 *   platform-unsupported 工具不支持本机平台
 * 参数错误、remoteWrite 审批这类定义错误不在这里，它们在保存时就被拒绝（validateUsesSteps）。
 */
import { spawnSync } from "node:child_process";
import { parseUses } from "./registry.mjs";
import { depsStatus } from "./deps.mjs";
import { platformSupported } from "./invoke.mjs";

export const DIAG_CODES = ["git-missing", "pack-missing", "source-unknown", "deps-not-ready", "tool-missing", "platform-unsupported"];

/** 本机有没有 git（只探测一次）。 */
export function createGitCheck({ spawn = spawnSync, env = process.env } = {}) {
  let cached = null;
  return () => {
    if (cached === null) {
      try {
        const r = spawn("git", ["--version"], { env, stdio: "ignore", windowsHide: true, timeout: 10_000 });
        cached = r.status === 0;
      } catch {
        cached = false;
      }
    }
    return cached;
  };
}

/**
 * @param registry createPackRegistry 实例
 * @param sources  createSourcesCache 实例（get(id)）
 * @param gitAvailable () => boolean
 */
export function createDiagnoser({ registry, sources = null, platform = process.platform, gitAvailable = createGitCheck() } = {}) {
  function problem(step, uses, code, message, action) {
    return { step, uses, code, level: "error", message, action };
  }

  /** 诊断一组（已展开的）steps。step 编号从 1 开始，与界面一致。 */
  function diagnoseSteps(steps) {
    const out = [];
    (Array.isArray(steps) ? steps : []).forEach((s, i) => {
      if (typeof s?.uses !== "string") return;
      const ref = parseUses(s.uses);
      if (!ref) return;
      const n = i + 1;
      const { packId, toolId } = ref;
      const pack = registry?.get(packId) ?? { ok: false, code: "pack-missing" };
      if (!pack.ok) {
        if (pack.code === "pack-missing") {
          const known = Boolean(sources?.get?.(packId));
          if (!known) {
            out.push(problem(n, s.uses, "source-unknown", `本机未安装能力包 ${packId}，Hub 也没有登记它的来源`, `到 Hub 管理台「能力包来源」页添加 ${packId}，再到本机控制台点「安装」。`));
          } else if (!gitAvailable()) {
            out.push(problem(n, s.uses, "git-missing", `本机未安装能力包 ${packId}，而且找不到 git，无法安装`, "先在本机安装 git，再到本机控制台点「安装」。"));
          } else {
            out.push(problem(n, s.uses, "pack-missing", `本机未安装能力包 ${packId}`, "到本机控制台点「安装」即可。"));
          }
          return;
        }
        const action = pack.code === "schema-too-new" ? "升级 novoard-agent 后再试。" : "到本机控制台「能力包」页点「更新」，仍不行就删除后重新安装。";
        out.push(problem(n, s.uses, "tool-missing", pack.reason, action));
        return;
      }
      const tool = pack.manifest.tools.find((t) => t.id === toolId);
      if (!tool) {
        out.push(problem(n, s.uses, "tool-missing", `能力包 ${packId} 中没有工具 ${toolId}，可能版本过旧`, "到本机控制台「能力包」页点「更新」。"));
        return;
      }
      if (!platformSupported(tool, platform)) {
        out.push(problem(n, s.uses, "platform-unsupported", `${s.uses} 不支持本机平台 ${platform}（只支持 ${tool.platforms.join("、")}）`, "把这个 target 放到支持的机器上，或删掉这一步。"));
        return;
      }
      const deps = depsStatus(pack.root, pack.manifest);
      if (!deps.ready) {
        out.push(problem(n, s.uses, "deps-not-ready", `能力包 ${packId} 依赖未就绪（${deps.reason}）`, "到本机控制台「能力包」页点「更新」重新准备依赖。"));
      }
    });
    return out;
  }

  function diagnoseTarget(target) {
    return diagnoseSteps(target?.expanded ?? target?.steps);
  }

  /** → { [targetId]: problems[] }，只收录有问题的 target。 */
  function diagnoseAll(targets) {
    const out = {};
    for (const [id, t] of Object.entries(targets ?? {})) {
      const problems = diagnoseTarget(t);
      if (problems.length) out[id] = problems;
    }
    return out;
  }

  /** 有 error 的 target id（Card 排除用）。 */
  function unavailable(targets) {
    return Object.entries(diagnoseAll(targets))
      .filter(([, list]) => list.some((p) => p.level === "error"))
      .map(([id]) => id);
  }

  return { diagnoseSteps, diagnoseTarget, diagnoseAll, unavailable };
}

/** 诊断结果拼成给人看的文字：每个问题一行说明 + 一行该怎么做。 */
export function formatProblems(problems) {
  return (problems ?? []).map((p) => `第 ${p.step} 步 ${p.uses}：${p.message}。\n${p.action}`).join("\n");
}
