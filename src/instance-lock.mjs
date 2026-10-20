/**
 * 单实例锁（同一数据目录只允许一个 agent 进程）。
 *
 * 为什么需要：hub 侧对"同一 token 建两条连接"拒绝新连接（契约 §4.1），
 * 但同机双击两次 exe 是最常见的重复启动来源，本地先拦住能给出人话提示，
 * 而不是让用户看到一个只会在日志里重试的进程。
 *
 * 粒度按 stateDir：不同数据目录 = 不同成员身份，互不影响；跨机器由 hub 兜底。
 * 崩溃残留用 pid 存活探测判定，不依赖文件锁的生命周期（Windows 上更可靠）。
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** 读锁文件；内容不合法当作无锁，避免手工编辑残留卡死启动。 */
function readLock(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Number.isInteger(parsed?.pid) ? parsed : null;
  } catch {
    return null;
  }
}

/** pid 是否还活着：ESRCH=不存在；EPERM=存在但无权信号（视为活着）。 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function writeLock(file, agentId) {
  const fd = openSync(file, "wx");
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, agentId, startedAt: new Date().toISOString() }));
  } finally {
    closeSync(fd);
  }
}

/**
 * 获取单实例锁。
 * @returns {{ok: true, file: string, release: () => void} | {ok: false, reason: string, file: string, pid?: number}}
 */
export function acquireInstanceLock({ stateDir, agentId, log = console } = {}) {
  const file = join(stateDir, `agent-${agentId}.lock`);
  try {
    writeLock(file, agentId);
  } catch (error) {
    if (error.code !== "EEXIST") {
      // 写不了锁文件（权限/只读盘）不该挡住启动：单实例是加固，不是前置条件
      log.error?.(`单实例锁不可用（${error.message}），跳过本地防重`);
      return { ok: true, file, release() {} };
    }
    const holder = readLock(file);
    if (holder && isAlive(holder.pid)) {
      return {
        ok: false,
        file,
        pid: holder.pid,
        reason: `已有实例在运行（pid ${holder.pid}，启动于 ${holder.startedAt ?? "未知"}）。如需重启，先退出那个实例；确认已崩溃可删除 ${file}`,
      };
    }
    // 上次进程崩溃留下的残留锁：接管
    try {
      unlinkSync(file);
      writeLock(file, agentId);
    } catch (retryError) {
      return { ok: false, file, reason: `单实例锁接管失败：${retryError.message}` };
    }
  }

  let released = false;
  return {
    ok: true,
    file,
    release() {
      if (released) return;
      released = true;
      try {
        const current = readLock(file);
        if (current?.pid === process.pid) unlinkSync(file); // 只删自己的锁，避免误删接管者的
      } catch { /* 已删或无权删除都不影响退出 */ }
    },
  };
}
