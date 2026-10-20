import { describe, expect, it } from 'vitest';
import type { PipelineRunApiShape } from '../../src/infrastructure/db/pipeline-run-shape.js';
import { buildStatTiles } from '../../src/tui/application/view-models/stat-tiles.js';
import type { DeskView } from '../../src/tui/application/view-models/floor.js';
import { DEFAULT_HINTS, renderKeyHints } from '../../src/tui/presentation/formatters/footer.js';
import { deskCard, deskLine, thinBar } from '../../src/tui/presentation/formatters/floor.js';
import { visibleLength } from '../../src/tui/presentation/formatters/header.js';
import { formatLogLine } from '../../src/tui/presentation/formatters/log-line.js';
import { formatRunRow } from '../../src/tui/presentation/formatters/run-row.js';
import { renderStatCard, renderStatStrip } from '../../src/tui/presentation/formatters/stat-strip.js';
import { themeColor, C } from '../../src/tui/presentation/theme.js';

const plain = (s: string) => s.replace(/\{[^}]*\}/g, '');

const run = (over: Partial<PipelineRunApiShape> = {}): PipelineRunApiShape =>
  ({
    runId: 'r1', kind: 'pipeline', repoId: 'o/r', ticketId: 'GAN-41', ticketTitle: 'Re-enable permission guards', startedAt: '2026-10-20T10:00:00.000Z', endedAt: '2026-10-20T10:03:00.000Z',
    finalStatus: 'SUCCESS', totalCostUsd: 0.63, retryCounts: {}, waitingFor: null, prNumber: null, attempt: 1, reviewMode: null, reviewResult: null, acSummary: null, ...over,
  }) as unknown as PipelineRunApiShape;

describe('theme', () => {
  it('maps view-model colour names onto the palette and passes hex through', () => {
    expect(themeColor('green')).toBe(C.ok);
    expect(themeColor('magenta')).toBe(C.purple);
    expect(themeColor('#123456')).toBe('#123456');
  });
});

describe('run row', () => {
  it('shows ticket, status, elapsed, cost and title; marks only the selected row', () => {
    const row = plain(formatRunRow(run(), true, 90));
    expect(row.startsWith('▌')).toBe(true);
    expect(row).toContain('GAN-41');
    expect(row).toContain('SUCCESS');
    expect(row).toContain('3m');
    expect(row).toContain('$0.63');
    expect(row).toContain('Re-enable permission guards');
    expect(plain(formatRunRow(run(), false, 90)).startsWith(' ')).toBe(true);
  });

  it('shows retries and drops the title on a narrow list', () => {
    const row = plain(formatRunRow(run({ retryCounts: { qa: 1 } }), false, 44));
    expect(row).toContain('r1');
    expect(row).not.toContain('Re-enable');
  });

  it('never needs more columns than the list has', () => {
    for (const width of [36, 39, 42, 44, 48, 52, 70]) expect(plain(formatRunRow(run({ retryCounts: { qa: 1 } }), true, width)).length, `width ${width}`).toBeLessThanOrEqual(width);
  });
});

describe('stat strip', () => {
  const runs = [run(), run({ runId: 'r2', finalStatus: 'NEEDS_HUMAN' }), run({ runId: 'r3', finalStatus: null, endedAt: null })];

  it('puts every number on one line', () => {
    const strip = plain(renderStatStrip(buildStatTiles(runs), 0, 200));
    expect(strip).not.toContain('\n');
    expect(strip).toContain('1 active');
    expect(strip).toContain('1 completed');
    expect(strip).toContain('50% success rate');
    expect(strip).toContain('1 need attention');
    expect(strip).toContain('$1.89');
  });

  it('drops the captions rather than overflow', () => {
    const tiles = buildStatTiles(runs);
    const wide = renderStatStrip(tiles, 0, 200);
    const narrow = renderStatStrip(tiles, 0, visibleLength(wide) - 1);
    expect(visibleLength(narrow)).toBeLessThan(visibleLength(wide));
    expect(plain(narrow)).not.toContain('success rate');
  });
});

describe('stat cards', () => {
  const tiles = buildStatTiles([run(), run({ runId: 'r2', finalStatus: 'NEEDS_HUMAN' })]);
  const byId = (id: string) => tiles.find((t) => t.id === id)!;

  it('shows a label, the number and a caption, with the top line coloured only when the tile has something in it', () => {
    const completed = renderStatCard(byId('completed'), 0, 24);
    expect(completed.lines.map(plain)).toEqual(['', 'COMPLETED', '✔ 1', '50% success rate']);
    expect(completed.bar).toBe(C.ok);
    expect(renderStatCard(byId('waiting'), 0, 24).bar).toBeNull();
  });

  it('cuts a caption that is wider than the card', () => {
    expect(plain(renderStatCard(byId('completed'), 0, 8).lines[3])).toBe('50% suc…');
  });

  it('adds the cost sparkline to the spend card', () => {
    expect(plain(renderStatCard(byId('spend'), 0, 24).lines[2])).toMatch(/^◈ \$1\.26 {2}[▁-█]+$/);
  });
});

