/**
 * targets 定义存储（M6 editor 后端）：读、校验、备份、原子写、从盘重装载。
 * 双入口同一条路：YAML 源码模式（原文落盘，保留注释）/ 表单模式（JSON → yaml stringify 生成）。
 * 纪律一延伸：校验不通过的定义永不上盘（schema 校验 + 模板引用预检）。
 * 无漂移保证：保存后从盘走完整装载路径（loadTargets → expandSteps → deriveCard），
 *   编辑生效路径与 agent 重启装载路径是同一份代码。
 * 备份策略：targets.yaml.bak 单份滚动（上次内容），个人项目纪律。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { loadTargets, validateTargetsData, expandSteps, deriveCard } from "./card.mjs";

export function createTargetsStore({ agentDir, agentId, log = console } = {}) {
  if (!agentDir) throw new Error("targets-store 需要 agentDir");
  const targetsPath = join(agentDir, "targets.yaml");
  const backupPath = join(agentDir, "targets.yaml.bak");

  /** 当前盘上定义（editor 数据源）：YAML 原文 + 解析后 raw targets + 平台（前端语法提示用）。 */
  function read() {
    if (!existsSync(targetsPath)) return { ok: false, reason: `targets.yaml 不存在：${targetsPath}` };
    const yamlText = readFileSync(targetsPath, "utf8");
    try {
      const res = validateTargetsData(parse(yamlText));
      if (!res.ok) return { ok: false, reason: res.reason, errors: res.errors };
      return { ok: true, yaml: yamlText, targets: res.targets, platform: process.platform };
    } catch (error) {
      return { ok: false, reason: `YAML 解析失败：${error.message}`, errors: [String(error.message)] };
    }
  }

  /**
   * 保存：{ yaml } 源码模式 | { targets } 表单模式。
   * 流程：归一文本 → parse → schema 校验 → 模板引用预检（不合法即拒，不上盘）
   *   → .bak 滚动备份 → tmp 原子写（rename，半写文件不可见）
   *   → 从盘重装载，返回 { raw, expanded, card } 交装配层热替换与 card.update 上报。
   */
  function save({ yaml: yamlText, targets: formTargets } = {}) {
    let text;
    if (typeof yamlText === "string") text = yamlText;
    else if (formTargets && typeof formTargets === "object") text = stringify({ targets: formTargets });
    else return { ok: false, errors: ["需要 yaml 文本或 targets 对象"] };

    let data;
    try {
      data = parse(text);
    } catch (error) {
      return { ok: false, errors: [`YAML 解析失败：${error.message}`] };
    }
    const check = validateTargetsData(data);
    if (!check.ok) return { ok: false, errors: check.errors ?? [check.reason] };

    // 模板引用预检：引用不存在的模板在写盘前拦下（与重启装载同一判据）
    const pre = expandSteps({ targets: check.targets, agentDir });
    if (!pre.ok) return { ok: false, errors: [pre.reason] };

    if (existsSync(targetsPath)) copyFileSync(targetsPath, backupPath);
    const tmpPath = `${targetsPath}.tmp`;
    writeFileSync(tmpPath, text, "utf8");
    renameSync(tmpPath, targetsPath);

    // 从盘重装载（与启动装载同一份代码，无漂移）
    const loaded = loadTargets({ agentDir });
    if (!loaded.ok) return { ok: false, errors: [loaded.reason] };
    const expanded = expandSteps({ targets: loaded.targets, agentDir });
    if (!expanded.ok) return { ok: false, errors: [expanded.reason] };
    const card = deriveCard({ agentId, targets: loaded.targets, agentDir });
    log.info?.(`[editor] targets.yaml 已保存并重装载（${Object.keys(loaded.targets).length} 个 target）`);
    return { ok: true, raw: loaded.targets, expanded: expanded.targets, card };
  }

  return { read, save, targetsPath, backupPath };
}
