# ADR-0008: 进度以 step 为单位，开始与结束各发一次

- 状态：Accepted
- 日期：2026-10-20
- 讨论来源：ADR 重新整理时核对 `runner.mjs`，发现 `onProgress` 的语义与界面理解不一致

## Context

`runner.mjs` 的执行循环：

```js
const result = await runStep(steps[i], resolved, i);
onProgress?.(i + 1, steps.length, describeStep(steps[i], i));
```

`onProgress` 在 `await` 之后触发，参数是 `i + 1`。也就是说 `onProgress(2, 3)` 的含义是"第 2 步已经跑完"，而不是"正在跑第 2 步"。

`agent-runtime.mjs` 把它包一层：

```js
onProgress: (i, n) => onProgress?.(i, n, `第 ${i}/${n} 步`),
```

界面如果显示"第 2/3 步"，实际正在跑第 3 步。进度永久性提前一格，在最后一步尤其明显：显示 `3/3` 之后还要等一段才结束。

同时，单步执行期间没有任何中间信号。`npm run build` 跑两分钟，这两分钟里界面完全静止，用户无法区分"在跑"和"卡死"。

runner 已经暴露了两个更准确的钩子：

```js
onStepStart({ index, command })   // 步骤开始
onStepEnd({ index, exit })        // 步骤结束
```

这两个钩子已经接到 run-trace 的 `step/start` / `step/end` 事件上，只是没接到任务状态上。

## Decision

进度的单位是 step，一个 step 发两次：开始时一次、结束时一次。

- 开始：`working` + `progress{ step: i, total: n, phase: "start" }`，界面显示"第 i/n 步 · 执行中"。
- 结束：`working` + `progress{ step: i, total: n, phase: "end", exit }`，界面可据此显示完成勾。
- 终态：`progress` 保留最后值，补 `elapsedMs` 为总用时。

`onProgress` 保留兼容，但语义明确为"第 i 步已完成"，不再用于驱动界面进度。新代码一律用 `onStepStart` / `onStepEnd`。

长任务心跳：脚本超过 15 秒无输出时补发一帧带 `elapsedMs` 的 `working`，让界面能持续跳动。心跳不改变 `step`。

## Consequences

- 收益：进度不再提前一格，`3/3` 只在最后一步真正开始时出现。
- 收益：单步长任务不再静止，心跳能持续给出"还活着"的信号。
- 代价：帧数翻倍。三步任务从 3 帧变 6 帧，加上心跳最多再多几帧。对 SSE 与上行通道都是可忽略的量。
- 代价：`phase` 是新增字段，属于本机视图（`/api/tasks/:id` 与 SSE 帧），不进契约。上行帧仍只用 `status.message` 承载"第 i/n 步"，因为那一侧受 ADR-0004 约束。
- 代价：心跳需要定时器，任务结束时要清掉。漏清会导致进程退出被拖住。
- 被否决的方案一：把 `onProgress` 的调用点移到 `runStep` 之前。改动最小，但会丢掉 "第 i 步已完成"这一信息，界面无法区分执行中与已完成。
- 被否决的方案二：把步骤拆得更细，按 stdout 行推进度。粒度看似更细，但脚本输出行数与步骤语义无关，会产生误导性的百分比。
- 被否决的方案三：不做心跳，靠客户端本地计时，即界面自己每百毫秒加一。UI 层已经在这么做（`elapsedMs` 本地递推），但本地计时无法区分"进程还在"与"进程挂了但没人通知"。
