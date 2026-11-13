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
| A8 | 契约 v2.5：来源自发现包名、本机 Git 凭据 | A5、A7；Hub H5 | `src/packs/`、`src/local-a2a.mjs`、桌面设置页与能力包页 |
| A9 | Target 表单化、保存不丢字段、manifest 展示字段 | A8 | `desktop/src/pages/targets-page.tsx`、`desktop/src/lib/target-draft.mjs`、`cron.mjs` |

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

## 第 4 波实现偏差（2026-11-10）

A6、A7 已实现，配套的 novoard-packs P4–P5、OSGToolset O2–O3 也一并完成。以实现为准：

- 诊断：六种 code 全部是 error 级别，目前没有 warning 级。manifest 读不出或不合法时也报 tool-missing，action 同样是一键更新。
- 预检：去重记录只放在内存里，agent 重启后同一时刻可能再预检一次、再发一条通知。
- Card：targets-store 派生 Card 时不带 profile，这是原有行为，本波未改。
- 控制台接口：新增 `GET /api/schedule`、`PUT /api/schedule`（body `{enabled: boolean}`，类型不对返回 400）、`POST /api/schedule/catch-up`。写接口校验同源并记本地审计，未装配调度返回 404，未就绪返回 503。磁贴接口附带 problems、schedule、nextRun、lastScheduled。
- novoard-packs CLI：在 ADR-0019 的退出码之外，工具自身失败（result.code 非 0）返回 1。CLI 只设 24 小时兜底上限，真正的超时由 agent runner 负责。每次运行的日志写到 `<tmp>/novoard-packs/`，非 dry-run 时 stdout 第一行给出路径。
- 进度：svn-update 报三个阶段加文件计数，计数按 1 秒节流，百分比封顶 99，完成时报 100。Unity 百分比只从含 DisplayProgressbar 的日志行解析。
- OSGToolset：SIGTERM（Windows 另含 SIGBREAK）转成中断，结束自己启动的子进程后写 result json（summary「已取消」，exitCode 130）并返回 130。cmake-build、csharp-compile 输出阶段帧，并从 MSBuild 的 `xxx.vcxproj -> ...`、make 的 `[ 45%]`、ninja 的 `[12/40]` 行折算进度。另外修了一个原有问题：流式输出原来按 4KB 整块读，进度和日志都不实时，现在改为有多少读多少，并按行解码。
- 平台限制（原有行为）：macOS 上 svn-update 会附带「未自动释放占用」，因为只有 win32 才释放占用；Unity 编辑器发现只扫描 Windows 路径。
- Windows：agent 的 `taskkill /T` 第一次不带 /F，对控制台进程通常无效，所以 O2 的优雅收尾实际只在 POSIX 上生效；Windows 上 3 秒后的 `/F` 强杀照常兜底。Windows 验收按用户要求暂缓。（2026-11-13 已改为经 stdin 下发取消，见文末「取消协议与废弃参数」。）
- 验收：端到端在 macOS 上用 agent 的 runner 对真实 file:// svn 仓库跑通 versionControl/svn-update，状态 completed，进度显示正常。手机收到预检通知这一条没有实测，只有单测覆盖。

## A8 来源自发现与 Git 凭据（2026-11-11）

配合 Hub PRD-6 H5（契约 v2.5）。包名不再由 Hub 手填，私有仓的认证在本机完成。

### 来源与包名

- `packSources[].id` 可选，含义是包名覆盖。来源按 `git + branch + subdir` 识别，规范化规则与 Hub 相同，本机 key 为 `src-` 加 sha1 前 12 位。
- 缓存 `pack-sources.json` 升到 schemaVersion 2，写入时不带 key，读取时现算。读到 v1 缓存时丢弃 id。重复来源、重复覆盖名丢弃并计数。
- 安装：先 clone 到 `packs/.tmp-<key>-*`，读包根 toolset.json 的 id 作为包名（有覆盖名时用覆盖名）。包名不合法报 `manifest-invalid`，同名目录已被其他来源占用报 `pack-name-conflict`，提示去 Hub 填包名覆盖。
- `.meta/<包名>.json` 增加 `sourceKey`、`override`。
- 对齐：启动时和每次收到 packSources 后，已装目录名与来源应得的包名不一致时改名；旧 meta 补上 sourceKey。
- 按包名安装（target 缺包自动补装）：先找覆盖名等于该名的来源，否则依次尝试所有未装且未覆盖的来源。
- 控制台接口：`POST /api/packs/:ref/install` 的 ref 可以是包名或 `src-<key>`；冲突返回 409。`GET /api/packs` 已装项带 `sourceKey`、`orphan`（Hub 不再下发其来源），未装来源 `id` 为 null 或覆盖名，带 `problem`、`problemCode`（上次安装失败原因），两者都带 `credential`（命中的凭据，脱敏）。

