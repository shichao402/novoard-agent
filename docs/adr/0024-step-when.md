# ADR-0024: 步骤级 when：插值后真假决定跑不跑，不引入表达式

- 状态：Accepted
- 日期：2026-11-24
- 讨论来源：2026-11-24 快捷切页讨论。ADR-0023 起草时先否决了步骤条件，随后用户指出「快捷其实就是部分或者全部参数固定的一种 target 执行」，而参数只能改作用对象、不能改做哪几步，于是改为引入 `when`。

## Context

一个「准备工程」target 的典型步骤：从工作副本池取分支 → 打开 Unity → 打开 Rider。用户的常用组合是「验 bug 只开 Unity」「开工再开 Rider」。没有条件时只能拆成两个几乎一样的 target，改一处要改两处；快捷预设（ADR-0023）也只能预填参数，选不了步骤。

## Decision

1. 契约 v2.9（Hub `docs/architecture/schemas/target.json`，本仓锁定拷贝 `src/contract/schemas/target.json`）给 `script`、`openApp`、`openPath`、`uses` 四种步骤加可选字段 `when`（非空字符串）。`template` 步骤不支持。
2. 语义只有真假：`when` 先按 §1.2 插值，再去掉首尾空白、转小写；等于 `""`、`false`、`0`、`no`、`off` 时跳过这一步，其余值照常执行。插值无来源照常报错，整次运行失败，不当作假。实现：`src/runner.mjs` 的 `isWhenTrue`、`skipValue`。
3. 跳过不算失败，整次运行按其余步骤的结果收尾。跳过的步骤不起进程，不发 `step/start`、`step/end`，不写运行记录（trace）事件，只经 `onStepSkip` 在输出日志里写一行带 `step` 字段的记录，格式由 `src/agent-runtime.mjs` 的 `skipLine` 固定：`[step i] 已跳过 <命令>（when 为 "<值>"）`。
4. 为假的 `uses` 步骤不占路径锁（`lockKeysFor` 先求 `when`）。
5. 开关输入不新增类型：`inputs` 的 `choices` 恰好是 `["true","false"]` 时，桌面端输入框和快捷编辑显示为开关（`desktop/src/lib/switch-input.ts` 的 `isSwitchChoices`），值仍是字符串。
6. 桌面端：步骤编辑器每个非模板步骤有「执行条件」输入框（`desktop/src/components/steps-editor.tsx` 的 `WhenField`），草稿往返见 `desktop/src/lib/target-draft.mjs` 的 `whenOf`；运行详情用 `parseSkip` 识别跳过行，把该步显示为「已跳过」。

示例：

```yaml
inputs:
  - name: openRider
    label: 打开 Rider
    choices: ["true", "false"]
    default: "false"
steps:
  - uses: workspace/acquire
    cwd: "{{poolRoot}}"
  - openApp: unity
  - openApp: rider
    when: "{{openRider}}"
```

## Consequences

- 快捷「s2 验 bug」预填 `openRider=false`，「s2 开工」预填 `true`，共用一个 target。
- trace 是封闭 schema 且上传 Hub，不加 `skipped` 事件就不需要 Hub 同步改 trace；代价是「已跳过」只能从输出日志识别，没有输出日志的历史运行里，被跳过的步骤显示为未开始。
- Hub 只接收卡片，不接收 target 定义，旧 Hub 不受影响；但锁定拷贝升到 2.9 后，本仓与 Hub 的契约版本要一起发布。

## Alternatives

- 表达式（`{{a}} == 'x' && ...`）：否决。需要自建求值器、转义规则和错误提示，而现有用例都是开关；以后真有需要，可在 `when` 之外另加字段，不改变现有真假语义。
- 用 `skip` 字段（真则跳过）：否决。和开关输入的直觉相反，`when: "{{openRider}}"` 读起来就是「要开 Rider 才跑」。
- 在 trace 里加 `step/skip` 事件：否决。trace 封闭 schema 会让旧 Hub 拒收上行，换来的只是历史运行的展示精度。
- 允许 template 步骤带 `when`：暂缓。模板展开后是多步，条件作用于整组还是逐步有歧义，目前没有用例。
