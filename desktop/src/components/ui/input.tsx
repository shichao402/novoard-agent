import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-muted">{label}</span>
      {children}
      {error ? <span className="mt-1.5 block text-[11px] leading-5 text-bad">{error}</span> : null}
      {!error && hint ? <span className="mt-1.5 block text-[11px] leading-5 text-faint">{hint}</span> : null}
    </label>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-lg border border-line-hi bg-surface px-3 text-[13px] text-ink outline-none placeholder:text-faint focus:border-accent",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-9 w-full rounded-lg border border-line-hi bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "min-h-24 w-full rounded-lg border border-line-hi bg-surface px-3 py-2 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-faint focus:border-accent",
        className,
      )}
      {...props}
    />
  );
}
