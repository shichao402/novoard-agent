/** 最近使用优先，频次适度加权；七天半衰期，避免旧的高频值永久占据首位。 */
export const INPUT_USAGE_LIMIT = 100;
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

export function validInputUsage(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.filter((item) => {
    if (!item || typeof item.value !== "string" || !item.value || seen.has(item.value)) return false;
    if (!Number.isSafeInteger(item.count) || item.count < 1 || !Number.isFinite(item.lastUsedAt) || item.lastUsedAt < 0) return false;
    seen.add(item.value);
    return true;
  }).map(({ value, count, lastUsedAt }) => ({ value, count, lastUsedAt }));
}

export function rankInputChoices(choices, history = [], now = Date.now()) {
  const usage = new Map(validInputUsage(history).map((item) => [item.value, item]));
  const score = (item) => {
    if (!item) return 0;
    const frequency = Math.min(3, Math.log2(1 + item.count));
    if (item.lastUsedAt === 0) return frequency / 8; // 旧 last 只有一次使用线索，没有时间。
    return (8 + frequency) * 2 ** (-Math.max(0, now - item.lastUsedAt) / HALF_LIFE_MS);
  };
  return choices.map((choice, index) => {
    const item = usage.get(choice.value);
    return { choice: item ? { ...choice, usage: { count: item.count, lastUsedAt: item.lastUsedAt } } : choice, index, item };
  }).sort((a, b) => score(b.item) - score(a.item) || (b.item?.lastUsedAt ?? 0) - (a.item?.lastUsedAt ?? 0) || a.index - b.index)
    .map(({ choice }) => choice);
}
