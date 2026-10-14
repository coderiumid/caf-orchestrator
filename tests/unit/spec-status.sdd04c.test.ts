import { describe, it, expect } from 'vitest';
import {
  parseSpecStatus,
  findUnansweredBlockingQuestions,
  setSpecStatusApproved,
  selectClarifyAnswers,
  CLARIFY_COMMENT_MARKER,
} from '../../src/infrastructure/reports/spec-status.js';

// CAF-SDD-04c: pure reader of the planner's result (AC-2, AC-4, AC-7, AC-14, AC-15, AC-18).

const spec = (status: string, questions: string[] = []) =>
  ['# Spec', `Status: ${status}`, 'Source: chat', '', '## Open Questions', ...questions, '', '## Acceptance Criteria', '- AC-1: x'].join('\n');

describe('parseSpecStatus', () => {
  it.each(['DRAFT', 'NEEDS_CLARIFICATION', 'APPROVED', 'NEEDS_HUMAN'])('reads %s', (status) => {
    expect(parseSpecStatus(spec(status))).toBe(status);
  });

  it('reads a status followed by trailing text', () => {
    expect(parseSpecStatus('Status: APPROVED (keputusan Ganjar)')).toBe('APPROVED');
  });

  it('AC-18: no anchored Status: line means undefined', () => {
    expect(parseSpecStatus('# Spec\nthe Status: DRAFT is mentioned mid-line\n')).toBeUndefined();
    expect(parseSpecStatus('  - Status: DRAFT')).toBeUndefined();
    expect(parseSpecStatus('')).toBeUndefined();
  });

  it('an unknown status word is not a status', () => {
    expect(parseSpecStatus('Status: PENDING')).toBeUndefined();
  });
});

describe('findUnansweredBlockingQuestions', () => {
  it('AC-4: lists BLOCKING questions with an empty Answer and skips answered ones', () => {
    const text = spec('NEEDS_CLARIFICATION', [
      '- Q-1 [BLOCKING] Which db? — Answer:',
      '- Q-2 [BLOCKING] Which auth? — Answer: OAuth',
      '- Q-3 [NON-BLOCKING] Colour? — Answer:',
      '- Q-4 [BLOCKING] No answer marker at all',
    ]);
    const open = findUnansweredBlockingQuestions(text);
    expect(open.map((q) => q.id)).toEqual(['Q-1', 'Q-4']);
    expect(open[0].text).toContain('Which db?');
  });

  it('counts an answer continued on the following indented line', () => {
    const text = spec('DRAFT', ['- Q-1 [BLOCKING] Which db? — Answer:', '  Postgres, because of JSONB']);
    expect(findUnansweredBlockingQuestions(text)).toEqual([]);
  });

  it('returns nothing for a spec without questions', () => {
    expect(findUnansweredBlockingQuestions(spec('DRAFT'))).toEqual([]);
  });
});

describe('setSpecStatusApproved', () => {
  it('AC-11: changes only the Status: line', () => {
    const before = spec('DRAFT', ['- Q-1 [NON-BLOCKING] x — Answer: y']);
    const result = setSpecStatusApproved(before)!;
    expect(result.changed).toBe(true);
    const a = before.split('\n');
    const b = result.text.split('\n');
    expect(b.length).toBe(a.length);
    const diff = a.map((line, i) => [line, b[i]]).filter(([x, y]) => x !== y);
    expect(diff).toEqual([['Status: DRAFT', 'Status: APPROVED']]);
  });

  it('AC-15: already APPROVED is unchanged', () => {
    const before = spec('APPROVED');
    expect(setSpecStatusApproved(before)).toEqual({ text: before, changed: false });
  });

  it('returns undefined without a Status: line', () => {
    expect(setSpecStatusApproved('# nothing')).toBeUndefined();
  });
});

describe('selectClarifyAnswers', () => {
  const c = (id: string, body: string, authorIsBot = false) => ({ id, body, authorIsBot });

  it('AC-7: keeps only human comments after the last Clarify comment', () => {
    const answers = selectClarifyAnswers([
      c('1', 'old chatter'),
      c('2', `${CLARIFY_COMMENT_MARKER}\nfirst round`),
      c('3', 'answer to first round'),
      c('4', `${CLARIFY_COMMENT_MARKER}\nsecond round`),
      c('5', 'bot noise', true),
      c('6', 'real answer'),
      c('7', 'another answer'),
    ]);
    expect(answers.map((a) => a.id)).toEqual(['6', '7']);
  });

  it('without a Clarify comment, all human comments count', () => {
    expect(selectClarifyAnswers([c('1', 'a'), c('2', 'b', true), c('3', 'c')]).map((a) => a.id)).toEqual(['1', '3']);
  });
});
