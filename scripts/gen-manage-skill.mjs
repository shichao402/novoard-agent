#!/usr/bin/env node
/**
 * 生成外部 skill novoard-manage 的 SKILL.md（skills/novoard-manage/SKILL.md）。
 *
 * 共用规则在 src/novoard-skill-rules.mjs，这里只写编码会话专有的部分（CLI 用法、通用流程、场景、已知坑）。
 * novoard.py 直接放在 skills/novoard-manage/scripts/ 下手改。
 *
 *   node scripts/gen-manage-skill.mjs           重新生成
 *   node scripts/gen-manage-skill.mjs --check   生成结果与仓库里的不一致就失败（npm test 会跑）
 *
 * 生成后把 skills/novoard-manage/ 整个发布到 Dec 的 novoard bundle（skills/novoard-manage/SKILL.md、
 * skills/novoard-manage/scripts/novoard.py，后者保留可执行位）。不要在 Dec 上直接改正文，下次生成会覆盖。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLI_TOOLS as T, targetFieldRules, stepRules, scheduleFieldRules, inputRules, poolRules } from "../src/novoard-skill-rules.mjs";

const OUT = fileURLToPath(new URL("../skills/novoard-manage/SKILL.md", import.meta.url));

export function buildManageSkill() {
  return `---
name: novoard-manage
description: 在编码会话里配置和维护本机 novoard-agent：把项目脚本接成 target（Hub 卡片），用能力包编排步骤，设定时、装或更新能力包、查执行记录和日志；通过具名最小权限 PAT 查询/登记/修改/删除 Hub 能力包来源，主动同步本机来源无需重连。用户说「把脚本接到 novoard」「每天几点做任务」「给 novoard 装包」「登记或修改能力包来源」「同步来源」「看看 novoard 执行结果」时使用。不负责编写业务脚本，不改 Hub 地址、接入令牌、Git 凭据和定时总开关，不自动签发 PAT 或扩大权限。
---

<!-- 由 novoard-agent 仓 scripts/gen-manage-skill.mjs 生成，规则源在 src/novoard-skill-rules.mjs。不要直接改这份。 -->

# 配置和维护本机 novoard-agent

## 定位

novoard-agent 自带一个对话框，只适合发短指令（「跑一下 xxx」「看看上次结果」）。需要看项目、设计
步骤、反复调整的配置活，在编码会话里用本 skill 做。agent 内置会话自带另一份 skill（novoard-agent-ops），
两份由同一份规则源生成，只是入口不同：那边调 MCP 工具，这边调下面的 CLI。

完成标准：Hub 上看得到卡片，本机触发一次成功；配了定时的，\`schedule\` 里 nextRun 符合用户预期。

## 工具

[\`scripts/novoard.py\`](scripts/novoard.py)，只用标准库。Windows 上用 \`python\`。输出都是 JSON，失败时退出码非 0，
stderr 里是 agent 给的原因，照着改再试，不要绕开。

\`\`\`text
python3 <skill>/scripts/novoard.py status                 身份、Hub 连接、总开关、每个 target 摘要
python3 <skill>/scripts/novoard.py targets [<id>]         target 全文
python3 <skill>/scripts/novoard.py schedule               时区、总开关、每个定时 target 的 nextRun 和上次结果
python3 <skill>/scripts/novoard.py packs                  已装能力包、可安装来源（installKey）
python3 <skill>/scripts/novoard.py pack-tools [<包名>]    工具清单与参数定义
python3 <skill>/scripts/novoard.py inputs <id>            运行时输入的候选项和默认值
python3 <skill>/scripts/novoard.py activity [--limit N]   最近执行记录
python3 <skill>/scripts/novoard.py log <id> [--lines N]   该 target 最近一次运行日志
python3 <skill>/scripts/novoard.py add --file <片段.yaml> [--replace]
python3 <skill>/scripts/novoard.py remove <id>
python3 <skill>/scripts/novoard.py install-pack <installKey> [--update]
python3 <skill>/scripts/novoard.py trigger <id> [--var 名=值 ...]
python3 <skill>/scripts/novoard.py catch-up               立即补跑错过的定时
python3 <skill>/scripts/novoard.py pack-sources list|add|update|remove [选项]
python3 <skill>/scripts/novoard.py sync-pack-sources      主动同步已配置 Hub 来源，无需重连
\`\`\`

每个子命令都接受 \`--dev\`，操作开发版 agent（\`com.novoard.agent.dev\`），默认是正式版（\`com.novoard.agent\`）。

本机写操作都经 agent 控制台接口完成；来源登记走下述 Hub 专用权限 API。保存时校验 schema、备份 \`targets.yaml.bak\`、热生效并向 Hub
上报 \`card.update\`；执行一律走本机 \`/a2a\`。不要直接编辑 \`agent.json\`、\`targets.yaml\`、\`schedule-state.json\`，
改了也不会生效。不要用 Bash 直接跑 target 里的命令或包里的工具来代替 \`trigger\`，也不要另起系统 cron。

CLI 不提供、本 skill 也不做的事：开关定时总开关、改 Hub 地址或令牌、配 Git 凭据、删除能力包。遇到这些，
告诉用户去 agent 桌面端设置页操作。密钥不要让用户发进对话。

## 能力包来源管理

来源是 Hub 全局配置，会影响所有成员可安装的软件，不能用本机成员 token 代替管理员授权。用户明确要求登记/修改来源时，编码会话可以直接使用 \`pack-sources\`，不必自动转到浏览器登录。

凭据由用户在本机一次性准备：Hub 的个人 PAT 明确选择 \`pack-sources.read\` 和 \`pack-sources.manage\`。只查清单可仅给 read。只有当前管理员角色具有这些权限，PAT 不因名字叫 admin 就自动提权；降权、禁用、过期或吊销立即拒绝。来源管理权限默认不勾选，也不会自动补到旧 PAT。

CLI 从 \`NOVOARD_HUB_PAT_FILE\`（用户保存的令牌文本文件）或 \`NOVOARD_HUB_PAT\` 读取。不要运行 echo/Get-Content 查看明文，不让用户发到对话，不用命令行参数传 token，不从浏览器 Cookie/密码或 agent.json 的 agentToken 偷换身份。缺凭据或 401/403 时停下，让用户准备权限；不自动签发 PAT、换角色、扩大 scope 或改 Git 凭据。

\`--hub\` 可以指定 Hub HTTPS 根地址；省略时从本机 agent 设置读现有 Hub 地址，不修改设置。HTTPS 重定向不会被跟随，防止 PAT 外传。公开 Git 仓可用 HTTPS；私有仓已验证本机 SSH 权限时优先登记 SSH 地址，不要把 Git token 写进 git URL。

\`pack-sources\` 支持以下动作（由管理员先完成凭据准备，Windows 用 python）：

\`python <skill>/scripts/novoard.py pack-sources list\`

\`python <skill>/scripts/novoard.py pack-sources add --git git@HOST:GROUP/REPO.git --branch main\`

\`python <skill>/scripts/novoard.py pack-sources update --key ps-KEY --git git@HOST:GROUP/REPO.git\`

\`python <skill>/scripts/novoard.py pack-sources remove --key ps-KEY --confirm\`

先 list 查已有来源。update 只修改给出的 git/branch，未给字段及已有包名覆盖 id/subdir 原样保留。删除前必须征得用户同意。管理 key 是 \`ps-…\`，不是本机 \`installKey\` 或仓库扫描 key \`src-…\`。重复/冲突返回 409，查清后再决定，不自动删除或整份覆盖来源清单。来源只填仓库和分支，工具不会装包或改定时。

写入后执行 \`sync-pack-sources\` 主动同步本机，随后 \`packs\` 查看后台扫描结果，再在用户授权范围内 \`install-pack <installKey>\`。sync 只访问已配置 Hub，不接受新 Hub/token 参数；未升级的服务返回 404/503，报告缺少版本能力，不要为同步强杀/restart agent。已有 Git HTTPS 来源缺凭据时，根据已验证权限改为 SSH 或请用户在本机设置 Git 凭据，不让用户发送 token。

部署前提：Hub 需支持来源 PAT 和只读成员拉取接口，agent 需支持主动同步接口。CLI 和说明更新不等于线上 Hub/已安装 agent 自动升级；版本未部署时不能宣称来源已接入。内置会话可通过来源同步入口同步，来源写管理仍由带专用 PAT 的编码会话承担。

## 通用流程

1. 看现场：\`status\`。agent 没在跑就停下，让用户启动。记下 agentId 和时区。
2. 弄清要做的事，只问会改变结果、又查不到的：卡片标题（给建议值）、挂在正式版还是开发版、要不要审批、
   超时、要不要定时。要定时的话，用一句中文复述「几点、哪几天、做什么、几点前必须结束、失败通不通知」，
   确认后再写 cron。用户没提定时就不加。
3. 写片段到临时文件，\`add --file\`（改已有的用 \`targets <id>\` 拿原文，只改要改的字段，\`add --replace\`）。
   被拒时报错里写着字段和步骤，照着改。
4. 定时的：\`add\` 输出里核对 nextRun（UTC，换成用户时区再说）。总开关是关的，告诉用户到点不会跑，
   请他在设置页打开。
5. 手动 \`trigger\` 一次，\`log <id>\` 看结果，跑通再交给定时。会写远端或耗时很长的，先问用户要不要现在跑。
   返回 \`input-required\` 表示要审批或补输入，请用户在桌面端或 Hub 上处理。

删除 target 先跟用户确认。

## target 片段

顶层直接是 id，不写 \`targets:\`。

\`\`\`yaml
<对象>-<动作>-<agentId>:
  title: 每天凌晨更新 GameCore
  expose: a2a
  audit: summary
  requiresApproval: false
  notify: on-failure
  concurrency: 1
  timeout: 30m
  steps:
    - uses: versionControl/svn-update
      cwd: /Users/<me>/workspace/GameCore
  schedule: "0 2 * * *"
  oncePerDay: true
  deadline: "07:30"
\`\`\`

${targetFieldRules(T)}
字段以 agent 仓 \`src/contract/schemas/target.json\` 为准。

### 步骤

${stepRules(T)}
### 定时

${scheduleFieldRules(T)}
### 运行时输入（inputs）

${inputRules()}
\`\`\`yaml
  inputs:
    - name: branch
      label: 分支
      choices: [trunk, release]
      default: last
      allowCustom: true
      required: true
\`\`\`

手动触发时先 \`inputs <id>\` 看候选，用户没说清的让他从候选里挑，再 \`trigger <id> --var branch=xxx\`。

## 场景：把项目脚本接成 target

1. 在当前项目里找到脚本，记下仓库绝对路径和脚本相对路径，确认有可执行位（没有就用 \`bash ./x.sh\`）。
   读一遍，弄清子命令、耗时、会不会重启或替换 agent 自己、有没有交互输入。
2. 用 agent 的环境试跑。agent 以登录 shell 环境执行脚本（\`$SHELL -ilc\` 取一次），所以这样模拟：

   \`\`\`text
   env -i HOME="$HOME" USER="$USER" SHELL="$SHELL" "$SHELL" -ilc 'cd <repo> && <script>'
   \`\`\`

   只读子命令（check、dry-run、--help）都跑一遍，会改东西的留到最后 \`trigger\`。
3. 脚本会替换或重启某个 agent 时，target 不能挂在那个 agent 上，否则跑到一半把自己杀掉。
4. 走通用流程第 3 到 5 步。脚本本身跑不通时，让用户回项目修好，不要在 target 里堆内联命令兜底。

前后需要「先更新代码」「再打开工程」这类通用动作时，在同一个 target 里加 \`uses\` 步骤，不用在脚本里重写。

## 场景：用能力包编排定时任务

例如「看看 workspace 里的项目，每天凌晨更新 SVN」：

1. 在工作区里确认工程根（有 \`.svn\` 的目录）。多个工程就问清是哪几个，每个工程一个 step 或一个 target。
2. \`pack-tools versionControl\` 拿 svn-update 的参数，按需填 \`with\`（如冲突策略）。
3. 定时按通用流程复述并确认，夜间任务配 \`deadline\`，保证上班前结束。
4. 先 \`trigger\` 跑一次，再交给定时。

## 工作副本池（workingCopyPool 包）

${poolRules(T)}
## 已知坑

- 脚本里的变量一律写 \`\${VAR}\`。macOS 自带 bash 3.2 在 UTF-8 locale 下会把紧跟变量的中文全角字符当成变量名，
  \`"$REF）"\` 在 \`set -u\` 下报 unbound variable，终端里不一定复现。
- 脚本环境是 agent 启动时取的。新装工具或改了 shell 配置，要重启 agent。\`logs/agent.jsonl\` 里
  \`[env] target 脚本环境：\` 一行写着来源和 PATH，显示 \`fallback\` 时脚本最好自己 \`export PATH\`。
- 步骤用 \`/bin/sh -c\` 执行，进程组隔离，超时整组杀掉。脚本不能等交互输入。
- \`add --replace\` 只影响下一次运行，正在跑的不受影响。
- \`add\` 后 \`cardUpdateReported: false\` 通常是 agent 当前没连上 Hub，连上后会随注册带上新卡片。
- Windows：数据目录在 \`%APPDATA%\\com.novoard.agent[.dev]\`；agent 沿用自身进程环境，不取登录 shell，
  试跑直接在 PowerShell 里 \`cd <repo>; <script>\`；步骤用 \`cmd.exe /c\` 执行。
- Windows 上 agent 0.3.6 之前 \`openApp\`/\`openPath\` 会挂到超时，且引号被转义成 \`\\"\`。旧版上改用
  \`script: powershell -NoProfile -Command Start-Process .\\xxx.exe\`，cwd 指到程序目录。

## 收尾

踩到会让下次走错的坑，记到 novoard-agent 仓：Target、步骤、定时、工作副本池这类两边共用的规则改
\`src/novoard-skill-rules.mjs\`，只和编码会话有关的改 \`scripts/gen-manage-skill.mjs\`；然后 \`npm run skill:gen\`，
把 \`skills/novoard-manage/\` 发布到 Dec。是 agent 行为问题就去仓里修代码。不要直接改 Dec 上的正文，也不要记进对话记忆。
`;
}

const text = buildManageSkill();
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch {}
  if (current !== text) {
    console.error("skills/novoard-manage/SKILL.md 与规则源不一致，运行 npm run skill:gen 重新生成");
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
  console.log(`已生成 ${OUT}`);
}
