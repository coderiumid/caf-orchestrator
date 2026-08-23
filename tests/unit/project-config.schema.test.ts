import { describe, it, expect } from 'vitest';
import { projectsSchema } from '../../src/config/project-config.schema.js';

const validA = {
  ticketPrefix: 'GAN',
  repoCloneUrl: 'git@github.com:ganjardbc/umkm-pos.git',
  baseBranch: 'main',
  workspaceDir: '/tmp/caf-orchestrator/workspace/a',
  agents: { modelOverrides: {} },
};

const validB = {
  ticketPrefix: 'DUM',
  repoCloneUrl: 'https://example.com/org/dummy.git',
  baseBranch: 'main',
  workspaceDir: '/tmp/caf-orchestrator/workspace/b',
  agents: { modelOverrides: {} },
};

function issuePaths(result: ReturnType<typeof projectsSchema.safeParse>): string[] {
  if (result.success) return [];
  return result.error.issues.map((i) => i.path.join('.'));
}

function issueMessages(result: ReturnType<typeof projectsSchema.safeParse>): string[] {
  if (result.success) return [];
  return result.error.issues.map((i) => i.message);
}

describe('projectsSchema — valid input', () => {
  it('parses 2 valid dummy projects successfully', () => {
    const result = projectsSchema.safeParse({ 'project-a': validA, 'project-b': validB });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data['project-a'].ticketPrefix).toBe('GAN');
      expect(result.data['project-b'].ticketPrefix).toBe('DUM');
    }
  });

  it('parses an empty projects map successfully', () => {
    const result = projectsSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('projectsSchema — duplicate ticketPrefix', () => {
  it('rejects 2 projects sharing the same ticketPrefix, naming both', () => {
    const result = projectsSchema.safeParse({
      'project-a': validA,
      'project-b': { ...validB, ticketPrefix: 'GAN', workspaceDir: '/tmp/caf-orchestrator/workspace/other' },
    });
    expect(result.success).toBe(false);
    const messages = issueMessages(result);
    const dupIssue = messages.find((m) => m.includes('Duplicate ticketPrefix'));
    expect(dupIssue).toBeDefined();
    expect(dupIssue).toContain('project-a');
    expect(dupIssue).toContain('project-b');
    expect(dupIssue).toContain('GAN');
  });
});

describe('projectsSchema — empty required fields', () => {
  it('rejects a project with an empty repoCloneUrl, naming the project and field', () => {
    const result = projectsSchema.safeParse({
      'project-a': { ...validA, repoCloneUrl: '' },
    });
    expect(result.success).toBe(false);
    const paths = issuePaths(result);
    expect(paths).toContain('project-a.repoCloneUrl');
  });

  it('rejects a project with a missing ticketPrefix', () => {
    const { ticketPrefix, ...rest } = validA;
    const result = projectsSchema.safeParse({ 'project-a': rest });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('project-a.ticketPrefix');
  });

  it('rejects a project with a missing workspaceDir', () => {
    const { workspaceDir, ...rest } = validA;
    const result = projectsSchema.safeParse({ 'project-a': rest });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('project-a.workspaceDir');
  });

  it('rejects a project with a missing baseBranch', () => {
    const { baseBranch, ...rest } = validA;
    const result = projectsSchema.safeParse({ 'project-a': rest });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('project-a.baseBranch');
  });
});

describe('projectsSchema — identical/nested workspaceDir', () => {
  it('rejects 2 projects with identical workspaceDir', () => {
    const result = projectsSchema.safeParse({
      'project-a': validA,
      'project-b': { ...validB, ticketPrefix: 'DUM', workspaceDir: validA.workspaceDir },
    });
    expect(result.success).toBe(false);
    const messages = issueMessages(result);
    const identicalIssue = messages.find((m) => m.includes('identical workspaceDir'));
    expect(identicalIssue).toBeDefined();
    expect(identicalIssue).toContain('project-a');
    expect(identicalIssue).toContain('project-b');
  });

  it('rejects 2 projects where one workspaceDir is nested inside the other', () => {
    const result = projectsSchema.safeParse({
      'project-a': { ...validA, workspaceDir: '/tmp/caf-workspace/a' },
      'project-b': { ...validB, workspaceDir: '/tmp/caf-workspace/a/sub' },
    });
    expect(result.success).toBe(false);
    const messages = issueMessages(result);
    const nestedIssue = messages.find((m) => m.includes('nested inside'));
    expect(nestedIssue).toBeDefined();
    expect(nestedIssue).toContain('project-a');
    expect(nestedIssue).toContain('project-b');
  });

  it('rejects workspaceDir that is not an absolute path', () => {
    const result = projectsSchema.safeParse({
      'project-a': { ...validA, workspaceDir: 'relative/path' },
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('project-a.workspaceDir');
  });
});

describe('projectsSchema — ticketPrefix format', () => {
  it('rejects a lowercase ticketPrefix', () => {
    const result = projectsSchema.safeParse({ 'project-a': { ...validA, ticketPrefix: 'gan' } });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('project-a.ticketPrefix');
  });

  it('rejects a ticketPrefix containing a dash', () => {
    const result = projectsSchema.safeParse({ 'project-a': { ...validA, ticketPrefix: 'GAN-1' } });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('project-a.ticketPrefix');
  });

  it('rejects a ticketPrefix containing digits', () => {
    const result = projectsSchema.safeParse({ 'project-a': { ...validA, ticketPrefix: 'GAN1' } });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('project-a.ticketPrefix');
  });
});

describe('projectsSchema — combined errors, not stop-at-first', () => {
  it('collects a per-field error and a cross-project error together in one pass', () => {
    const result = projectsSchema.safeParse({
      'project-a': { ...validA, repoCloneUrl: '' },
      'project-b': { ...validB, ticketPrefix: 'GAN', workspaceDir: '/tmp/caf-orchestrator/workspace/other' },
    });
    expect(result.success).toBe(false);
    const messages = issueMessages(result);
    expect(issuePaths(result)).toContain('project-a.repoCloneUrl');
    expect(messages.some((m) => m.includes('Duplicate ticketPrefix'))).toBe(true);
  });
});
