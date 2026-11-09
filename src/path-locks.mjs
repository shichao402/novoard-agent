/**
 * 路径锁（PRD-7 A3）：同一工程目录同一时刻只允许一个运行持有。
 * - 一次性申请全部键，拿不到就排队，不拒绝；
 * - 先来后到：排在前面、尚未拿到锁的申请者想要的键，后来者也不能抢；
 * - 排队中可以撤销。
 * 键的规范化照搬 cronkit src/core/paths.ts normalizePathKey：绝对路径、统一分隔符；Windows 下转小写。
 */
import { resolve } from "node:path";

export function normalizePathKey(p, platform = process.platform) {
  const key = resolve(String(p)).replace(/\\/g, "/");
  return platform === "win32" ? key.toLowerCase() : key;
}

export function createPathLocks() {
  const held = new Set();
  /** [{ keys, grant, id }] */
  const waiters = [];
  let seq = 0;

  function pump() {
    const reserved = new Set();
    for (let i = 0; i < waiters.length; ) {
      const w = waiters[i];
      const free = w.keys.every((k) => !held.has(k) && !reserved.has(k));
      if (free) {
        waiters.splice(i, 1);
        for (const k of w.keys) held.add(k);
        w.grant();
        continue;
      }
      for (const k of w.keys) reserved.add(k);
      i += 1;
    }
  }

  /**
   * 申请一组键。→ { immediate, blockedBy, ready: Promise<void>, release() }
   * immediate=true 时已拿到锁；blockedBy 是当前挡住它的键（供排队文案）。
   * release()：已拿到则释放，仍在排队则撤销；可重复调用。
   */
  function acquire(rawKeys) {
    const keys = [...new Set(rawKeys)];
    let granted = false;
    let done = false;
    let grant;
    const ready = new Promise((res) => { grant = () => { granted = true; res(); }; });
    const waiter = { keys, grant, id: ++seq };
    const release = () => {
      if (done) return;
      done = true;
      if (granted) {
        for (const k of keys) held.delete(k);
      } else {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
      }
      pump();
    };
    if (keys.length === 0) {
      grant();
      return { immediate: true, blockedBy: [], ready, release };
    }
    const blockedBy = keys.filter((k) => held.has(k) || waiters.some((w) => w.keys.includes(k)));
    waiters.push(waiter);
    pump();
    return { immediate: granted, blockedBy: granted ? [] : blockedBy, ready, release };
  }

  return {
    acquire,
    get held() {
      return [...held];
    },
    get waiting() {
      return waiters.length;
    },
  };
}
