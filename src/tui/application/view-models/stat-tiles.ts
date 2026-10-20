import type { PipelineRunApiShape } from '../../../infrastructure/db/pipeline-run-shape.js';
import { formatCost } from '../../shared/format.js';
import { computeStats, statusBucket } from './run-list.js';

export interface StatTile {
  id: 'active' | 'completed' | 'waiting' | 'attention' | 'spend';
  label: string;
  glyph: string;
  /** Pre-formatted big value: "3" or "$4.31". */
  value: string;
  color: string;
  /** Raw count, to decide whether a tile pulses/highlights. */
  count: number;
  /** Second line: a share bar, or a cost sparkline for the spend tile. */
  bar: string;
  caption: string;
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  if (max <= 0) return SPARK[0].repeat(values.length);
  return values.map((v) => SPARK[Math.min(SPARK.length - 1, Math.round((v / max) * (SPARK.length - 1)))]).join('');
}

/** ▰▰▰▱▱▱ — a share bar that stays readable at tile width. */
export function shareBar(fraction: number, width: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

/** The five summary tiles: counts as in the dashboard, each with a share bar and a one-line caption. */
export function buildStatTiles(runs: readonly PipelineRunApiShape[], barWidth = 10): StatTile[] {
  const s = computeStats(runs);
  const total = runs.length;
  const finished = s.completed + s.attention;
  const share = (n: number) => (total === 0 ? 0 : n / total);
  const errors = runs.filter((r) => statusBucket(r) === 'error').length;
  const waitingClarify = runs.filter((r) => statusBucket(r) === 'waiting' && r.waitingFor === 'clarify').length;
  // Oldest -> newest cost of the last 12 runs that have a cost.
  const costs = runs
    .filter((r) => r.totalCostUsd !== null)
    .slice(0, 12)
    .reverse()
    .map((r) => r.totalCostUsd as number);
  const costed = runs.filter((r) => r.totalCostUsd !== null).length;

  return [
    { id: 'active', label: 'ACTIVE', glyph: '◉', value: String(s.active), color: 'cyan', count: s.active, bar: shareBar(share(s.active), barWidth), caption: s.active > 0 ? 'running now' : 'all quiet' },
    {
      id: 'completed',
      label: 'COMPLETED',
      glyph: '✔',
      value: String(s.completed),
      color: 'green',
      count: s.completed,
      bar: shareBar(share(s.completed), barWidth),
      caption: finished > 0 ? `${Math.round((s.completed / finished) * 100)}% success rate` : 'no finished runs',
    },
    {
      id: 'waiting',
      label: 'WAITING ON YOU',
      glyph: '◷',
      value: String(s.waiting),
      color: 'yellow',
      count: s.waiting,
      bar: shareBar(share(s.waiting), barWidth),
      caption: s.waiting > 0 ? `${waitingClarify} clarify · ${s.waiting - waitingClarify} spec` : 'nothing parked',
    },
    {
      id: 'attention',
      label: 'NEEDS ATTENTION',
      glyph: '▲',
      value: String(s.attention),
      color: 'red',
      count: s.attention,
      bar: shareBar(share(s.attention), barWidth),
      caption: s.attention > 0 ? `${s.attention - errors} human · ${errors} error` : 'all clear',
    },
    {
      id: 'spend',
      label: 'SPEND',
      glyph: '◈',
      value: `$${(s.spend ?? 0).toFixed(2)}`,
      color: 'magenta',
      count: costed,
      bar: sparkline(costs) || '▁'.repeat(barWidth),
      caption: costed > 0 && s.spend !== null ? `avg ${formatCost(s.spend / costed)} / run` : 'no cost data',
    },
  ];
}
