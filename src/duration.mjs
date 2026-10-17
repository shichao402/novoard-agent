/** 把 30s / 10m / 1h / 1d 转成毫秒。不合法时用 fallback。 */
export function parseDuration(value, fallbackMs) {
  const matched = String(value ?? "").trim().match(/^(\d+)(s|m|h|d)$/);
  if (!matched) return fallbackMs;
  const amount = Number(matched[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[matched[2]];
  if (!amount || !unit) return fallbackMs;
  return amount * unit;
}
