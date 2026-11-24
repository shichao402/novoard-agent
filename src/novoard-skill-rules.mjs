/**
 * Target、步骤、定时、运行时输入、工作副本池的规则，只在这里写一份。
 *
 * 两个消费方：
 * - 内置会话 skill（src/novoard-skill.mjs），工具是进程内 MCP `novoard_*`；
 * - 外部 skill novoard-manage（scripts/gen-manage-skill.mjs 生成到 skills/novoard-manage/，再发布到 Dec），
 *   工具是 skills/novoard-manage/scripts/novoard.py 的子命令。
 *
 * 两边只有工具名不同，由 tools 参数映射。改契约时改这里，然后 `npm run skill:gen` 并发布到 Dec。
 */

/** 内置会话的工具写法。 */
export const MCP_TOOLS = {
  save: "`novoard_upsert_target`",
  packs: "`novoard_list_packs`",
  installPack: "`novoard_install_pack`（key 用返回的 installKey）",
  packTools: "`novoard_pack_tools`",
  schedule: "`novoard_get_schedule`",
  catchUp: "`novoard_schedule_catch_up`",
  inputs: "`novoard_target_inputs`",
  run: "`novoard_run_target`",
  log: "`novoard_tail_logs`",
  agentId: "`novoard_status` 里的 agentId",
};

/** 外部 CLI（novoard.py）的写法。 */
export const CLI_TOOLS = {
  save: "`add`",
  packs: "`packs`",
  installPack: "`install-pack <installKey>`",
  packTools: "`pack-tools <包名>`",
  schedule: "`schedule`",
  catchUp: "`catch-up`",
  inputs: "`inputs <id>`",
  run: "`trigger`",
  log: "`log <id>`",
  agentId: "`status` 里的 agentId",
};

/** Target 字段（不含步骤）。 */
export function targetFieldRules(t) {
  return `- id 只能是小写字母、数字和连字符。id 在 Hub 上全局唯一、先到先得，新建时带上本机 agentId 作后缀（${t.agentId}），形如 \`gamecore-daily-svn-update-imac5k2020\`。
- 必填：title、expose（\`a2a\` Hub 可见可触发 / \`local\` 只在本机）、audit（\`none\` / \`summary\` / \`full\`）、requiresApproval、notify（\`always\` / \`on-failure\` / \`never\`），以及 steps 或 template。漏写会被拒。
- \`concurrency\` 默认 1（不能重叠）。只有被执行的东西本身隔离、重复没有影响、或者本来就要并发时才调高，最大 32。
- \`timeout\` 是整次运行的上限，默认 \`10m\`，写法如 \`30s\` / \`10m\` / \`1h\`。
- 保存被拒时，错误里会写明哪个字段、哪一步不对，照着改再保存，不要绕开校验。
`;
}

/** 步骤种类与 uses 步骤的写法。 */
export function stepRules(t) {
  return `每个 step 是下面一种。多件事拆成多个 step，日志里能看出卡在哪一步；任一步失败，后面的不再执行。

- 命令：\`{ script: "...", cwd: /绝对路径 }\`。cwd 不展开 \`~\`。
- 打开应用或路径：\`{ openApp: "..." }\`、\`{ openPath: "..." }\`。
- 能力包工具：\`{ uses: <包名>/<工具 id>, cwd: /工程根, with: {...}, retry: 0, retryInterval: 30s }\`。

写 uses 步骤：

1. ${t.packs} 看包装没装。没装但来源在列表里，告诉用户要装哪个，同意后 ${t.installPack}。来源也没有，请用户先在 Hub 管理台的「能力包来源」页加上仓库地址（只填仓库和分支，子目录由 agent 自动扫描）。
2. ${t.packTools} 拿工具的 params。\`with\` 的键用参数 name，必填都要给，类型照定义（enum 只取列出的值，列表参数给字符串数组），有 default 的可以不写。不要凭印象编参数。
3. 工具标了 \`platforms\` 而本机不在其中，不要用。
4. 工具标了 \`remoteWrite: true\`（会提交、推送等写远端），Target 必须 \`requiresApproval: true\`，并先跟用户讲清会写到哪里。
5. \`cwd\` 是工程根，同一 cwd 的步骤会排队，不会同时跑。会改工作副本、而工程可能被 IDE 或其他程序占着时，前面先放一步占用释放类工具（如 \`general/release-occupants\`，以清单为准）。
6. \`kind: "query"\` 的工具只能用在 inputs 的 choices 里，不能当步骤。

执行条件 \`when\`（script、openApp、openPath、uses 都能写，template 不能）：

- 同一个 Target 有几步「这次做、下次不做」（如开不开 Rider、要不要先 svn update）时，不要拆成两个 Target，给这几步写 \`when: "{{开关输入名}}"\`。
- \`when\` 先插值，结果去掉首尾空白后为空、\`false\`、\`0\`、\`no\`、\`off\`（不分大小写）时跳过这一步，其余值照常执行。跳过不算失败，日志里记一行「已跳过」。
- 只判断真假，不支持 \`==\`、\`&&\` 这类表达式；要按值分流，就让输入直接给出开关值。
- \`{{name}}\` 没有来源（inputs、vars、触发参数都没有）时整次运行失败，不会当作假。
- 示例：\`{ openApp: rider, when: "{{openRider}}" }\`，配一项开关输入 \`openRider\`。
`;
}

