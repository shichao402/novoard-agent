# ADR-0019: 能力包协议

- 状态：Accepted
- 日期：2026-11-09（2026-11-11 修订 §8、§9）
- 讨论来源：Hub ADR-0012（cronkit 被 novoard-agent 吸收）。领域工具外置为能力包后，需要一份包作者照着就能实现的协议

## Context

能力包和内核之间只在本机进程间通信，不经过 Hub，按 [ADR-0004](0004-contract-copy-boundary.md) 属于本仓自有概念。基线是 cronkit toolset schemaVersion 1（cronkit 仓 `src/core/toolset/types.ts`、`external.ts`、`validate.ts`），OSGToolset 已按它实现。

## Decision

所有能力包都在进程外运行，没有进程内特权通道。协议只增不改，OSGToolset 现状必须能零改动通过。

### 1. 目录与 manifest

包根目录放 `toolset.json`：

```json
{
  "id": "versionControl",
  "displayName": "版本控制",
  "schemaVersion": 1,
  "runtime": "node",
  "entry": "dist/pack.mjs",
  "tools": [
    {
      "id": "svn-update",
      "displayName": "SVN 更新",
      "idempotent": true,
      "requiresExclusiveWorkspace": true,
      "remoteWrite": false,
      "supportsDryRun": true,
      "supportsResultJson": true,
      "lowPriority": false,
      "platforms": ["win32", "darwin", "linux"],
      "params": [ { "name": "strategy", "type": "string", "enum": ["follow-latest", "keep-local"] } ]
    }
  ]
}
```

- `runtime`（新增，可选）：`python`（缺省，兼容 OSGToolset）或 `node`。
- `platforms`（新增，可选）：缺省视为全平台。
- params 的类型与校验规则沿用 cronkit `validate.ts`。

### 2. 调用

```
<interpreter> <entry> <tool> --project-root <cwd> [--dry-run] [--result-json <file>] [--<param-kebab> <value> ...]
```

- interpreter：
  - python 包用 `<包根>/.venv` 里的 python（Windows 为 `.venv\Scripts\python.exe`，其他为 `.venv/bin/python`）；
  - node 包用系统 Node，查找逻辑复用 `src/chat-bridge.mjs` 的 `locateNode`。
- 参数转 argv 照搬 cronkit `validate.ts` 的 `paramsToArgv`：
  - camelCase 转成 kebab；
  - 布尔 true 写 `--flag`，false 写 `--flag=false`；
  - 数组每项重复一次 flag。
- 子进程 cwd 为包根；工程根通过 `--project-root` 传入。

### 3. 结果

- 退出码：0 成功；64 参数错；99 意外错误；130 被中断；其他非 0 视为失败。
- `--result-json` 文件：`{ "summary"?: string, "detail"?: string, "skipped"?: boolean }`。step 的结果描述依次取 summary、detail，都没有时取 stdout 末 12 行。

### 4. 进度（新增，可选）

stdout 中能解析成 JSON 且 `type` 为 `"progress"` 的行视为进度，其余行进入运行日志：

```json
{"type":"progress","message":"更新文件 1234/5000","percent":24}
```

### 5. 取消

内核沿用 `src/runner.mjs` 现有做法：先发 SIGTERM（Windows 上为 `taskkill /T`），3 秒后强杀整棵进程树。包可以处理 SIGTERM 做收尾，但不能依赖收尾一定执行。

### 6. 元数据由内核执行

| 字段 | 内核行为 |
| --- | --- |
| requiresExclusiveWorkspace | 以规范化后的 `cwd` 为键加路径锁，所有触发来源在锁上排队 |
| remoteWrite | target 必须 `requiresApproval: true`，否则装载期报错。不再使用 `confirmRemoteWrite` 参数 |
| idempotent: false | 忽略 step 的 `retry`，日志注明 |
| supportsDryRun | 预演时追加 `--dry-run`；不支持的工具在预演中跳过 |
| lowPriority | Windows 下启动后把进程设为 BelowNormal（照搬 cronkit `exec.ts`），其他平台 `nice` 10 |
| platforms | 当前平台不在列表中时，诊断为 `platform-unsupported` |

### 7. 依赖就绪

- python 包：内核执行 `python -m venv .venv`，再 `pip install -r requirements.txt`，然后写入 `.deps-ok`，内容为 requirements.txt 的 sha256。哈希不一致视为依赖未就绪。
- node 包：必须提交打包好的 entry，没有依赖安装步骤，不需要 `.deps-ok`。
- 运行时只检查，不安装。

### 8. 来源与包名（2026-11-11 修订，契约 v2.5）

- 能力包一律从 git 拉取，仓库默认按公开仓处理。
- 来源由 `git + branch + subdir` 唯一确定。包名取包根 `toolset.json` 的 `id`；Hub 可以为某个来源指定包名覆盖，用于同一个包需要并装多份的情况。
- 两个来源得到同一个包名时，后装的报 `pack-name-conflict`，不覆盖已装的包。

### 9. 私有仓认证（2026-11-11 修订）

- 凭据只存在 agent 本机，不经过 Hub，按仓库地址前缀匹配（可以精确到组织或单个仓库）。
- 内核调 git 时不读本机 credential helper，也不允许交互提示；命中凭据时只给这一次调用注入 HTTP 认证头。这样包管理的行为不受本机 git 环境影响。
- 存储方式与接口见 [PRD-7](../prd/prd-7-schedule-and-capability-packs.md) A8。

## Consequences

- 每个 step 多起一个进程，相对分钟级的 svn、Unity 操作可以忽略。
- 能力包可以用任何语言实现，只要遵守本协议。
- 包作者改 toolset.json 的 id 会导致本机目录改名，引用旧包名的 target 需要同步修改。
- 实现见 [PRD-7](../prd/prd-7-schedule-and-capability-packs.md) A4、A5、A8。
