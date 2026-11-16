# 计划：工作副本池（workingCopyPool）与磁贴运行时输入

## 摘要

让用户按分支取用 OSG 等大型 SVN 工程，不再按目录管理。实现分布在三个仓库：

- novoard-packs：新增通用能力包 `workingCopyPool`，并在 general 包里新增 `unity-open`。
- novoard-agent：落地 ADR-0020，支持磁贴点击时选参数、由查询工具动态给出候选项；内置会话可以带参数触发 target，也可以查询候选项。
- Novoard（hub）：契约 SSOT 的 `target.json` 增加 `inputs`，契约版本升到 2.6。

权威规格：

- novoard-agent `docs/adr/0020-tile-runtime-inputs.md`（Accepted）
- novoard-packs `docs/prd/working-copy-pool.md`（池的行为、配置、状态、工具清单）

本计划只定实施顺序、接口落点和验收方式，不重复规格内容。

## 实施顺序

三条线可以并行推进，最后在 Windows 工作机上联调：

1. 契约线：按顺序完成 C1、C2，然后才能发布 agent。
2. 包线：完成 P6 到 P10，不依赖契约线，可以立即开始。
3. 会话线：完成 S1，依赖 C2 的 inputs 接口。
4. 联调：完成 P11。

上线顺序：先发 novoard-packs（旧 agent 不校验 manifest 里的未知字段，`kind` 不会造成问题），再发 agent，最后发 hub。这与 v2.5 已有的约定一致：agent 先发，hub 后发。

## 关键变更

### C1 契约 2.6（Novoard 仓与 novoard-agent 仓同批推送）

- Novoard `docs/architecture/schemas/target.json`：在 target 定义里增加 `inputs` 数组。每项包含 `name`（必填，`^[A-Za-z_][A-Za-z0-9_]*$`）、`label`、`choices`（字符串数组，或 `{ uses, with?, cwd? }`）、`default`（字符串）、`allowCustom`（布尔）、`required`（布尔，缺省 true）。每项 `additionalProperties: false`。
- 两个仓的 `src/contract/version.mjs` 都改成 `CONTRACT_VERSION = "2.6"`。同时更新 hub 的校验分支和 `scripts/check-contract-copy.mjs` 门禁要用的锁定拷贝。
- novoard-agent 同步锁定拷贝 `src/contract/schemas/target.json`，再执行 `npm run contract:gen-types`。
- Hub 只负责透传和保存 `inputs`，不渲染选择框（ADR-0020 §5）。

### C2 agent 侧实现 ADR-0020

- 装载期校验（`src/card.mjs` 的 `validateTargetsData` 之后，加在 `src/packs/diagnose.mjs` 中）检查以下几项：
  - `inputs.name` 不得与 `vars` 重名；
  - `choices.uses` 必须指向 `kind: "query"` 的工具；
  - 普通 `uses` step 不得引用 query 工具；
  - 带 `schedule` 的 target，每个必填 input 都必须有静态 `default`（`last` 不算）。
- 能力包：`src/packs/registry.mjs` 读取工具的 `kind`，缺省为 `"action"`。`src/packs/invoke.mjs` 的 `readResult` 透传 `choices` 和 `summary`，以及 workingCopyPool 返回的结构化字段 `pool`。
- 新增 `src/inputs.mjs`：
  - `resolveInputs(target, vars, memory)`：按 ADR-0020 §4 取值。缺少必填值时抛出带 label 的错误。
  - `queryChoices(target, name)`：以进程外方式调用查询工具。固定 15 秒超时，不加路径锁，不降优先级。失败时返回 `{ choices: [], error, allowCustom: true }`。
  - `last` 的存取：文件为 `<dataDir>/input-memory.json`，任务受理成功后才写入。
- 触发入口：`src/local-a2a.mjs` 的 `trigger()` 和 `src/tunnel-client.mjs` 的委派分支，在 `runner.launch` 之前都调用 `resolveInputs`。失败时按 ADR-0009 当场进入 failed 终态。
- 本机 HTTP：
  - 新增 `GET /api/targets/:id/inputs`，返回每项 input 的定义、候选项和解析后的默认值。
  - `/api/tiles` 每项增加 `inputs: boolean`。
- 能力派生：`deriveCard` 在描述里列出 inputs 的名称、label 和静态候选项。
- 桌面前端：
  - `desktop/src/lib/api.ts` 新增 inputs 接口的调用。
  - `home-page.tsx`、`actions-page.tsx`：点击带 inputs 的磁贴时先弹出选择框。选择框支持下拉、hint、自由输入（`allowCustom` 为真或查询失败时）和显示错误信息。确认后，通过 `/a2a` 的 data part 带上选定值触发；取消则不触发。
  - Target 表单（`target-draft.mjs`、`targets-page.tsx`）支持编辑 inputs，保存时不能丢失这个字段。
- 文档：
  - PRD-2：字段表和“变量插值”一节加入 inputs。
  - ADR-0019：§1 增加 `kind`，§3 增加 `choices`。
  - `architecture/local-api.md`：加入新接口。
  - ADR-0020 的“核对”节确认与实现一致。

### S1 内置会话（novoard-agent）

