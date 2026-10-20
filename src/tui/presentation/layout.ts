/**
 * Integer grid helpers. Percentage sizes round per widget and leave gaps or
 * overhangs between neighbours; splitting a total once keeps every cell
 * adjacent and the row exactly `total` wide.
 */

export interface Span {
  left: number;
  width: number;
}

/** `count` adjacent spans that tile `total` columns exactly; widths differ by at most one. */
export function splitEven(total: number, count: number): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.round((i * total) / count);
    const to = Math.round(((i + 1) * total) / count);
    spans.push({ left: from, width: to - from });
  }
  return spans;
}

/** Two adjacent panels, the first taking `ratio` of the width. */
export function splitRatio(total: number, ratio: number): [Span, Span] {
  const first = Math.round(total * ratio);
  return [
    { left: 0, width: first },
    { left: first, width: total - first },
  ];
}

/** `count` spans separated by `gap` empty columns, filling `total` exactly. */
export function splitGap(total: number, count: number, gap: number): Span[] {
  return splitEven(Math.max(count, total - gap * (count - 1)), count).map((span, i) => ({ left: span.left + i * gap, width: span.width }));
}
