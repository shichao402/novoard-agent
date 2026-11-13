// 测试假包入口（ADR-0019 §2）：node pack.mjs <tool> --project-root <dir> [--result-json <file>] [--<param> ...]
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [tool, ...rest] = process.argv.slice(2);
const opts = {};
const raw = [];
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  raw.push(arg);
  if (!arg.startsWith("--")) continue;
  const eq = arg.indexOf("=");
  if (eq > 0) {
    opts[arg.slice(2, eq)] = arg.slice(eq + 1);
    continue;
  }
  const next = rest[i + 1];
  if (next === undefined || next.startsWith("--")) {
    opts[arg.slice(2)] = true;
    continue;
  }
  const key = arg.slice(2);
  opts[key] = key in opts ? [].concat(opts[key], next) : next;
  raw.push(next);
  i += 1;
}

function result(summary, extra = {}) {
  if (opts["result-json"]) writeFileSync(opts["result-json"], JSON.stringify({ summary, ...extra }));
}

function bump(file) {
  const n = existsSync(file) ? Number(readFileSync(file, "utf8")) || 0 : 0;
  writeFileSync(file, String(n + 1));
  return n + 1;
}

switch (tool) {
  case "ok":
    console.log("普通输出");
    result(`argv=${JSON.stringify(rest.filter((a, i) => a !== "--result-json" && rest[i - 1] !== "--result-json"))}`);
    process.exit(0);
  case "fail":
    console.error("boom on stderr");
    result("故意失败");
    process.exit(1);
  case "progress":
    console.log(JSON.stringify({ type: "progress", message: "更新文件 1/2", percent: 50 }));
    console.log("中间普通行");
    process.stdout.write(JSON.stringify({ type: "progress", message: "更新文件 2/2", percent: 100 }));
    process.stdout.write("\n");
    result("进度完成");
    process.exit(0);
  case "sleep": {
    // 起一个孙进程一起睡，用来验证取消时整棵进程树被回收
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 600000)"], { stdio: "ignore" });
    if (opts["pid-file"]) writeFileSync(opts["pid-file"], JSON.stringify({ self: process.pid, child: child.pid }));
    setTimeout(() => { result("睡醒了"); process.exit(0); }, Number(opts.ms ?? 30000));
    break;
  }
  case "graceful": {
    // 模拟 Windows 控制台进程：收不到（这里是忽略）SIGTERM，只靠 stdin 的取消指令收尾
    process.on("SIGTERM", () => {});
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      if (!buf.split("\n").some((l) => { try { return JSON.parse(l).type === "cancel"; } catch { return false; } })) return;
      setTimeout(() => {
        if (opts.mark) writeFileSync(opts.mark, "cleaned");
        result("已取消");
        process.exit(130);
      }, 300);
    });
    if (opts["pid-file"]) writeFileSync(opts["pid-file"], JSON.stringify({ self: process.pid }));
    setInterval(() => {}, 1000);
    break;
  }
  case "stubborn": {
    // 既不认 SIGTERM 也不读 stdin：只能等宽限期到了被强杀
    process.on("SIGTERM", () => {});
    if (opts["pid-file"]) writeFileSync(opts["pid-file"], JSON.stringify({ self: process.pid }));
    setInterval(() => {}, 1000);
    break;
  }
  case "hold": {
    if (opts.mark) appendFileSync(opts.mark, `start ${opts["project-root"]} ${Date.now()}\n`);
    setTimeout(() => {
      if (opts.mark) appendFileSync(opts.mark, `end ${opts["project-root"]} ${Date.now()}\n`);
      result("hold done");
      process.exit(0);
    }, Number(opts.ms ?? 300));
    break;
  }
  case "flaky": {
    const n = bump(opts.counter);
    if (n < 2) { result(`第 ${n} 次失败`); process.exit(1); }
    result(`第 ${n} 次成功`);
    process.exit(0);
  }
  case "once":
    bump(opts.counter);
    result("非幂等失败");
    process.exit(1);
  default:
    console.error(`unknown tool ${tool}`);
    process.exit(64);
}