/** 定时字段的含义。设定时的确认流程两边不同，各自写。 */
export function scheduleFieldRules(t) {
  return `- \`schedule\`：5 段 cron（分 时 日 月 周），按 agent 时区（${t.schedule} 的 timezone）解释。例：每天 2:10 是 \`10 2 * * *\`，工作日 9 点是 \`0 9 * * 1-5\`，每 15 分钟是 \`*/15 * * * *\`。
- \`oncePerDay\`：缺省为 true，同一天成功过就不再触发，适合「每天跑一次」。要每个时刻都跑（如每 15 分钟）就写 false。
- \`deadline\`：\`HH:mm\`，到点停掉还没跑完的部分，记失败。触发时刻晚于它时截止算到次日。夜间任务要在上班前结束时用。
- agent 每 20 秒检查一次。关机或睡眠错过的触发，agent 启动约 60 秒后自动补跑一次（受 oncePerDay、deadline 约束）；${t.catchUp} 可以立刻补跑。
- 定时总开关关着时，所有定时 Target 到点都不会跑。
`;
}

/** 运行时输入的写法。触发时怎么问用户两边不同，各自写。 */
export function inputRules() {
  return `同一个 Target 每次要不同参数（分支、渠道、环境）时，不要为每个值建一张卡，加 \`inputs\`。每项：

- \`name\`：与 \`{{name}}\` 对应，不能和 vars 重名。\`{{name}}\` 可以出现在 script、cwd、env、\`with\`、\`when\` 里。
- \`label\`：给人看的名字。
- \`choices\`：字符串数组，或 \`{ uses: <包>/<查询工具>, cwd: <工程根>, with: {...} }\`（查询工具在工具清单里标 \`kind: "query"\`）。
- \`default\`：固定值，或 \`last\`（取上次选的）。
- \`allowCustom\`、\`required\`。

开关输入：\`choices: ["true", "false"]\`，再给 \`default\`（如 \`"false"\`），桌面端显示为开关，配合步骤的 \`when\` 决定某几步跑不跑。

带 schedule 的 Target，必填输入要有固定的 default，不能用 last。
`;
}

