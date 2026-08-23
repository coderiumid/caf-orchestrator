import { describe, it, expect } from 'vitest';
import { hasDocsTasks, routeTasks, parseSkipDirectives } from '../../src/infrastructure/agent/task-router.js';

describe('routeTasks', () => {
  it('routes to both caf-frontend and caf-backend when both section headers are present', () => {
    const md = '# Tasks\n## Frontend Tasks\n- do the UI\n\n## Backend Tasks\n- do the API\n';
    expect(routeTasks(md)).toEqual(['caf-frontend', 'caf-backend']);
  });

  it('routes to only caf-backend when only the Backend Tasks header is present', () => {
    const md = '# Tasks\n## Backend Tasks\n- do the API\n';
    expect(routeTasks(md)).toEqual(['caf-backend']);
  });

  it('returns an empty array when neither section header is present', () => {
    const md = '# Tasks\n## Docs Tasks\n(none)\n';
    expect(routeTasks(md)).toEqual([]);
  });

  describe('default behavior (strictEmptyCheck off) — pre-existing, unchanged', () => {
    it('routes to caf-backend even when the Backend Tasks body is "(none)" (header presence only)', () => {
      const md = '# Tasks\n## Frontend Tasks\n- do the UI\n\n## Backend Tasks\n(none)\n';
      expect(routeTasks(md)).toEqual(['caf-frontend', 'caf-backend']);
    });

    it('routes to caf-backend even when the Backend Tasks body is empty (header presence only)', () => {
      const md = '# Tasks\n## Frontend Tasks\n- do the UI\n\n## Backend Tasks\n\n';
      expect(routeTasks(md)).toEqual(['caf-frontend', 'caf-backend']);
    });
  });

  describe('strictEmptyCheck: true (only active behind AGENT_SKIP_ENABLED)', () => {
    it('does not route to caf-backend when its body is "(none)"', () => {
      const md = '# Tasks\n## Frontend Tasks\n- do the UI\n\n## Backend Tasks\n(none)\n';
      expect(routeTasks(md, { strictEmptyCheck: true })).toEqual(['caf-frontend']);
    });

    it('does not route to caf-backend when its body is empty/whitespace-only', () => {
      const md = '# Tasks\n## Frontend Tasks\n- do the UI\n\n## Backend Tasks\n   \n\n';
      expect(routeTasks(md, { strictEmptyCheck: true })).toEqual(['caf-frontend']);
    });

    it('still routes to caf-backend when its body has real content', () => {
      const md = '# Tasks\n## Frontend Tasks\n(none)\n\n## Backend Tasks\n- do the API\n';
      expect(routeTasks(md, { strictEmptyCheck: true })).toEqual(['caf-backend']);
    });
  });
});

describe('parseSkipDirectives', () => {
  it('returns an empty map when there is no Skip Agents section', () => {
    const md = '# Tasks\n## Backend Tasks\n- do the thing\n';
    expect(parseSkipDirectives(md)).toEqual(new Map());
  });

  it('parses a well-formed skip line for a recognized agent', () => {
    const md = '# Tasks\n## Skip Agents\n- QA: config-only change, nothing to test\n\n## Backend Tasks\n- do the thing\n';
    expect(parseSkipDirectives(md)).toEqual(new Map([['qa', 'config-only change, nothing to test']]));
  });

  it('parses multiple skip lines for different recognized agents', () => {
    const md = [
      '# Tasks',
      '## Skip Agents',
      '- QA: no behavior change',
      '- Reviewer: trivial fix',
      '- Documentation: covered elsewhere',
      '',
      '## Backend Tasks',
      '- do the thing',
    ].join('\n');
    const result = parseSkipDirectives(md);
    expect(result.get('qa')).toBe('no behavior change');
    expect(result.get('reviewer')).toBe('trivial fix');
    expect(result.get('documentation')).toBe('covered elsewhere');
    expect(result.size).toBe(3);
  });

  it('is case-insensitive on the agent name', () => {
    const md = '# Tasks\n## Skip Agents\n- caf-backend: not needed for this ticket\n';
    expect(parseSkipDirectives(md)).toEqual(new Map([['caf-backend', 'not needed for this ticket']]));
  });

  it('ignores an unrecognized agent name (fail-safe: no entry, not an error)', () => {
    const md = '# Tasks\n## Skip Agents\n- Planner: does not make sense to skip\n- QA: valid one\n';
    const result = parseSkipDirectives(md);
    expect(result.has('planner' as never)).toBe(false);
    expect(result.get('qa')).toBe('valid one');
  });

  it('ignores a line with no reason after the colon (fail-safe: no entry)', () => {
    const md = '# Tasks\n## Skip Agents\n- QA:\n';
    expect(parseSkipDirectives(md)).toEqual(new Map());
  });

  it('ignores malformed lines that do not match "- <Agent>: <reason>" (fail-safe: no entry)', () => {
    const md = '# Tasks\n## Skip Agents\nQA is not relevant here, no dash or colon shape\n';
    expect(parseSkipDirectives(md)).toEqual(new Map());
  });

  it('returns an empty map when the Skip Agents section is present but empty', () => {
    const md = '# Tasks\n## Skip Agents\n\n## Backend Tasks\n- do the thing\n';
    expect(parseSkipDirectives(md)).toEqual(new Map());
  });
});

describe('hasDocsTasks', () => {
  it('returns true when Docs Tasks section has real content', () => {
    const md = '# Tasks\n## Docs Tasks\n- DOC-1: update api-contract.md\n\n## Backend Tasks\n- do the thing\n';
    expect(hasDocsTasks(md)).toBe(true);
  });

  it('returns false when Docs Tasks section says (none)', () => {
    const md = '# Tasks\n## Docs Tasks\n(none)\n\n## Backend Tasks\n- do the thing\n';
    expect(hasDocsTasks(md)).toBe(false);
  });

  it('returns false when Docs Tasks section is absent', () => {
    const md = '# Tasks\n## Backend Tasks\n- do the thing\n';
    expect(hasDocsTasks(md)).toBe(false);
  });

  it('returns false when Docs Tasks section is whitespace-only', () => {
    const md = '# Tasks\n## Docs Tasks\n   \n\n## Backend Tasks\n- do the thing\n';
    expect(hasDocsTasks(md)).toBe(false);
  });
});
