# ADR-0005: 任务状态只有一套枚举，展示层只做翻译

- 状态：Accepted
- 日期：2026-10-20
- 讨论来源：2026-10-20 讨论。现象：点 `/plan` 快捷方式后瞬间显示"失败"，而任务实际仍在运行

## Context

契约定义了七个任务状态：`submitted`、`working`、`input-required`、`completed`、`failed`、`canceled`、`rejected`。

本仓有四处各自维护终态集合：

| 位置 | 集合 |
| --- | --- |
| `src/local-a2a.mjs` | `completed, failed, canceled, rejected` |
| `src/main.mjs` | `completed, failed, canceled, rejected` |
| `src/tunnel-client.mjs` 的 `TERMINAL_OK` | `completed, failed, canceled`（缺 `rejected`） |
| 界面的三元表达式 | 只认 `working` / `completed` / `canceled` |

第一处与第三处不一致：`rejected` 在本地被判为终态，在上行时被拒。这意味着一个被拒绝的任务，本地认为结束了，Hub 永远收不到终态。

展示层的表达式更直接：

```ts
const label =
  state === "working" ? "运行中"
  : state === "completed" ? "完成"
  : state === "canceled" ? "已取消"
  : frame.status?.message || "失败";
```

除这三个状态以外的任何状态都落到 `message || "失败"`。而 `submitted` 的 `message` 是空串（`trigger` 里写的就是 `{ state: "submitted", message: "" }`），所以点击瞬间必然渲染"失败"。`input-required` 与 `rejected` 同样被归成失败，语义完全错位。

同时，磁贴展示历史状态时直接输出枚举值：`tile.last.state === "completed" ? "完成" : ... : tile.last.state`，用户会看到英文 `submitted`。

`pending` 也参与了这团混乱：它由 HTTP 返回驱动清空，表示"按钮按下去了"，但被当作"任务是否在跑"的信号。

## Decision

全链路只认契约这一套状态枚举。展示层只能做两件事：把枚举翻译成中文，把进度字段拼成描述。禁止用 `message` 兜底充当状态，禁止 UI 侧新增状态词。

具体约束：

- `submitted`、`working`、`input-required` 是非终态，界面上都表现为"进行中"，靠进度字段区分。
- 终态判定收敛到一个共享集合，四处重复定义合并为一处。
- `TERMINAL_OK` 的缺项必须补齐，否则 `rejected` 的终态永远上不去。
- `input-required` 不得显示为失败，它表示"需要人介入"，是可继续的状态。
- `rejected` 与 `failed` 要区分：前者没开始执行，后者执行过并出错。
- `pending` 只表示"点击已发出、回执未回"，生命周期以回执到达为终点。
- 进度是一等字段（步骤序号、总数、已用时），不从 `message` 里正则提取。

## Consequences

- 收益：本次的具体 bug 从根上消失，而不是给三元表达式补两个分支。
- 收益：四处重复的终态集合合并后，`rejected` 上行缺失这类问题会一并暴露并修掉。
- 代价：`message` 的定位收窄为"给人看的一句话说明"，不能承载结构化信息；需要结构化时新增字段，不许塞进 message。
- 代价：新增状态时，服务端、上行、界面三处必须同时改；这是有意的，因为这三处本来就该同步。
- 被否决的方案一：在现有三元表达式上补 `submitted`、`input-required`、`rejected` 三个分支。能修当前症状，但四处集合仍不一致，下个状态进来还会漏。
- 被否决的方案二：服务端新增一个 `displayState` 字段，把中文直接下发。把展示逻辑塞进协议层，违背 ADR-0004 的契约边界，且多语言场景下会僵化。
- 被否决的方案三：只在 UI 做归一化。会把四处不一致藏起来，`rejected` 上行缺失依然存在。
