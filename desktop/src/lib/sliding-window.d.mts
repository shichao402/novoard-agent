export function prefixHeights(heights: number[], estimate?: number): number[];

export function indexAt(prefix: number[], y: number): number;

export function windowBounds(
  prefix: number[],
  scrollTop: number,
  viewport: number,
  overscan?: number,
): { start: number; end: number };

export function resolveWindow(
  prefix: number[],
  scrollTop: number,
  viewport: number,
  previous: { start: number; end: number } | null,
  overscan?: number,
  keep?: number,
): { start: number; end: number };
