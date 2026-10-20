import { describe, expect, it } from 'vitest';
import { splitEven, splitGap, splitRatio } from '../../src/tui/presentation/layout.js';

describe('splitEven', () => {
  it.each([[200, 5], [187, 5], [160, 6], [101, 6], [30, 7]])('tiles %i columns into %i adjacent spans', (total, n) => {
    const spans = splitEven(total, n);
    expect(spans).toHaveLength(n);
    expect(spans[0].left).toBe(0);
    for (let i = 1; i < n; i++) expect(spans[i].left).toBe(spans[i - 1].left + spans[i - 1].width);
    const last = spans[n - 1];
    expect(last.left + last.width).toBe(total);
    const widths = spans.map((s) => s.width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });
});

describe('splitRatio', () => {
  it('returns two touching panels covering the width', () => {
    const [a, b] = splitRatio(187, 0.38);
    expect(a).toEqual({ left: 0, width: 71 });
    expect(b).toEqual({ left: 71, width: 116 });
  });
});

describe('splitGap', () => {
  it.each([[190, 5, 2], [101, 6, 1], [40, 3, 2]])('tiles %i columns into %i spans with a %i-column gap', (total, n, gap) => {
    const spans = splitGap(total, n, gap);
    expect(spans[0].left).toBe(0);
    for (let i = 1; i < n; i++) expect(spans[i].left).toBe(spans[i - 1].left + spans[i - 1].width + gap);
    const last = spans[n - 1];
    expect(last.left + last.width).toBe(total);
  });
});
