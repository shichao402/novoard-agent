/**
 * 桌面宿主协议：Tauri 壳与 SEA sidecar 之间的最小进程协议。
 *
 * - stdout：一行一个 JSON 事件，普通运行日志必须写 stderr；
 * - stdin：一行一个 JSON 命令；
 * - stdin 关闭视为宿主消失，sidecar 主动停机，避免残留孤儿进程。
 *
 * 仅在 NOVOARD_HOST_PROTOCOL=ndjson 时启用；Linux 默认 CLI 形态不受影响。
 */
import { createInterface } from "node:readline";

export const HOST_PROTOCOL_VERSION = 1;

export function createHostProtocol({
  input = process.stdin,
  output = process.stdout,
  onCommand = async () => {},
  onDisconnect = async () => {},
} = {}) {
  let closed = false;
  let disconnectHandled = false;

  function emit(type, detail = {}) {
    if (closed) return false;
    const event = {
      v: HOST_PROTOCOL_VERSION,
      type,
      ts: new Date().toISOString(),
      ...detail,
    };
    output.write(`${JSON.stringify(event)}\n`);
    return true;
  }

  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  lines.on("line", async (line) => {
    const text = String(line).trim();
    if (!text) return;
    let command;
    try {
      command = JSON.parse(text);
    } catch {
      emit("protocol-error", { code: "invalid-json", message: "宿主命令不是合法 JSON" });
      return;
    }
    if (command?.v !== HOST_PROTOCOL_VERSION || typeof command?.type !== "string") {
      emit("protocol-error", { code: "invalid-command", message: "宿主命令缺少有效的 v/type" });
      return;
    }
    try {
      await onCommand(command);
    } catch (error) {
      emit("protocol-error", {
        code: "command-failed",
        message: String(error?.message ?? error),
        command: command.type,
      });
    }
  });
  lines.on("close", async () => {
    if (closed || disconnectHandled) return;
    disconnectHandled = true;
    try {
      await onDisconnect();
    } catch {
      // 宿主已经消失，停机失败由进程级兜底处理。
    }
  });

  function close() {
    if (closed) return;
    closed = true;
    lines.close();
  }

  return { emit, close };
}
