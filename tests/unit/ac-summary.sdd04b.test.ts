import { describe, it, expect } from 'vitest';
import {
  parseRequirementAcs,
  parseReportAcTable,
  summarizeAcs,
  renderAcSummary,
} from '../../src/infrastructure/reports/ac-summary.js';

// CAF-SDD-04b: pure AC parser + status counter (no I/O, no model).

const REQUIREMENTS = [
  '# Ticket',
  '## 6. Acceptance Criteria',
  '- AC-1: When x, then y. Verify: automated test.',
  '- AC-2: When a, then b.',
  '- AC-7b: suffixed id.',
  '  - AC-9: nested bullet is still an AC line',
  'Prose mentioning AC-3 inline is not an AC line.',
  '- AC-1: duplicate id is listed once.',
].join('\n');

const report = (rows: string[], notes: string[] = []) =>
  [
    '## Validate Report — CAF-1',
    'Status: PASS',
    '',
    '### Acceptance Criteria',
    '| AC | Status | Evidence kind | Evidence |',
    '|----|--------|---------------|----------|',
    ...rows,
    ...(notes.length ? ['', '### Notes', ...notes] : []),
  ].join('\n');

describe('AC-1: parseRequirementAcs', () => {
  it('returns every `- AC-n:` id in order of appearance, suffix ids included, without duplicates', () => {
    expect(parseRequirementAcs(REQUIREMENTS)).toEqual(['AC-1', 'AC-2', 'AC-7b', 'AC-9']);
  });

  it('returns [] when there is no AC line', () => {
    expect(parseRequirementAcs('# Title\nSome prose about AC-1.')).toEqual([]);
  });
});

describe('AC-2: parseReportAcTable', () => {
  it('reads status and Evidence text per AC', () => {
    const table = parseReportAcTable(
      report([
        '| AC-1 | PASS | automated-test | foo.test.ts::bar |',
        '| AC-2 | FAIL | automated-test | boom |',
        '| AC-3 | UNVERIFIED | none | no evidence reported |',
      ]),
    );
    expect(table.get('AC-1')).toEqual({ status: 'PASS', reason: 'foo.test.ts::bar' });
    expect(table.get('AC-2')).toEqual({ status: 'FAIL', reason: 'boom' });
    expect(table.get('AC-3')).toEqual({ status: 'UNVERIFIED', reason: 'no evidence reported' });
  });

  it('tolerates backticks, bold, lowercase status and lowercase ids', () => {
    const table = parseReportAcTable(
      report(['| `AC-1` | **pass** | automated-test | `a.test.ts` |', '| **ac-2** | `Unverified` | none | nothing |']),
    );
    expect(table.get('AC-1')).toEqual({ status: 'PASS', reason: 'a.test.ts' });
    expect(table.get('AC-2')).toEqual({ status: 'UNVERIFIED', reason: 'nothing' });
  });

  it('reads suffixed ids and escaped pipes inside the evidence cell', () => {
    const table = parseReportAcTable(report(['| AC-7b | PASS | command | a \\| b |']));
    expect(table.get('AC-7b')).toEqual({ status: 'PASS', reason: 'a | b' });
  });

  it('skips the header and separator rows', () => {
    expect(parseReportAcTable(report([])).size).toBe(0);
  });

  it('reads an unrecognised status as UNVERIFIED, never as PASS', () => {
    const table = parseReportAcTable(report(['| AC-1 | MAYBE | x | y |']));
    expect(table.get('AC-1')?.status).toBe('UNVERIFIED');
  });

  it('keeps the worst status when an AC appears twice', () => {
    const table = parseReportAcTable(report(['| AC-1 | PASS | a | b |', '| AC-1 | FAIL | a | broke |']));
    expect(table.get('AC-1')?.status).toBe('FAIL');
  });
});

