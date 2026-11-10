# PRD-7 定时调度与能力包（agent 侧实现单）

依据 Hub ADR-0012、Hub PRD-6、本仓 [ADR-0019](../adr/0019-capability-pack-protocol.md)。

开工前先看 Novoard 仓 `docs/roadmap/roadmap.md`「跨仓：cronkit 吸收」表，确认依赖项已完成；做完一项回那张表改状态。

## 目标

把 cronkit 每天在 Windows 工作机上做的事迁到本仓：夜间更新 SVN 工程、预热 Unity、空闲关 Rider。本仓只做调度、能力包调用、包管理、缺包诊断，不写任何领域代码。

## 任务总览

| 编号 | 内容 | 依赖 | 主要文件 |
| --- | --- | --- | --- |
| A1 | 同步契约 v2.4 | Hub H1（同批推送） | `src/contract/`、`src/card.mjs` |
| A2 | 调度器 | A1 | 新 `src/scheduler.mjs`、`src/schedule-state.mjs` |
| A3 | 路径锁与排队 | A1 | `src/agent-runtime.mjs` |
| A4 | uses step | A1；novoard-packs P1 或 OSGToolset | `src/runner.mjs`、新 `src/packs/invoke.mjs` |
| A5 | 包管理 | A4、Hub H4 | 新 `src/packs/manager.mjs` |
| A6 | 缺包诊断与预检 | A2、A5 | 新 `src/packs/diagnose.mjs`、`card.mjs`、`targets-store.mjs` |
| A7 | 控制台 | A2、A5、A6 | `src/console-ui.mjs` 及前端 |

## A1 同步契约 v2.4

- 按 ADR-0004 流程：
  - 更新 `src/contract/schemas/` 锁定拷贝；
  - `CONTRACT_VERSION` 改为 `2.4`；
  - 执行 `npm run contract:gen-types`。
- CI 比对的是 Novoard main 上的当前契约（不固定 commit），因此 A1 必须与 Hub H1 同批推送。
- 装载期拦截：A4 落地前，含 `uses` step 的定义在装载期直接拒绝，报错带 `targets.<id>.steps[i]` 位置；A4 落地时删除这道拦截。
- 验收：`npm test` 全绿；含 `uses` 的定义被拒且报错带位置，含 `oncePerDay`/`deadline` 的定义正常装载。

## A2 调度器

### 移植来源（语义以 cronkit 为准）

| cronkit | 本仓 |
| --- | --- |
| `src/core/plan.ts` previousFire、nextRunIso、deadlineAtFromCron、wallClockIn | `src/scheduler.mjs` |
| `src/core/orchestrator.ts` catchUpNow、tick（约 486–529 行） | `src/scheduler.mjs` |
| `src/core/orchestrator.ts` runTarget 中的去重判定（约 381–398 行） | `src/scheduler.mjs` |
| `src/core/store.ts` keyed 记录、schedulerEnabled | `src/schedule-state.mjs` |
| `tests/cron-schedule.test.ts`、`tests/store.test.ts` | `test/scheduler.test.mjs`（逐条移植） |

新增依赖 `cron-parser`（与 cronkit 同版本 ^5.4.0），经 esbuild 打进 SEA。

### 行为规格

- 每 20 秒 tick 一次。总开关关闭时 tick 不做任何事。总开关存在 `<dataDir>/schedule-state.json`，缺省关闭（与 cronkit 相同）。
- 对每个带 `schedule` 的 target，取 `prev = previousFire(schedule, tz)`：
  - prev 晚于现在，跳过。
  - prev 的本地日期早于 `今天 - catchUpPreviousDays`，跳过。
  - `now - prev < 3 分钟`，触发来源记为 `schedule`。
  - 否则只在调用 `catchUp()` 时触发，来源记为 `catch-up`。
