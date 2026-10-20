# ADR-0015: 能力清单从定义派生，不手工维护

- 状态：Accepted
- 日期：2026-10-20
- 讨论来源：ADR 重新整理时核对 `card.mjs` 的 `deriveCard` 与 `peer-talk` 的 `composeReply`，确认能力清单只有一个来源

## Context

"这台机器能做什么"有三个地方要说：

1. 注册到 Hub 时的 agent card（`skills` 数组）。
2. 对等 agent 问"你能做什么"时的回答（`composeReply`）。
3. 本机控制台的磁贴列表（`/api/tiles`）。

如果三处各维护一份清单，就会出现"Hub 上能看到、对等方问不到"或"磁贴上有、Hub 上没有"。

代码里的做法是从定义派生：

```js
// card.mjs
export function deriveCard({ agentId, targets, agentDir, profile }) {
  const skills = Object.entries(targets)
    .filter(([, t]) => t.expose === "a2a")
    .map(...);
  ...
}

// peer-talk.mjs
const abilities = Object.entries(targets ?? {})
  .filter(([, target]) => target?.expose !== "local")
  .map(...);
```

两处用的是同一份 `targets`，但过滤条件写法不同：card 用 `=== "a2a"`，`composeReply` 用 `!== "local"`。在当前两值枚举（`a2a` / `local`）下等价，但写法不一致意味着将来加第三个值时两者会分叉。

磁贴的过滤又是第三个条件：

```js
.filter(([, t]) => t.expose !== "none")
```

而 schema 里 `expose` 只有 `a2a` 与 `local` 两个值，没有 `none`。所以这个 `filter` 恒为真，是个无效判断。

## Decision

能力清单只从 `targets` 派生，不手工维护。三处使用同一个过滤函数，判定规则集中在一处。

- 定义 `exposeCapability(target)`，返回"是否对外公布"。
- card、`composeReply`、磁贴都调它，不各写比较。
- 磁贴上的 `expose !== "none"` 是无效判断，应删掉或改为正确的语义（`none` 这个概念当前不存在）。
- 过滤条件变更时，三处同时生效。

同时明确语义：`expose: "a2a"` 表示对 Hub 与对等方都可见；`expose: "local"` 表示只在本机磁贴可见。

## Consequences

- 收益：新增 target 时一次定义三处可见，不会漏。
- 收益：`expose` 的语义有明确落点，不再依赖三处不同写法碰巧一致。
- 代价：过滤器成为公共依赖，改它要评估三处影响。这是有意的，因为本来三处就该一致。
- 代价：删除无效判断时，若将来真的引入 `none`，需要重新加回。
- 被否决的方案一：手工维护三份清单。必然漂移，且漂移后很难发现（只有特定视角才暴露）。
- 被否决的方案二：只从 card 派生，`composeReply` 读 card。会引入"card 何时刷新"的时序问题，且 `composeReply` 在模型不可用时也要能答，不应该依赖 card 是否已上报。
- 被否决的方案三：给 `expose` 加 `none` 语义。目前没有需求，加枚举值属于契约变更（ADR-0004）。
