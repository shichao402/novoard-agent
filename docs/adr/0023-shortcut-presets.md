# ADR-0023: 快捷预设：Target 加预填参数的界面层，不新增执行单元

- 状态：Accepted
- 日期：2026-11-24
- 讨论来源：2026-11-24 快捷切页讨论。用户希望常用操作点一下就生效，例如「验 s2 线上 bug」点一下就把工程从工作副本池准备好并打开 Unity，「s2 开工」再加开 Rider；同时讨论过是否新增 shortcut 类型、是否让步骤带条件

## Context

ADR-0020 之后，一个 target 已经能完成「从池里取分支 → 打开工程」这类组合动作，点击时还能现场挑分支。剩下的问题都在界面上：

- 运行入口要先进 Target 列表或详情，首页不能执行。
- 同一个 target 的不同常用用法没有地方存。比如「s2 验 bug」和「s2 开工」其实是同一个 target 配不同参数，现在每次都要在选择框里重新选。
- 一个通用 target（如「开分支」）想给不同工程池各配一个入口，只能复制 target 改 `poolRoot`。

PRD-8 删掉过「快捷操作」页，原因是它只是把所有 target 平铺成卡片墙，和 Target 列表重复。本 ADR 的快捷页不是平铺，而是用户自己挑出来、带参数的少量按钮。

## Decision

快捷是界面层的预设：一个 target、一组预填参数和一个按钮名。运行时就是带 vars 触发这个 target，执行链路、审批、并发、运行记录、日志全部沿用，不新增执行单元。

### 1. 数据

存 `<stateDir>/shortcuts.json`，只属于本机，不进 `targets.yaml`、不进契约、不上 Hub。

```json
{
  "version": 1,
  "shortcuts": [
    { "id": "s2-bug", "label": "s2 验 bug", "target": "s2-workspace", "vars": { "openRider": "false" }, "ask": ["branch"], "note": "只开 Unity" },
    { "id": "s2-dev", "label": "s2 开工", "target": "s2-workspace", "vars": { "branch": "s2_main", "openRider": "true" }, "ask": [] }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | `^[a-z0-9][a-z0-9-]*$`，列表内唯一 |
| `label` | 按钮名，不能为空 |
| `target` | target id；target 不存在时只提示、不挡保存 |
| `vars` | 预填值，值一律存成字符串；作为触发 vars 传入，同名 target vars 被覆盖（runner 既有优先级：触发 vars > target vars） |
| `ask` | 点击时仍要询问的 input 名单；同名出现在 `vars` 里时，预填值作为选择框的初值 |
| `note` | 可空备注 |

每个 input 因此有三种处理方式：预填（在 `vars`、不在 `ask`）、每次问（在 `ask`）、用默认（都不在，按 ADR-0020 §4 取 `default`/`last`）。

### 2. 点击

- `ask` 为空：直接带 `vars` 触发；target 需要审批时仍先弹确认。
- `ask` 非空：弹 ADR-0020 的选择框，只显示 `ask` 里的输入，初值取预填值，再取 target 默认值；提交时把预填值和选定值合并后触发。在选择框里点「执行」即视为确认审批，与直接点 target 一致。
- 候选项查询按「target vars + 快捷 vars」插值：`GET /api/targets/:id/inputs?vars=<json>`。这样同一个「开分支」target 给 s2、s3 各配一个快捷、覆盖 `poolRoot`，下拉列表也会是对应池里的分支。

### 3. 接口

- `GET /api/shortcuts` → `{ ok, shortcuts, problems }`，`problems` 按 id 列出和当前 targets 对照出的问题：target 不存在、`ask` 不是该 target 的输入、预填项既不是输入也不是变量。
- `PUT /api/shortcuts { shortcuts }` 整体替换，同源校验；结构不合法返回 `422` 和逐项错误，合法则原子写入并写审计（`target: "shortcuts"`）。

### 4. 界面

侧边栏在「概览」后新增「快捷」。按钮网格按保存顺序排列，每张卡显示按钮名、对应 target、预填值和「选 xx」标记，底部显示在途或最近一次运行，可点进运行详情或取消；悬停时出现前移、后移、编辑、删除。编辑器先选 target，再逐个输入选「每次问 / 预填 / 用默认」，并可覆盖 target 的变量。

## Consequences

- 收益：常用操作一键执行；同一个 target 的不同用法各有一个按钮，不必复制 target。
- 收益：执行语义零改动。快捷删了、坏了都不影响 target 本身；运行页、审计、Hub 看到的都是普通的 target 运行。
- 收益：不改契约，不需要 Hub 同批发版。
- 代价：快捷只在本机控制台可见，Hub 和手机暂时点不到。快捷的参数是固定的，以后要上 Hub，可以直接导出成显式传参，不需要等 Hub 侧的选择框。
- 代价：快捷的触发同样会更新 target 的 `last`，下次直接点 target 时回显的是快捷用过的值。这符合「上次用的是什么」的字面意思，暂不区分来源。
- 代价：target 改名或删除后快捷会失效，只在卡片上标红提示，不自动迁移。
- 被否决的方案一：新增可编排多个 target 的 shortcut 类型。等于造第二个执行器，审批、并发、超时、取消、运行记录、能力卡都要再做一遍，嵌套运行的状态也会变复杂；而 `uses` 多步已经能拼出绝大多数组合。
- 曾否决、后已采纳：步骤加 `when` 条件。本 ADR 起草时认为组合不多，用两个 target 就够；随后确认快捷本质上是「部分或全部参数固定的 target 执行」，而参数只能改对象、不能改做哪几步，「验 bug 只开 Unity / 开工再开 Rider」仍得拆 target。`when` 由 ADR-0024 引入，上面数据示例里的 `openRider` 就是它的开关输入。
- 被否决的方案三：把快捷写进 `targets.yaml`。那样就要改契约、跟 Hub 同批发版，而快捷本来就是个人界面偏好。

## 核对

- 存储与校验：`src/shortcuts.mjs`（`validateShortcuts`、`shortcutProblems`、`createShortcutStore`），文件 `<stateDir>/shortcuts.json`，由 `src/main.mjs` 装配。
- 接口：`src/local-a2a.mjs` 的 `/api/shortcuts` 分支；inputs 接口的 `?vars=` 由 `parseVarsParam` 解析，交给 `src/inputs.mjs` 的 `createInputService().describe(targetId, target, overrides)`。
- 界面：`desktop/src/pages/shortcuts-page.tsx`；`components/run-launcher.tsx` 的 `launch(target, { preset, ask })`；`components/inputs-dialog.tsx` 的 `only`、`preset`。
- 测试：`test/shortcuts.test.mjs`。
