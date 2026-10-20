import type { PipelineRunApiShape } from '../../../infrastructure/db/pipeline-run-shape.js';
import { statusColor, statusLabel } from '../../application/view-models/run-list.js';
import { formatCost, formatElapsed, pad, truncate } from '../../shared/format.js';
import { C, dim, faint, fg, themeColor } from '../theme.js';
import { escapeTags } from './markup.js';

/** Column widths: marker, gap, dot, gap, ticket, status, elapsed, cost, retries. Roomy rows get wide gaps; a narrow list tightens them, and the narrowest drops the retry column. */
const ROOMY = { gap: 2, ticket: 10, status: 14, elapsed: 7, cost: 8, retries: 4 };
const TIGHT = { gap: 1, ticket: 9, status: 12, elapsed: 6, cost: 7, retries: 3 };
/** Smallest: the retry column goes. */
const MINI = { gap: 1, ticket: 8, status: 12, elapsed: 5, cost: 6, retries: 0 };
const fixedWidth = (c: typeof ROOMY) => 1 + c.gap + 1 + c.gap + c.ticket + c.status + c.elapsed + c.cost + c.retries;

/** One run as one row. The selected row gets an accent bar on the left; the rest of the highlight is the list's own background. */
export function formatRunRow(r: PipelineRunApiShape, selected: boolean, width: number): string {
  const retries = Object.values(r.retryCounts).reduce((a, b) => a + b, 0);
  const color = themeColor(statusColor(r));
  const c = width >= fixedWidth(ROOMY) ? ROOMY : width >= fixedWidth(TIGHT) ? TIGHT : MINI;
  const gap = ' '.repeat(c.gap);
  const titleW = width - fixedWidth(c);
  const title = titleW >= 10 ? ` ${dim(escapeTags(truncate(r.ticketTitle, titleW - 1)))}` : '';
  return [
    selected ? fg(C.accent, '▌') : ' ',
    gap,
    fg(color, '●'),
    gap,
    escapeTags(pad(r.ticketId, c.ticket)),
    fg(color, pad(statusLabel(r), c.status)),
    dim(pad(formatElapsed(r.startedAt, r.endedAt), c.elapsed)),
    dim(pad(formatCost(r.totalCostUsd), c.cost)),
    retries > 0 ? fg(C.warn, pad(`r${retries}`, c.retries)) : faint(pad('', c.retries)),
    title,
  ].join('');
}