- 去重键：`oncePerDay !== false` 时为 `<targetId>|<本地日期>`，否则为 `<targetId>|<prev ISO>`。已有记录满足以下任一条件时不再触发：
  - 状态为 queued 或 running；
  - 状态为 completed；
  - 状态为 failed 或 canceled，且 `retryFailedOnCatchUp` 为 false。
- 手动、Hub、对等触发不写去重记录（与 cronkit 一致）。
- 定时触发若被 runtime 以并发已满拒绝，不写去重记录，下个 tick 重试。
- `deadline`：按 `deadlineAtFromCron` 算出截止时刻，到点等同取消，终态 failed，原因写"已到运行窗口硬截止 HH:mm"。
- 新增行为（cronkit 没有）：agent 启动 60 秒后自动执行一次 `catchUp()`，补上关机或睡眠期间错过的触发。
- 时区：取 `agent.json` 的 `schedule.timezone`，缺省为系统时区。
- 运行轨迹 `run/start` 增加 `trigger` 字段：`schedule`、`catch-up`、`manual`、`hub`、`peer`。

### agent.json 新增（可选）

```json
"schedule": { "timezone": "Asia/Shanghai", "catchUpPreviousDays": 1, "retryFailedOnCatchUp": false }
```

本机同时运行上限沿用 runtime 现有的 `concurrency`，不新增 maxConcurrentRuns。

### 验收

- 移植的 cronkit 测试全部通过。
- 用假时钟模拟以下场景：
  - 02:10 准点触发 1 次。
  - 02:11 再次 tick，不重复触发。
  - 机器 02:00–08:00 停机，08:00 启动后补跑 1 次，来源为 catch-up。
  - `oncePerDay: false`、`*/15 0-7 * * *` 时每个时刻各触发 1 次。
  - deadline 07:00 时，07:00 停止仍在运行的任务。

## A3 路径锁与排队

- 在 `src/agent-runtime.mjs` 的 `startExecution` 之前取锁：
  - 扫描 steps 中工具标了 requiresExclusiveWorkspace 的 uses step，收集规范化后的 cwd；
  - 规范化照搬 cronkit `paths.ts` 的 `normalizePathKey`：绝对路径、统一分隔符、Windows 下转小写；
  - 一次性申请全部锁。
- 锁被占用时排队等待，不拒绝。任务保持 working，进度文案为"排队中：等待 <路径> 释放"。四种触发来源共用同一个队列，按先来后到。
- 排队中可以取消。进入终态时释放锁。
- 原有的 target 并发和本机并发拒绝逻辑不变。
- 验收：同一 cwd 的两个 target 先后触发，第二个排队并在第一个结束后开始；不同 cwd 的两个 target 并行执行。

## A4 uses step

- `src/runner.mjs` 的 `runStep` 增加 `typeof step.uses === "string"` 分支，调用 `src/packs/invoke.mjs`。调用、结果、进度、取消按 ADR-0019 实现；argv 拼装与参数校验照搬 cronkit `validate.ts`、`external.ts`。
- `describeStep` 显示 `uses <pack>/<tool>`。进度行转为 `onProgress` 的 detail，经现有三条链路（控制台、Hub、对等）可见。
- `retry`、`retryInterval` 按 cronkit `orchestrator.ts` 中 attempts 计算的语义执行（约 860–867 行），`idempotent: false` 时不重试。
- 装载期（`card.mjs` 的 `validateTargetsData` 之后）检查三项：uses 引用的工具存在；`with` 通过 params 校验；remoteWrite 工具所在 target 有 `requiresApproval: true`。
  - 参数错误属于定义错误，按 ADR-0012 拒绝保存。
  - 包缺失不属于定义错误，交给 A6 处理。
- 测试夹具 `test/fixtures/packs/fake`：一个 node runtime 的假包，含四个工具，分别模拟成功、失败、输出进度、长时间睡眠（用于测取消）。
- 验收：
  - 夹具四个工具的行为全部符合 ADR-0019。
  - 在 Windows 上用真实 OSGToolset 跑 `osg/doctor`，零改动通过。
  - 取消 `osg/cmake-build` 后，进程树中无残留进程。