### Git 凭据

- 存在 `<stateDir>/git-credentials.json`，权限 0600，每条 `{url, username, token}`。
- 匹配：按 URL 路径段做前缀匹配，取最长的那条；末段忽略 `.git`。只接受 http/https，地址里不能带账号。用户名缺省时 github.com 用 `x-access-token`，其他用 `oauth2`。
- 注入：每次调 git 都用 `GIT_CONFIG_COUNT` 追加 `credential.helper=`（不读本机 helper）；命中凭据时再追加 `http.<仓库地址>.extraHeader=Authorization: Basic …`。同时设 `GIT_TERMINAL_PROMPT=0`、`GIT_SSH_COMMAND=ssh -o BatchMode=yes`，认证失败直接报错，不会卡在交互提示上。认证类错误提示去「设置 → Git 凭据」。
- 接口：`GET /api/git-credentials`（只返回 url、username、tokenLastFour），`PUT /api/git-credentials`（body `{url, username?, token?, originalUrl?}`，编辑时 token 留空沿用原值），`DELETE /api/git-credentials?url=`。写接口校验同源，审计不含 token。
- 桌面端：设置页新增「Git 凭据」区块，可增删改；能力包页每行显示命中的凭据，没命中显示「按公开仓访问」。

### 能力包页

- 每行一个已装包或一个未装来源。未装来源的包名显示「自动」，用 sourceKey 安装。
- 安装失败按 problemCode 显示「包名冲突」「toolset.json 有问题」「本机没有 git」「安装失败」，并直接显示原因。
- Hub 已删除来源的已装包显示「就绪（Hub 已删除来源）」，可以删除。

### 与原计划的偏差

- 凭据原计划放系统钥匙串（macOS Keychain、Windows DPAPI），实际用 0600 文件。理由：agent 是 Node 单进程，没有现成的跨平台钥匙串绑定；agent 自己的 Hub 令牌也放在本机配置文件里，安全边界一致。以后需要时再换。
- SSH 地址不注入凭据，只保证不卡交互。

### 验收

- `test/packs-git-auth.test.mjs`：前缀规范化、最长匹配（ssh 不命中）、0600 存储与脱敏、git 环境注入、控制台接口与跨源拒绝。
- `test/packs-manager.test.mjs`：clone 后自动发现包名、v1 缓存丢弃旧 id、包名覆盖与冲突、目录改名对齐、凭据注入、控制台 API。
- 手工：对 GitHub 私有仓用假 token 调 git，返回 128（认证失败）而不是弹出交互提示，说明认证头确实发出、本机 helper 已被屏蔽。

## A9 Target 表单（2026-11-12）

起因：Target 页只能编辑一条命令，定时和 uses 步骤要手写 YAML；而且保存时会丢掉 schedule、oncePerDay、deadline 和 uses 步骤。

### 表单

- 步骤：按顺序列出，可增删和上下移动。类型可选能力包工具、命令、打开应用、打开文件或目录；模板步骤只读，可调整顺序或删除。
- 能力包工具：先选包再选工具，选项里标出「写远端」和平台限制。参数表单按工具清单生成：enum 用下拉，boolean 用开关，string[] 逐行增删，`format: path` 带目录选择，`time` 用时间控件，`duration` 有格式提示。必填项标星，缺省值作为占位显示，不写进定义。高级设置里有工程根（cwd）、重试次数（0–10）、重试间隔。
- 本机没装的包：保留已有参数原样保存，并提示装上后才能编辑。
- 定时：重复方式可选不定时、每天、每周、每小时、按分钟间隔、自定义 cron；显示中文描述和接下来三次运行时间（带时区）。可设「每天只跑一次」和硬截止。总开关关着时给出提示。
- 整个 target 直接引用模板时，显示提示和「改为自己的步骤」按钮。

