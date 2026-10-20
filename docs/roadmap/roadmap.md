# Roadmap

本仓里程碑。跨仓里程碑见 Hub 仓 roadmap。

## 已完成（概要）

| 阶段 | 内容 |
| --- | --- |
| 拆仓 | 从 Hub 仓独立，契约锁定拷贝 + 双仓门禁 |
| 二进制化 | SEA 单文件、多平台 CI 产物、安装向导 |
| 桌面壳 | Tauri 轻壳监管 sidecar，托盘与单实例 |
| 本机 A2A | `POST /a2a` / `api/tiles` / `api/stream` 本地闭环 |
| Hub 委派 | 注册、委派执行、未确认帧重放、artifact 上传 |
| 本地会话 | 会话列表、消息流、提问与中断 |

## 改造 D1：状态可见

目标：点快捷方式之后能看见进展；对端能收到进度，而不只是终态。

| 阶段 | 内容 | 产出 | 状态 |
| --- | --- | --- | --- |
| D1-a 定调 | ADR 重新整理，从 0001 独立编号，按代码对照重写 | ADR-0001 至 0015 | 完成 |
| D1-b 状态模型 | 七态迁移、产出点、进度字段、三链路时序 | `architecture/execution-state.md` | 完成 |
| D1-c 需求面 | 磁贴状态区与对端进度的验收标准 | `prd/prd-1` F 段、`prd/prd-4` P 段、`prd/prd-5` | 完成 |
| D1-d 实现 | 运行时、状态视图、控制台、对端、委派 | 代码变更 | 未开始 |
| D1-e 回填 | 排障手册按真实症状补齐 | `guides/tile-status-debug.md` | 初稿已按代码核对 |

## D1-d 实现顺序

按依赖排，前一步不做完，后一步验证不了。

1. **运行时补漏**：`runner.mjs` 接上 `onStepStart` / `onStepEnd` 到进度；`local-a2a.mjs` 的 `trigger` 在 `launch` 失败时补 `emit` 与 `triggerHook`；`tasks/cancel` 加终态判断。
2. **状态视图**：新增 `GET /api/tasks/:taskId`；`/api/tiles` 的 `last` 与流帧同构。
3. **控制台**：唯一状态映射表覆盖七态；`pending` 只表示回执未回；状态区含步骤、用时、取消；重进自动重挂 SSE。
4. **对端**：`caller` 改按会话索引；`watchRun` 改订阅；按节流推 `working`；`report` 接受显式 state；终态必达。
5. **委派**：检查 `launch` 返回值，失败立即上行 `failed`；`message/resume` 成功时上行 `working`；`TERMINAL_OK` 补 `rejected`。

## 待排期

- 任务表落盘与重启恢复（当前内存表，见 [ADR-0011](../adr/0011-task-table-in-memory.md)）。
- 多任务并发视图（当前以 target 为单位只显示最近一次）。
- `novoard_run_target` 增加 `wait` 参数（PRD-3 P1）。
- 新增 `novoard_get_task` 工具（PRD-3 P2）。
- `src/` 内裸写的 Hub ADR 引用补 `Hub` 前缀（[ADR-0001](../adr/0001-docs-layout-and-numbering.md) 的遗留项）。
- 发布手册 `guides/release.md`。