describe('summarizeAcs', () => {
  it('AC-3: an AC absent from the report counts UNVERIFIED with reason "tidak dilaporkan"', () => {
    const s = summarizeAcs('- AC-1: a\n- AC-2: b', report(['| AC-1 | PASS | t | e |']))!;
    expect(s.results).toEqual([
      { id: 'AC-1', status: 'PASS', reason: 'e' },
      { id: 'AC-2', status: 'UNVERIFIED', reason: 'tidak dilaporkan' },
    ]);
    expect(s).toMatchObject({ pass: 1, fail: 0, unverified: 1, allUnverified: false });
  });

  it('AC-4: an AC in the report but not in requirements.md is not counted', () => {
    const s = summarizeAcs('- AC-1: a', report(['| AC-1 | PASS | t | e |', '| AC-99 | FAIL | t | stray |']))!;
    expect(s.results.map((r) => r.id)).toEqual(['AC-1']);
    expect(s).toMatchObject({ pass: 1, fail: 0, unverified: 0 });
  });

  it('AC-5: no requirements text, or no AC line, gives no summary', () => {
    expect(summarizeAcs(undefined, report(['| AC-1 | PASS | t | e |']))).toBeUndefined();
    expect(summarizeAcs('# no acs here', report(['| AC-1 | PASS | t | e |']))).toBeUndefined();
  });

  it('flags allUnverified only when every AC is UNVERIFIED', () => {
    expect(summarizeAcs('- AC-1: a\n- AC-2: b', report(['| AC-1 | UNVERIFIED | none | n |']))!.allUnverified).toBe(true);
    expect(summarizeAcs('- AC-1: a\n- AC-2: b', report(['| AC-1 | PASS | t | e |']))!.allUnverified).toBe(false);
    expect(summarizeAcs('- AC-1: a', report(['| AC-1 | FAIL | t | e |']))!.allUnverified).toBe(false);
  });

  it('AC-10: picks up `Proposed Spec Changes:` under ### Notes', () => {
    const s = summarizeAcs('- AC-1: a', report(['| AC-1 | PASS | t | e |'], ['- Proposed Spec Changes: AC-1 should say 5s, not 3s']))!;
    expect(s.proposedSpecChanges).toBe('AC-1 should say 5s, not 3s');
  });

  it('AC-10: ignores the line outside ### Notes, and empty / "none" values', () => {
    const outside = `${report(['| AC-1 | PASS | t | e |'])}\n\nProposed Spec Changes: stray`;
    expect(summarizeAcs('- AC-1: a', outside)!.proposedSpecChanges).toBeUndefined();
    for (const none of ['none', 'None.', '-', 'tidak ada', '']) {
      const s = summarizeAcs('- AC-1: a', report(['| AC-1 | PASS | t | e |'], [`Proposed Spec Changes: ${none}`]))!;
      expect(s.proposedSpecChanges).toBeUndefined();
    }
  });
});

describe('renderAcSummary', () => {
  const summary = summarizeAcs(
    '- AC-1: a\n- AC-2: b\n- AC-3: c',
    report(['| AC-1 | PASS | t | e |', '| AC-2 | UNVERIFIED | none | no evidence reported |'], ['Proposed Spec Changes: tweak AC-1']),
  )!;

  it('AC-8: states PASS / FAIL / UNVERIFIED counts and lists UNVERIFIED with reasons', () => {
    const text = renderAcSummary(summary);
    expect(text).toContain('PASS: 1');
    expect(text).toContain('FAIL: 0');
    expect(text).toContain('UNVERIFIED: 2');
    expect(text).toContain('- AC-2: no evidence reported');
    expect(text).toContain('- AC-3: tidak dilaporkan');
    expect(text).not.toContain('- AC-1:');
  });

  it('AC-10: includes the Proposed Spec Changes line when present', () => {
    expect(renderAcSummary(summary)).toContain('Proposed Spec Changes: tweak AC-1');
  });

  it('AC-11: same input twice gives identical output', () => {
    const again = summarizeAcs(
      '- AC-1: a\n- AC-2: b\n- AC-3: c',
      report(['| AC-1 | PASS | t | e |', '| AC-2 | UNVERIFIED | none | no evidence reported |'], ['Proposed Spec Changes: tweak AC-1']),
    )!;
    expect(again).toEqual(summary);
    expect(renderAcSummary(again)).toBe(renderAcSummary(summary));
  });
});
