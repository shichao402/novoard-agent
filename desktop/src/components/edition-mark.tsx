import { edition } from "@/lib/edition";
import { cn } from "@/lib/utils";

export function EditionMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "grid place-items-center rounded-lg font-semibold",
        edition.markTone === "dev" ? "bg-warn text-canvas" : "bg-accent text-white",
        className,
      )}
    >
      {edition.mark}
    </div>
  );
}
