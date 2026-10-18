export const SLIDE_ESTIMATE_PX = 72;
export const SLIDE_OVERSCAN_PX = 960;
export const SLIDE_KEEP_PX = 480;

export function prefixHeights(heights, estimate = SLIDE_ESTIMATE_PX) {
  const prefix = new Array(heights.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < heights.length; i += 1) {
    const known = heights[i];
    prefix[i + 1] = prefix[i] + (known > 0 ? known : estimate);
  }
  return prefix;
}

export function indexAt(prefix, y) {
  const last = prefix.length - 2;
  if (last <= 0) return 0;
  const target = y < 0 ? 0 : y;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function windowBounds(prefix, scrollTop, viewport, overscan = SLIDE_OVERSCAN_PX) {
  const count = prefix.length - 1;
  if (count <= 0 || viewport <= 0) return { start: 0, end: 0 };
  const total = prefix[count];
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, total - viewport));
  const from = Math.max(0, top - overscan);
  const to = Math.min(total, top + viewport + overscan);
  const start = indexAt(prefix, from);
  let end = indexAt(prefix, Math.max(from, to - 1)) + 1;
  if (end <= start) end = Math.min(count, start + 1);
  if (end > count) end = count;
  return { start, end };
}

export function resolveWindow(prefix, scrollTop, viewport, previous, overscan = SLIDE_OVERSCAN_PX, keep = SLIDE_KEEP_PX) {
  const count = prefix.length - 1;
  if (count <= 0 || viewport <= 0) return { start: 0, end: 0 };
  if (covers(prefix, previous, scrollTop, viewport, keep)) {
    return {
      start: previous.start,
      end: Math.min(previous.end, count),
    };
  }
  return windowBounds(prefix, scrollTop, viewport, overscan);
}

function covers(prefix, range, scrollTop, viewport, keep) {
  const count = prefix.length - 1;
  if (!range || range.start < 0 || range.end <= range.start || range.start >= count) return false;
  const total = prefix[count];
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, total - viewport));
  const needFrom = Math.max(0, top - keep);
  const needTo = Math.min(total, top + viewport + keep);
  const end = Math.min(range.end, count);
  const topOk = range.start === 0 || prefix[range.start] <= needFrom;
  const bottomOk = end >= count || prefix[end] >= needTo;
  return topOk && bottomOk;
}
