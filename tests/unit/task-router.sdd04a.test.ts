import { describe, it, expect } from 'vitest';
import { hasDocsTasks, routeTasks, parseSkipDirectives } from '../../src/infrastructure/agent/task-router.js';

// CAF-SDD-04a AC-9: a trailing `## Coverage` section (AC → task list) is never
// read as Frontend, Backend or Docs work.

const COVERAGE = [
  '',
  '## Coverage',
  '- AC-1 (Frontend Tasks) → T2, T4',
  '- AC-2 (Backend Tasks) → T3',
  '- AC-3 (Docs Tasks) → T6',
  '- QA: AC-4 → T5',
  '',
].join('\n');

const CASES: Record<string, string> = {
  'backend only': '# Tasks\n## Backend Tasks\n- do the API\n',
  'frontend + backend': '# Tasks\n## Frontend Tasks\n- do the UI\n\n## Backend Tasks\n- do the API\n',
  'empty docs section last': '# Tasks\n## Backend Tasks\n- do the API\n\n## Docs Tasks\n',
  '(none) backend + docs': '# Tasks\n## Frontend Tasks\n- do the UI\n\n## Backend Tasks\n(none)\n\n## Docs Tasks\n- update README\n',
  'no implementation section': '# Tasks\n## Tasks\n- T1 do it\n',
  'skip agents last': '# Tasks\n## Backend Tasks\n- do the API\n\n## Skip Agents\n- Reviewer: trivial\n',
};

describe('AC-9: task-router ignores a trailing ## Coverage section', () => {
  for (const [name, md] of Object.entries(CASES)) {
    it(`${name}: routing, docs and skip directives match the same tasks.md without Coverage`, () => {
      const withCoverage = md + COVERAGE;
      for (const strictEmptyCheck of [false, true]) {
        expect(routeTasks(withCoverage, { strictEmptyCheck })).toEqual(routeTasks(md, { strictEmptyCheck }));
      }
      expect(hasDocsTasks(withCoverage)).toBe(hasDocsTasks(md));
      expect(parseSkipDirectives(withCoverage)).toEqual(parseSkipDirectives(md));
    });
  }

  it('a Coverage section alone routes to nothing and has no docs tasks', () => {
    expect(routeTasks(`# Tasks${COVERAGE}`, { strictEmptyCheck: true })).toEqual([]);
    expect(routeTasks(`# Tasks${COVERAGE}`)).toEqual([]);
    expect(hasDocsTasks(`# Tasks${COVERAGE}`)).toBe(false);
  });
});
