# PRD-2 Target 定义与编辑器

## 背景

target 是本仓的操作单元。用户通过编辑器改 `targets.yaml`，保存即校验、即生效，不重启。

## 数据形态

真实 schema（`src/contract/schemas/target.json`）：

```yaml
targets:
  plan:
    title: 做个计划
    expose: a2a
    audit: summary
    requiresApproval: false
    notify: on-failure
    concurrency: 1
    timeout: 10m
    vars:
      scope: project
    steps:
      - script: npm run plan
      - script: npm run build
```

顶层必须有 `targets` 键，其下每个 target 有五个必填字段：`title`、`expose`、`audit`、`requiresApproval`、`notify`。另外必须提供 `steps` 或 `template` 之一（`oneOf`）。

| 字段 | 类型 | 取值 | 默认 |
| --- | --- | --- | --- |
| `title` | string | 非空 | 必填 |
| `expose` | enum | `a2a` / `local` | 必填 |
| `audit` | enum | `none` / `summary` / `full` | 必填 |
| `requiresApproval` | boolean | | 必填 |
| `notify` | enum | `always` / `on-failure` / `never` | 必填 |
| `schedule` | string | cron 表达式 | 可选 |
| `steps` | array | 非空，四种类型 | 与 `template` 二选一 |
| `template` | string | 非空 | 与 `steps` 二选一 |
| `vars` | object | 值只能是 string/number/boolean | 可选 |
| `offline` | enum | `reject` / `queue` | `reject` |
| `offlineTtl` | duration | `^\d+(s\|m\|h\|d)$` | `30m` |
| `concurrency` | integer | 1–32 | 1 |
| `timeout` | duration | `^\d+(s\|m\|h\|d)$` | `10m` |
| `lostTtl` | duration | 同上 | `10m` |
| `approvalTtl` | duration | 同上 | `10m` |

关键差异（此前文档写错的地方）：

- `expose` 只有两个值 `a2a` / `local`，没有 `all` 也没有 `none`。`a2a` 表示对 Hub 与对等方都可见，`local` 表示只在本机可见。
- `audit` 与 `notify` 是必填，不能省略。
- 没有 `icon` 字段。磁贴的 `icon` 来自 `t.icon ?? "▶"`，但 schema 里 `additionalProperties: false`，写了会被校验拒绝，所以实际永远是 `▶`。
- `additionalProperties: false` 意味着任何未定义字段都会导致整份定义被拒。

步骤类型四种：

```yaml
- script: echo hi        # 必填 script，可选 cwd、env
- openApp: Safari        # 必填 openApp
- openPath: ~/Documents  # 必填 openPath
- template: build        # 必填 template，装载期展开成 steps
```

`template` 与 `script` 互斥（`stepTemplate` 与 `stepScript` 是不同分支），所以不能写"引模板再覆盖脚本"。

## 保留 id

`converse` 是成员对话技能的保留 id，target 不得占用。`validateTargetsData` 会显式检查。

## 用户故事

**US1 看得见当前定义。** 打开编辑器看到 YAML 原文，可以直接改。

**US2 改错要拦住。** 保存时校验，失败返回逐条错误，不写盘。

**US3 保存即生效。** 保存后新触发立即用新定义，在途任务沿用旧定义跑完。

**US4 改坏了能找回。** 保存前备份 `targets.yaml.bak`。

**US5 步骤类型够用。** 支持 `script`、`openApp`、`openPath`、`template`。

**US6 模型也能改。** `novoard_upsert_target` / `novoard_delete_target` 走同一套 HTTP 接口与校验。

## 校验与保存

`targets-store.save` 的顺序：

1. 归一文本（`yaml` 源码模式或 `targets` 表单模式）。
2. `parse`，失败即返回 `errors`。
3. `validateTargetsData`：顶层 `targets` 键、保留 id、schema 校验。
4. `expandSteps` 模板引用预检，引用不存在的模板在此拦下。
5. `copyFileSync` 到 `targets.yaml.bak`（单份滚动）。
6. 写 `targets.yaml.tmp` 后 `renameSync`。
7. 从盘重装载（与启动装载同一份代码）。
8. 返回 `{ raw, expanded, card }` 交装配层热替换。

任一步失败都不写盘。见 [ADR-0012](../adr/0012-validate-before-persist.md)。

## 热生效

`onTargetsSaved` 刷新五处：`runtime.replaceTargets`、`localA2A.refreshTargets`、`cardRef.current`、`peer.replaceTargets`、`tunnel.replaceTargets` + `replaceCard`，最后 `sendCardUpdate` 上报 Hub。

在途任务用启动那一刻的 `steps` 快照，审批挂起的任务把整包 `pending` 存着，恢复时用快照。见 [ADR-0013](../adr/0013-hot-reload-scope.md)。

## 变量插值

语法 `{{var}}`。优先级：触发时传入的 vars > target 的 `vars` > 模板默认值。

无来源即失败，不静默替换成空串。`interp` 直接 `throw`，`runner.run` 里抛错会让整次运行归 `failed`。这是契约 §1.2 的硬要求，不是本仓自选。

插值失败的时机是"执行到该步骤时"，不是"保存时"——因为变量来源可能来自触发参数，保存期无法穷举。这一点与 schema 校验不同。

## 边界

- 不支持多文件拆分，所有 target 在一个 `targets.yaml`。
- 不支持 target 之间的依赖与编排。
- 不支持条件步骤与循环，步骤线性执行，任一步失败即整体失败。
- 不支持"引模板同时覆盖部分步骤"。

## 依赖

- 契约定义：Hub 仓 `schemas/target.json`（本仓有锁定拷贝）
- 校验与保存：[ADR-0012](../adr/0012-validate-before-persist.md)
- 热替换范围：[ADR-0013](../adr/0013-hot-reload-scope.md)
- 能力派生：[ADR-0015](../adr/0015-capability-derived-from-targets.md)
