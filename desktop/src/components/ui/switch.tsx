export function Switch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`relative h-6 w-11 rounded-full transition-colors ${checked ? "bg-accent" : "bg-line-hi"}`}
      onClick={() => onChange(!checked)}
    >
      <span className={`absolute top-0.5 size-5 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}
