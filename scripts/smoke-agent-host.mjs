/**
 * 构建后 SEA 宿主协议 smoke：
 * 无配置启动 setup → HTTP 可达 → stdin shutdown → stopped + exit 0。
 * CI 在每个平台 staging/打包前执行，避免“能注入但桌面壳无法托管”的假绿。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const platform = process.env.NOVOARD_BUILD_PLATFORM ?? process.platform;
const arch = process.env.NOVOARD_BUILD_ARCH ?? process.arch;
const executable = platform === "win32" ? "novoard-agent.exe" : "novoard-agent";
const binary = resolve(
  process.env.NOVOARD_AGENT_BINARY
    ?? join("build", "dist", `${platform}-${arch}`, executable),
);
const dataDir = mkdtempSync(join(tmpdir(), "novoard-host-smoke-"));

try {
  const result = await runSmoke(binary, dataDir);
  console.log(`✓ SEA 宿主 smoke：${result.events.join(" → ")}，setup HTTP ${result.httpStatus}`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

function runSmoke(program, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, [], {
      env: {
        ...process.env,
        NOVOARD_HOST_PROTOCOL: "ndjson",
        NOVOARD_DATA_DIR: cwd,
        NOVOARD_SETUP_PORT: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const events = [];
    let stdout = "";
    let stderr = "";
    let httpStatus = null;
    let shutdownSent = false;
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(new Error(`SEA 宿主 smoke 超时；events=${events.join(",")} stderr=${stderr.slice(-1000)}`));
    }, 15_000);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value);
    }

    child.on("error", (error) => finish(error));
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      void consumeLines().catch((error) => {
        try { child.kill("SIGKILL"); } catch {}
        finish(error);
      });
    });
    child.on("close", (code) => {
      void consumeLines(true).then(() => {
        if (code !== 0) {
          finish(new Error(`SEA 退出码 ${code}；stderr=${stderr.slice(-1000)}`));
          return;
        }
        if (!events.includes("ui-ready") || !events.includes("stopped")) {
          finish(new Error(`SEA 宿主事件不完整：${events.join(" → ")}`));
          return;
        }
        finish(null, { events, httpStatus });
      }).catch(finish);
    });

    async function consumeLines(flush = false) {
      let index;
      while ((index = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (line) await consumeEvent(line);
      }
      if (flush && stdout.trim()) await consumeEvent(stdout.trim());
    }

    async function consumeEvent(line) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error(`stdout 出现非协议内容：${line.slice(0, 300)}`);
      }
      events.push(event.type);
      if (event.type === "fatal") {
        throw new Error(`SEA fatal：${event.message ?? event.code ?? "unknown"}`);
      }
      if (event.type === "ui-ready" && !shutdownSent) {
        const response = await fetch(event.url);
        httpStatus = response.status;
        if (response.status !== 200) throw new Error(`setup HTTP ${response.status}`);
        shutdownSent = true;
        child.stdin.write('{"v":1,"type":"shutdown"}\n');
      }
    }
  });
}
