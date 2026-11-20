import { useState, type ReactNode } from "react";
import { InputsDialog } from "@/components/inputs-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cancelRun, runTarget } from "@/lib/api";
import { href } from "@/lib/router";

export type Launchable = { id: string; title: string; requiresApproval?: boolean; inputs?: boolean };

/**
 * 触发一次运行：带输入的先弹输入框，需审批的先确认（PRD-8 T1）。
 * 返回 launch / cancel 与需要挂在页面里的对话框。
 */
export function useRunLauncher(base: string, options: { onStarted?: (taskId: string, target: Launchable) => void; onChanged?: () => void } = {}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [ask, setAsk] = useState<Launchable | null>(null);
  const [confirm, setConfirm] = useState<Launchable | null>(null);
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

  function launch(target: Launchable) {
    if (target.inputs) setAsk(target);
    else if (target.requiresApproval) setConfirm(target);
    else void run(target);
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
        target={ask}
        onClose={() => setAsk(null)}
        onSubmit={(vars) => {
          const target = ask;
          setAsk(null);
          if (target) void run(target, vars);
        }}
      />
      <ConfirmDialog
        open={confirm !== null}
        title={`执行 ${confirm?.title ?? ""}`}
        body="这个 Target 需要确认后才执行。"
        confirmLabel="执行"
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const target = confirm;
          setConfirm(null);
          if (target) void run(target);
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
