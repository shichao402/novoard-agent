import { useState, type ReactNode } from "react";
import { InputsDialog } from "@/components/inputs-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cancelRun, runTarget } from "@/lib/api";
import { href } from "@/lib/router";

export type Launchable = { id: string; title: string; requiresApproval?: boolean; inputs?: boolean };

/**
 * 快捷预设带来的参数（ADR-0023）：preset 直接作为触发 vars；ask 是仍要弹框询问的输入。
 * 不传时按 target 本身：有 inputs 就全部询问。
 */
export type LaunchOptions = { preset?: Record<string, string>; ask?: string[] };

type Pending = { target: Launchable; preset: Record<string, string>; only?: string[] };

/**
 * 触发一次运行：带输入的先弹输入框，需审批的先确认（PRD-8 T1）。
 * 返回 launch / cancel 与需要挂在页面里的对话框。
 */
export function useRunLauncher(base: string, options: { onStarted?: (taskId: string, target: Launchable) => void; onChanged?: () => void } = {}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [ask, setAsk] = useState<Pending | null>(null);
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [canceling, setCanceling] = useState<string | null>(null);

  async function run(target: Launchable, vars?: Record<string, string>) {
    setPending(target.id);
    setError("");
    try {
      const result = await runTarget(base, target.id, vars);
      if (result.error?.message) throw new Error(result.error.message);
      const status = result.result?.status;
      if (status?.state === "failed" || status?.state === "rejected") throw new Error(status.message || "执行失败");
      const taskId = result.result?.id;
      if (taskId) options.onStarted?.(taskId, target);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "执行失败");
    } finally {
      setPending(null);
      options.onChanged?.();
    }
  }

  function launch(target: Launchable, launchOptions?: LaunchOptions) {
    const preset = launchOptions?.preset ?? {};
    const only = launchOptions ? launchOptions.ask ?? [] : undefined;
    const needsAsk = only ? only.length > 0 : target.inputs === true;
    if (needsAsk) setAsk({ target, preset, only });
    else if (target.requiresApproval) setConfirm({ target, preset });
    else void run(target, preset);
  }

  async function cancel(taskId: string) {
    setCanceling(taskId);
    setError("");
    try {
      await cancelRun(base, taskId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "取消失败");
    } finally {
      setCanceling(null);
      options.onChanged?.();
    }
  }

  const dialogs: ReactNode = (
    <>
      <InputsDialog
        base={base}
        target={ask?.target ?? null}
        only={ask?.only}
        preset={ask?.preset}
        onClose={() => setAsk(null)}
        onSubmit={(vars) => {
          const current = ask;
          setAsk(null);
          if (current) void run(current.target, { ...current.preset, ...vars });
        }}
      />
      <ConfirmDialog
        open={confirm !== null}
        title={`执行 ${confirm?.target.title ?? ""}`}
        body="这个 Target 需要确认后才执行。"
        confirmLabel="执行"
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const current = confirm;
          setConfirm(null);
          if (current) void run(current.target, current.preset);
        }}
      />
    </>
  );

  return { launch, cancel, pending, canceling, error, setError, dialogs };
}

/** 运行报错；「并发已满」可点击跳到运行页看占用者（PRD-8 验收）。 */
export function RunError({ message, className = "" }: { message: string; className?: string }) {
  if (!message) return null;
  const busy = message.includes("并发已满");
  return (
    <p className={`text-sm text-bad ${className}`} role="alert">
      {busy ? <a className="underline-offset-2 hover:underline" href={href("runs")}>{message} · 查看正在运行</a> : message}
    </p>
  );
}
