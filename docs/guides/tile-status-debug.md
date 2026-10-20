# 磁贴状态排障

按症状组织，不按模块组织。每条给出判断依据与处理动作。

## 点了立刻显示失败

判断依据：打开 `/api/tasks/<taskId>`（或看 SSE 帧）确认真实状态。若返回 `submitted` 或 `working`，而界面显示失败，就是展示层问题。

根因在 `desktop/src/pages/actions-page.tsx` 的三元表达式：

```ts
const label = state === "working" ? "运行中" : state === "completed" ? "完成" : state === "canceled" ? "已取消" : frame.status?.message || "失败";
```

`submitted` 的 `message` 是空串（`trigger` 里写死 `{ state: "submitted", message: "" }`），所以必然落到"失败"。

处理：按 [ADR-0005](../adr/0005-single-task-state-enum.md) 改用唯一映射表。

## 一直是运行中，不结束

分四种情况。

任务真的在跑：看 `logs/shortcuts/<target>/<taskId>.jsonl` 是否有新行。有就是正常，只是进度粒度不足（`onProgress` 只在步骤结束时发）。

任务结束但状态没更新：查 `logs/agent.jsonl` 里有没有对应的"结束"记录。有记录而界面仍显示运行中，说明 `emit` 没被调用或 SSE 已断。

`launch` 被拒但没广播：并发满时 `startExecution` 返回失败，`local-a2a.trigger` 把任务置 `failed` 但**没有 `emit(id)`**，也没调 `triggerHook`。界面要等下一次 `/api/tiles` 轮询（4 秒）才更新，Hub 侧永远收不到。查主日志里的"并发已满"记录。见 [ADR-0009](../adr/0009-launch-failure-must-be-terminal.md)。

委派任务卡在"已受理"：同上，`tunnel-client.handleDelegate` 丢弃了 `launch` 返回值。Hub 视角永远停在 submitted。

## 对等方收不到进度

先确认走的是哪条路径。

请求带 `metadata.forPeer` 走对等路径，当前只在终态回一句，中途零帧，这是已知缺口（[PRD-4](../prd/prd-4-local-a2a-and-peer.md) 的 P2）。

不带 `forPeer` 但来自隧道走委派路径，进度经 `statusNotification` 上行，这条是完整的。若仍收不到，查上行是否报错。

## 对等方收不到终态

三个可能：

`watchRun` 登记失败：`watchRun` 依赖 `caller` 单例，`caller` 为空时直接 `return`，`watched` 里没有这条记录。终态时 `reportRun` 返回 `not-watched`，静默丢弃。查主日志里有没有 `[peer]` 相关记录。

`caller` 被覆盖：两个对等方并发时，后到的覆盖先到的，`watchRun` 绑到了错误的 `taskId` 上。

状态是 `rejected`：`uplinkTerminal` 的 `TERMINAL_OK` 不含 `rejected`，本地判终态但上行被门禁拦下。

## 报告的状态不对

`peer-talk.report` 硬编码 `state: "completed"`：

```js
return sendBack(`完成报告：${body}`, "completed", parts);
```

任务实际失败时，对等方收到的仍是"完成"。这是已知缺陷，见 [PRD-4](../prd/prd-4-local-a2a-and-peer.md) 的 P3。

## 取消之后状态被改坏

`tasks/cancel` 不判断当前是否已是终态：

```js
runtime.cancel(id);
t.state = "canceled";
t.status = { state: "canceled", message: "canceled by tile" };
emit(id);
```

对一个已 `completed` 的任务调取消，状态会被改成 `canceled` 并广播。处理：取消前先判断 `TERMINAL.has(t.state)`，是则直接返回当前快照。

## 刷新页面后状态丢失

`live` 是组件 state，刷新即丢，这是预期的。`App.tsx` 每 4 秒轮询 `/api/tiles`，所以刷新后能从 `last` 恢复。

但 `last.state` 是英文枚举，界面直接输出：

```ts
tile.last.state === "completed" ? "完成" : tile.last.state === "failed" ? "失败" : tile.last.state
```

`submitted` / `working` / `input-required` / `rejected` 都会显示英文。这是 [PRD-1](../prd/prd-1-console-and-tiles.md) F1 的另一半。

## sidecar 重启后全部回到尚未运行

预期行为。任务表在内存（[ADR-0011](../adr/0011-task-table-in-memory.md)）。历史输出在 `logs/shortcuts/`，能查到内容，但状态不再恢复。

## 委派任务在磁贴上看不到

预期行为。委派任务不写本地任务表，只存在 `agent-runtime` 的 `running` Map 里。`/api/tiles` 与 `/api/stream` 都看不到。

## 某个 target 的磁贴一直不出现

三种可能：

`expose` 是 `local` 且不在本机。`local` 的 target 只在本机磁贴可见，不上报 Hub。

定义校验失败导致整份 `targets.yaml` 被拒。查启动日志或 `GET /api/targets` 的返回。

id 占用保留字 `converse`。`validateTargetsData` 会拒绝整份定义。

## 有用的一行命令

列出某个 target 的运行记录：

```bash
ls -lt "$NOVOARD_DATA_DIR/logs/shortcuts/<target>/" | head
```

实际路径以 `GET /api/shortcuts/:id/runs` 返回的 `log` 字段为准，不要硬编码 `$NOVOARD_DATA_DIR`，因为桌面版由壳设置该变量。

看未收尾的轨迹：

```bash
ls "$NOVOARD_DATA_DIR/logs/runs/"
```

重连时 `reportAbandonedRuns` 会对这里未收尾的任务补 `run/truncated`。
