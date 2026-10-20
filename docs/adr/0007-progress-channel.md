# ADR-0007: 进度通道复用既有 SSE 与上行帧，不新增契约字段

- 状态：Accepted
- 日期：2026-10-20
- 讨论来源：2026-10-20 讨论。确定"受理即回执、进度靠推送"之后，需要定推送走什么通道

## Context

两条链路的目标读者不同：

- 本机用户，与 sidecar 共享回环网络，页面里直接连。
- 远端对等 agent，隔着隧道，只能通过上行 `message/notification` 与 Hub 通信。

服务端已有的通道：

1. `GET /api/stream/:taskId`：SSE。连上先写一帧当前快照，终态帧后关闭。控制台正在用。
2. `POST /a2a` 的 `message/send`：同步返回回执，含 `taskId` 与当前 status。
3. `tasks/get`：查一次快照。
4. 隧道上行 `statusNotification(taskId, state, message)`：委派路径已在用，进度文案形如 `step i/n：d`。

缺口有两个：

- 没有"按 taskId 取完整快照"的独立查询接口。页面重进或 SSE 断线后只能靠 `/api/tiles` 的 `last`，而它的形状与流帧不同（扁平 vs 嵌套），渲染逻辑要写两套。实际上 `/api/tiles` 每 4 秒轮询一次，所以"完全看不到"的情况不存在，但形状不一致导致状态区显示的是英文枚举。
- 对等触发路径只在终态回调 `reportRun` 回一句"已结束"，中途零帧。

## Decision

本机用 SSE，对端用上行状态帧，不新增契约字段。

本机侧：

- 复用 `GET /api/stream/:taskId` 的既有行为（先快照、终态关流），不改语义。
- 新增 `GET /api/tasks/:taskId` 返回与流帧同构的完整视图；`/api/tiles` 的 `last` 也改为同构对象。目的不是"补一个查询"，而是消除两套形状。
- SSE 断线重连与页面重进都靠这个接口重建，不依赖组件内的 `live` state。

对端侧：

- 复用 `statusNotification`，新增节流的 `working` 帧。节流规则：状态变化立即发；同一状态下的进度更新最多每秒一帧；步骤切换必须发，不参与节流；终态必发。
- 对等触发路径（`metadata.forPeer`）接上与委派路径相同的进度上报。

不加 `message/send` result 的 `metadata.progressUrl`：加字段属契约变更（见 ADR-0004），要改 Hub 仓契约文档与 schema、本仓同步锁定拷贝与 `CONTRACT_VERSION`，且本机在 NAT 后，Hub 主动回连还要解决可达性。现有上行通道已能表达进度，只需补节流与调用点。

## Consequences

- 收益：两条链路都复用已存在的通道，改动集中在"什么时候发"，不涉及"用什么发"。
- 收益：不触发跨仓契约变更，本仓可独立发布。
- 代价：SSE 是长连接，要处理断线与重连。重连后靠快照补齐，不追求帧不丢。
- 代价：对端进度粒度受节流限制，最细到 1 秒。对分钟级任务够用；秒级短任务需要更细粒度时要重新评估。
- 代价：`progressUrl` 这条路暂时封着。若 Hub 需要主动回连本机拉进度，必须回到契约层重新讨论。
- 被否决的方案一：`metadata.progressUrl`。跨仓契约变更，且需解决 NAT 后的可达性。
- 被否决的方案二：纯轮询 `tasks/get`。见 ADR-0006 的方案二。
- 被否决的方案三：改用 A2A `message/stream`。本机已有 SSE 且控制台在用，Hub 侧透传流式未验证。
- 被否决的方案四：把进度塞进 `status.message` 让人读。这正是当前的做法，代价是客户端无法结构化解析，且与状态语义混在一起（见 ADR-0005）。