## 第 2 波实现偏差（2026-11-09）

A2–A4 已实现，以下几处与上文规格不同，以实现为准：

- 测试：cronkit 的 `cron-schedule.test.ts`、`store.test.ts` 与这里的接口对不上，没有逐条移植，改为新写 `test/scheduler.test.mjs`，覆盖上文验收场景以及失败重来、可重试拒绝、总开关、启动补跑、残留记录。
- 去重：working、input-required 也算进行中；rejected 与 failed、canceled 同等处理。可重试拒绝除并发已满外还包括 agent-stopping。
- 总开关：关闭时 tick 不触发，但手动 `catchUp()` 照样执行；启动 60 秒后的自动补跑只在总开关开启时执行。A7 控制台做完之前，开关只能手改 `schedule-state.json`。
- 装载期检查：工具不存在不算定义错误，与包缺失一样交给 A6。参数校验遇到含 `{{}}` 的值跳过，留到运行期。
- retry 缺省为 0，不按工具名硬编码重试次数；retryInterval 缺省 3 秒。
- Hub 与对等触发只能靠帧上的 `metadata.from` 区分。
- lowPriority 用 `os.setPriority` 实现。
- 夹具放在 `test/fixtures-packs/fake`（放在 `test/fixtures/` 下会被 agent 定义校验扫到），共 9 个工具，多出的用于测重试、非幂等、独占工作区、写远端和平台限制。
- Windows 验收（真实 OSGToolset 跑 `osg/doctor`、取消 `osg/cmake-build` 后查残留进程）按用户要求暂缓，出问题再修。

## A5 包管理

- 安装目录 `<dataDir>/packs/<id>/`，即仓库克隆；包根为克隆目录加上 subdir。
- 来源：Hub `hello.ack.packSources`，收到后缓存到 `<dataDir>/pack-sources.json`，离线时使用缓存。
- 操作（git 逻辑照搬 cronkit `toolset/manager.ts`）：
  - 安装：`git clone --branch <branch>`，然后准备依赖。
  - 更新：工作区有改动时先把 `git diff` 存到 `<dataDir>/packs/.patches/<id>-<时间>.patch`，再 `fetch` 加 `reset --hard origin/<branch>`，然后准备依赖。
  - 准备依赖：按 ADR-0019 §7。python 查找顺序：Windows 为 `py -3`、`python`；其他平台为 `python3`。
- 版本：显示 `git rev-parse --short HEAD`。
- 触发时机：
  - 控制台按钮。
  - 用户在场时自动补装：保存 target 时，以及手动或控制台触发某个 target 时，如果缺包且来源已知，先安装再执行，任务进度显示"安装 osg…"。
  - 定时、补跑、Hub、对等触发一律不安装。
- 安装成功或失败、删除包都会重新派生 Card，并发送 `card.update`。
- 验收：在 Hub 配置 osg 来源后，控制台点一次安装，`doctor` 可以运行；改动包内文件再点更新，patch 文件生成，工作区恢复干净。

### A5 实现偏差（2026-11-09）

以实现为准：