describe('desk cards', () => {
  const desk = (over: Partial<DeskView> = {}): DeskView => ({ id: 'qa', name: 'Validator', state: 'idle', text: 'Idle', tone: 'info', costUsd: 0.13, durationMs: 64_000, verify: null, working: false, ...over });

  it('shows name, state, and cost with duration; an idle agent has no accent line', () => {
    const card = deskCard(desk(), 0, 12);
    expect(card.lines.map(plain)).toEqual(['', 'Validator', '○ Idle', '$0.13  1m 4s', '']);
    expect(card.bar).toBeNull();
  });

  it('gives a working agent the accent line and a spinner, and a retry the warning colour', () => {
    const working = deskCard(desk({ working: true, state: 'implementing', text: 'Implementing' }), 0, 12);
    expect(working.bar).toBe(C.accent);
    expect(plain(working.lines[2])).toBe('⠋ Implement…');
    expect(deskCard(desk({ state: 'retrying', tone: 'warn', text: 'Retry 1/2' }), 0, 12).bar).toBe(C.warn);
  });

  it('wraps the Manager sentence instead of cutting it off', () => {
    const manager = deskCard(desk({ id: 'human', name: 'Manager', text: 'Waiting for a human to approve the spec', costUsd: null, durationMs: null }), 0, 16);
    expect(manager.lines.map(plain).slice(2)).toEqual(['Waiting for a', 'human to approve', 'the spec']);
  });
});

describe('footer hints', () => {
  it('keeps as many hints as fit, in priority order', () => {
    const full = plain(renderKeyHints(DEFAULT_HINTS, 200));
    expect(full).toContain('ctrl+p commands');
    expect(full).toContain('q quit');
    const short = plain(renderKeyHints(DEFAULT_HINTS, 40));
    expect(visibleLength(short)).toBeLessThanOrEqual(40);
    expect(short).toContain('↑↓ select');
    expect(short).not.toContain('quit');
  });
});

describe('agent rows', () => {
  const desk = (over: Partial<DeskView> = {}): DeskView => ({ id: 'planner', name: 'Planner', state: 'idle', text: 'Idle', tone: 'info', costUsd: 0.12, durationMs: 47_000, verify: null, working: false, ...over });

  it('lays an agent out as glyph, name, text, cost and duration', () => {
    const line = plain(deskLine(desk(), 0, 70));
    expect(line).toContain('○ Planner');
    expect(line).toContain('Idle');
    expect(line).toContain('$0.12');
    expect(line).toContain('47s');
    expect(visibleLength(deskLine(desk(), 0, 70))).toBeLessThanOrEqual(70);
  });

  it('spins while working and gives the Manager the full row', () => {
    expect(plain(deskLine(desk({ working: true, state: 'implementing', text: 'Implementing' }), 0, 70))).toContain('⠋ Planner');
    const manager = plain(deskLine(desk({ id: 'human', name: 'Manager', text: 'Run finished', costUsd: null, durationMs: null }), 0, 70));
    expect(manager).toContain('Manager');
    expect(manager).toContain('Run finished');
    expect(manager).not.toContain('$');
  });

  it('draws a progress bar as wide as asked', () => {
    expect(plain(thinBar(0.5, 20, C.ok))).toHaveLength(20);
    expect(plain(thinBar(0, 10, C.ok))).toBe('━'.repeat(10));
  });
});

describe('log line', () => {
  const line = (over = {}) => ({ source: 'server' as const, level: 'info' as const, time: Date.parse('2026-10-20T10:00:00Z'), message: 'Worker started', fields: {}, ...over });

  it('shows source, level and message', () => {
    expect(plain(formatLogLine(line()))).toMatch(/\d\d:\d\d:\d\d srv info Worker started/);
    expect(plain(formatLogLine(line({ source: 'tunnel' })))).toContain('tnl');
  });

  it('escapes braces in messages so they cannot be read as tags', () => {
    expect(formatLogLine(line({ message: '{red-fg}boom' }))).not.toContain('{red-fg}boom');
  });

  it('appends fields', () => {
    expect(plain(formatLogLine(line({ fields: { jobId: 7 } })))).toContain('jobId=7');
  });
});