- `novoard_run_target` 增加可选参数 `vars`（键值对象），放进 `/a2a` 的 data part。修改 `src/novoard-tools.mjs` 和 `src/chat-worker.mjs` 里 zod 的 schema。
- 新增 `novoard_target_inputs`：参数为 `id`，调用 `GET /api/targets/:id/inputs`；同时登记到 chat-worker 的工具允许列表。
- `novoard-skill` 补充一条说明：触发带 inputs 的 target 之前，先查询候选项，再带上 vars 执行；遇到池满、槽位阻塞等需要用户决定的情况时，用会话提问来确认。

### P6 到 P10 能力包（novoard-packs）

规格以 `docs/prd/working-copy-pool.md` 为准。

- `shared/types.ts` 的 `ToolManifest` 增加 `kind?: "query" | "action"`。`ToolRunResult` 增加可选的 `choices`、`summary`、`pool` 字段。`shared/cli.ts` 把这些字段写入 result json。
- 新增 `packs/workingCopyPool/`（runtime node），并接入 `scripts/build.mjs`。包含以下工具：
  - 查询工具：`candidates`、`occupied`、`status`。
  - 执行工具：`acquire`、`release`、`gc`、`refresh`。
  - 实现要点：池根是 cwd；配置读取 `pool.toml`，TOML 库打包进 dist；状态文件为 `.pool/state.json`，加上 `.pool/lock`（记录 pid，可接管残留锁）；空闲状态由数据推导，不单独保存；改动存档写到 `patches/<分支>/<时间>/`；虚拟入口为 `branch/<分支>`（Windows 用 junction，其他平台用 symlink）。
  - SVN 调用和进度解析复用 versionControl 现有的 svn 模块。如需搬到 `shared/`，就一并迁移，不复制代码。
  - 释放文件占用直接调用 `shared/occupants`。
  - 取消协议遵循 ADR-0019 §5。
- `packs/general` 新增 `unity-open`：
  - 参数 `projectPath`，缺省为 `.`。
  - 复用 `readProjectVersion`、`resolveUnityEditor`、`isUnityLockHeld`。
  - 工程锁被占用时直接 skipped。
  - 以 detached 方式启动，不继承 stdio，启动后立即返回。
  - 平台：win32、darwin。
- README：更新包列表、Hub 来源（第三条，subdir 为 `packs/workingCopyPool`），任务表追加 P6 到 P11。

## 测试计划

- novoard-agent（`npm test` 全绿）：
  - resolveInputs：传入值优先；default 和 last 生效；缺少必填值时失败并列出 label；静态候选项在 `allowCustom: false` 时拒绝列表外的值。
  - 装载校验：四条规则都覆盖到，报错信息带 `targets.<id>.inputs[i]` 定位。
  - queryChoices：用夹具查询工具覆盖超时、非零退出、非法 JSON 三种情况，都应退化为可以自由输入。
  - 接口：`/api/targets/:id/inputs` 和 `/api/tiles` 的 `inputs` 标志。
  - 触发：本机 `/a2a` 和 tunnel 委派都经过 resolveInputs；last 只在受理成功后写入。
  - 会话工具：`novoard_run_target` 能带 vars；`novoard_target_inputs` 能返回候选项。
  - 契约门禁：两个仓的拷贝检查都通过。
- Novoard：契约拷贝门禁和现有测试全绿；含 inputs 的 target 能被接受并透传。
- novoard-packs（`npm run check` 全绿）：
  - 单测：配置校验（行号和字段）、锁接管、空闲推导（过期租约、常驻、blocked）、分支名转成目录名、中断恢复判定、candidates 合并去重和缓存。
  - 集成：用 `svnadmin create` 和 `file://` 建临时仓，跑通以下场景：新建稀疏检出且被排除的目录不下载；切换；带改动切换后 patch 能恢复改动；池满时报错并列出现状；release 不动文件；缩容；refresh 更新常驻分支；取消后下一次运行能恢复。
  - manifest 快照测试包含新包和 `kind`。
- P11 Windows 实机验收：
  - 在真实 OSG 池上，从 agent 控制台按 US1 到 US10 逐条验证。
  - 跑通三个 target：“开分支”（带选择框）、“s2pub 开工”、`wc-pool-nightly`。
  - unity-open 启动后步骤立即结束，取消任务不影响 Unity。
  - 用内置会话说“开 release_1.12 跟 bug-12345”，确认能完成占用并在 Cursor 中打开。

## 假设与默认

- 包名为 `workingCopyPool`，显示名为“工作副本池”。池内部名称 `pool.toml`、`.pool/`、结果字段 `pool` 保持不变。
- 常驻分支只来自 `pool.toml` 的 `resident`，不提供 pin 工具；手动不过期的占用用 `ttl: forever`。
- 改动规则：受版本控制的改动用 `svn diff` 存档后 revert；未纳管文件只记录清单；遇到冲突、锁或阻碍就标记为 blocked。规则不够用时以后再调整。
- 第一版新建槽位只用稀疏检出，不做本地复制。只支持 SVN，不关心 SVN 客户端版本。
- 池子不管理 `Library` 等被忽略的目录。需要按分支缓存时，由 OSGToolset 另外提供工具。
- 池工具不声明 `requiresExclusiveWorkspace`，以包内的锁为准。其他工具正在操作同一个槽位时，本包直接失败，不执行 cleanup。
- Hub 侧的选择框和 bug 单联动不在本计划范围内。
- 每完成一项，回到 Novoard 仓 `docs/roadmap/roadmap.md` 对应的表格更新状态（沿用两个仓 README 的约定）。