- 包根定位：安装时把来源快照写到 `<dataDir>/packs/.meta/<id>.json`，registry 据其中的 subdir 找包根。没有 meta 的目录（手放的包、测试夹具）包根就是克隆目录。
- 安装先 clone 到 `packs/.tmp-<id>-*`，确认包根下有 toolset.json 后再改名到位，失败不留残目录。依赖准备失败时克隆保留，状态为依赖未就绪，再点更新即可重试。
- `.deps-ok` 放在 `.venv/.deps-ok`。没有 requirements.txt 时按空内容算哈希。运行时 python 包改为同时校验 `.deps-ok` 哈希，不再只看 `.venv` 是否存在。
- patch 用 `git diff HEAD`，已暂存的改动也会备份。
- 更新时来源已从 Hub 删除，退回 meta 里的快照继续更新。
- 同一个包的安装、更新、删除串行合并：并发请求拿同一个结果。
- 自动补装只认 `trigger=manual`（磁贴、控制台、CLI 都走这里）。保存 target 后的补装在后台进行，不阻塞保存。来源未知的缺包不装，执行时照常报 pack-missing。
- 控制台接口（UI 留给 A7）：`GET /api/packs`、`POST /api/packs/:id/install`、`POST /api/packs/:id/update`、`DELETE /api/packs/:id`，写接口校验同源并记本地审计。
- Card 目前不含包信息，重派生后内容不变，仍按规格发 `card.update`，A6 加诊断后才有实际差异。
- 验收在 macOS 上用本机 OSGToolset 仓做来源跑通：安装、建 venv、pip、`osg/doctor` 被调起，改文件后更新生成 patch、工作区干净。doctor 自身报"缺少工具: python"，这是 OSGToolset 要求 PATH 上有 `python`（Windows 工作机的情况），与包管理无关。

## A6 缺包诊断与预检

### 诊断函数

`diagnoseTarget(target) → [{ step, code, level, message, action }]`

| code | 判定 | message 示例 | action |
| --- | --- | --- | --- |
| git-missing | `git --version` 失败 | 本机没有 git | 安装 git |
| pack-missing | 包目录不存在，来源已知 | 本机未安装能力包 osg | 一键安装 |
| source-unknown | 包目录不存在，来源也未知 | 不知道能力包 osg 从哪里安装 | 去 Hub 管理台添加来源 |
| deps-not-ready | `.deps-ok` 缺失或哈希不符 | osg 依赖未就绪 | 一键更新 |
| tool-missing | manifest 中没有这个工具，或 schemaVersion 高于本机支持的版本 | osg 中没有工具 cmake-build，可能版本过旧 | 一键更新 |
| platform-unsupported | 当前平台不在 platforms 列表中 | general/quit-idle 不支持 darwin | 无，这台机器不适合这个 target |

### 接入点

| 时机 | 位置 | 表现 |
| --- | --- | --- |
| 装载、保存、包变化 | `targets-store.mjs` 的 `save` 之后，以及 agent 启动时 | 保存成功但附带 warnings；控制台磁贴标红并显示 message 和 action；`deriveCard` 排除有 error 的 target |
| 预检 | 调度器发现某 target 下次触发在 60 分钟内，且该时刻尚未预检过 | 有 error 时发一条 `notify.owner` |
| 运行时 | uses step 执行前 | 终态 failed，stderr 填诊断 message |

预检通知文案（一个 target 一条）：

```
【预检】<agentId> 的「<title>」将在 02:10 运行，现在看会失败：
第 1 步 osg/revert-generated：本机未安装能力包 osg。
到本机控制台点「安装」即可。
```

### 验收

- 删除 osg 包目录后：
  - 保存引用 osg 的 target 时返回 warning；
  - 磁贴标红，显示"一键安装"；
  - Hub 成员视图里不再看到这个 skill；
  - 把 schedule 调到 50 分钟后，手机收到预检通知。
- 六种 code 各有单测。

## A7 控制台

- 顶部提供"定时"开关（对应 schedule-state 的 enabled），以及"立即补跑"按钮。
- 每个带 schedule 的磁贴显示下次运行时间与上次结果（schedule 或 catch-up）。
- 新增"能力包"页：每个来源一行，显示 id、版本、状态（来自诊断），带"安装"或"更新"按钮。来源只读，修改请去 Hub 管理台。
- 全部用开关和按钮操作，没有需要手输的字段。

## 不在范围

- 其他 A2A 成员接入、跨成员联动 step。
- 预演（dry-run）入口：协议已支持，界面以后再加。
- 来源修改的实时推送。