### 保存

- 以上次的定义为底，只覆盖表单管理的字段，vars、命令步骤的 env 等没有控件的字段原样保留。
- 关掉定时时，schedule、oncePerDay、deadline 一并去掉；oncePerDay 只在为 false 时写出。
- 保存前逐个 target 校验并在页内列出问题：ID、标题、步骤为空、未选工具、必填参数、数字参数、时长和时间格式、cron 有效性、重试范围。会写远端的工具要求打开「执行前需要在 Hub 上确认」。找不到的工具不拦截，交给 A6 诊断。

### 接口

- `GET /api/packs/tools`：返回 `{ ok, platform, timezone, scheduleEnabled, packs: [{ id, displayName, tools: [{ id, displayName, description?, remoteWrite, platforms?, params }] }] }`。只列能读出清单的已装包，按包名排序。

### 清单展示字段

- ADR-0019 §1 增加可选的 `label`、`description`、`format`。novoard-packs 两个包、OSGToolset 已补齐。
- 发现：novoard-packs 里 svn、git、unity-warmup 的 `path` 参数沿用自 cronkit（当时用来切换到 target 下的子目录），但现在的工具并不读取它。本次只如实标为「子路径（暂不生效）」，不给目录选择；是删除还是恢复其作用，另行决定。（2026-11-13 已删除，见文末。）

### 验收

- `test/target-form.test.mjs`：cron 解析生成往返、有效性与时区下次运行、toDef 往返不丢字段、关掉定时、模板 target、cleanWith、参数与格式校验、未装包不拦截、ID 重复、`/api/packs/tools`。
- novoard-packs `tests/manifest.test.ts`：与 cronkit 比较时忽略展示字段；每个参数都有 label，时长和时间参数带对应 format。

## 取消协议与废弃参数（2026-11-13，agent v0.3.8）

### 取消经 stdin 下发

- ADR-0019 §5 修订：uses step 取消时往 stdin 写 `{"type":"cancel"}` 并关闭，同时照发 SIGTERM；uses 宽限期 10 秒，其余 step 维持 3 秒。工具进程退出后立即补杀残留进程组（POSIX）。
- novoard-packs：CLI 监听 stdin 取消行，与 SIGTERM 走同一中止；svn 写工作副本的命令被中断后补跑 `svn cleanup`（限时 6 秒），svn 软杀宽限缩到 1 秒，保证在 agent 的 10 秒内跑完。URL 对 URL 的 copy、delete 不做 cleanup。
- OSGToolset：守护线程读 stdin 取消行，先结束活动子进程再中断主线程；子进程 stdin 一律 DEVNULL。
- 代价：运行超时、运行窗口硬截止对 uses step 最多晚 10 秒结束。

### path 参数删除

- novoard-packs 的 svn、git、unity-warmup 删除 `path` 参数，工作目录只由 step 的 `cwd`（表单「工程根」）决定。`general/release-occupants` 的 `path` 是真正在用的必填参数，保留。
- 兼容旧 targets.yaml：工具没声明的 `path` 视为废弃参数（`RETIRED_PARAMS`），装载和执行都不报错，执行时运行日志提示一次已忽略；表单显示「已废弃，保存时会自动移除」，保存时移除。本机没装的包看不到清单，参数原样保留。

### 验收

- `test/packs-uses.test.mjs`：读 stdin 的假包收到取消指令后自行收尾，终态已取消；不响应的假包 10 秒后被强杀（4 秒时仍存活）；script step 3 秒强杀。
- `test/target-form.test.mjs`：废弃参数执行期忽略、表单保存移除、release-occupants 的 path 保留、未装包原样保留。
- novoard-packs `tests/cancel.test.ts`、OSGToolset `StdinCancelTests` 覆盖包内取消。Windows 验收按用户要求暂缓。

## 不在范围

- 其他 A2A 成员接入、跨成员联动 step。
- 预演（dry-run）入口：协议已支持，界面以后再加。
- 来源修改的实时推送。