/** 工作副本池（workingCopyPool 包）。 */
export function poolRules(t) {
  return `一个 SVN 仓库按分支在本机维持几份工作副本（槽位）。用户只说「开 xxx 分支」，池负责复用、切换、稀疏检出和存档改动。

- 池根是一个目录，里面放 \`pool.toml\`。除 \`capture-sparse\` 外，池工具步骤的 \`cwd\` 一律写池根；没有 pool.toml 时工具报用法错误，先和用户确认池根位置并写好 pool.toml：\`maxSlots\`、\`svnRoot\` 必填；\`defaultTtl\`、\`resident\`（常驻分支数组）、\`[branches] pattern / listFrom（目录数组，如 ["branches"]）/ recentDays\`、\`[aliases]\`、\`[sparse]\`、\`patchRetentionDays\` 可选。\`pattern\` 必须含 \`{name}\`，可带后缀，如 \`branches/{name}/GameCore\` 只检出分支下的 GameCore。
- 稀疏检出写 \`[sparse]\`：\`root\` 是工作副本根的 depth（\`empty\` / \`files\` / \`immediates\` / \`infinity\`，默认 infinity），\`[sparse.depth]\` 是映射表，键为相对工作副本根的路径，值为 \`exclude\` / \`empty\` / \`files\` / \`immediates\` / \`infinity\`。没列出的目录继承父目录，列出路径的上级目录自动建成空壳。白名单式精简工程写 \`root = "empty"\`，再把要的目录写成 infinity，例如 \`"GameCore" = "infinity"\`、\`"Project" = "empty"\`、\`"Project/Plugins" = "infinity"\`。旧写法 \`exclude = [...]\`（根 infinity、只排除这些目录）仍可用，但不能和 \`root\` / \`[sparse.depth]\` 混写。只写 exclude 会检出近完整工程，用户要精简工程时用映射表。
- 用户本机已有精简工程要照着复刻时，不要自己猜目录清单，也不要直接 \`svn info -R\` 去读（节点可能十几万）：用 ${t.save} 建一个 \`expose: local\` 的 Target，步骤 \`workingCopyPool/capture-sparse\`，\`with: { path: <现有工作副本> }\`，\`cwd\` 不需要是池根，也不需要 pool.toml；${t.run} 跑一次，从 ${t.log} 里取导出的 \`[sparse]\` 片段，给用户确认后写进 pool.toml。该工具只读，不改工作副本。
- 分支的固定入口是 \`<池根>/branch/<分支>\`。后续步骤的 cwd、projectPath 写成 \`{{poolRoot}}/branch/{{branch}}\`（poolRoot 放在 Target 的 vars 里），不要写 slot-N 槽位目录，槽位会被复用。
- 查询工具 \`candidates\`（开分支的候选）、\`occupied\`（正在占用的分支）、\`status\`（池状态）只用于 inputs 的 choices，不能当步骤。choices 里也要写 \`cwd\` 指向池根，如 \`{ uses: workingCopyPool/candidates, cwd: "{{poolRoot}}" }\`。
- 动作工具：\`acquire\`（branch 必填；ttl 如 \`12h\`、\`3d\`、\`forever\`；tag 选填）、\`release\`（只清租约不动文件）、\`refresh\`（常驻分支更新到最新）、\`gc\`（中断恢复、缩容、清过期存档）、\`capture-sparse\`（从现有工作副本导出 \`[sparse]\` 配置，只读）。
- 池满，或槽位有冲突、svn 锁时，acquire 失败并列出各槽位的分支、标签、租约。原样转告用户，让他决定释放哪个；不要自己删目录或 revert。
- 切换或回收前，受控文件的改动会存档成 patch 并 revert，存档路径写在运行日志里，告诉用户即可。未纳管文件只记清单、不删除，会留在槽位里带到下一个分支。

典型 Target（工具 id 与参数以 ${t.packTools} 为准）：

1. 开分支：inputs 一项 \`branch\`，\`choices: { uses: workingCopyPool/candidates, cwd: "{{poolRoot}}" }\`，\`allowCustom: true\`，\`default: last\`；步骤 \`workingCopyPool/acquire\`（\`with: { branch: "{{branch}}" }\`），需要时接 \`general/unity-open\`（\`projectPath\` 指向分支入口下的 Unity 工程目录）。要不要顺带开 Rider 等 IDE，用一项开关输入加该步的 \`when\`，不要再建一个 Target。
2. 固定开工（如每天早上开常驻分支）：acquire → \`general/release-occupants\`（仅 Windows）→ \`versionControl/svn-update\` → \`general/unity-open\`。带 schedule 的 branch 用固定值，不用 last。
3. 释放：inputs 的 choices 用 \`workingCopyPool/occupied\`（同样带 cwd），步骤 \`workingCopyPool/release\`。
4. 夜间维护：\`workingCopyPool/gc\` → \`workingCopyPool/refresh\`，配 schedule 和 deadline。

\`general/unity-open\` 只负责把 Unity 拉起来，启动后立刻返回成功，不等编辑器加载完。后面不要加等待步骤。
`;
}
