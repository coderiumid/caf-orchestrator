import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceAgentCatalog } from '../../src/infrastructure/agent/workspace-agent-catalog.js';

// CAF-SDD-04a: the IAgentCatalog adapter behind AC-1/AC-5 — an agent "exists"
// when `.claude/agents/<name>.md` is in the workspace checkout.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repoWith(agents: string[]): string {
  const repo = mkdtempSync(join(tmpdir(), 'caf-orchestrator-agent-catalog-'));
  dirs.push(repo);
  mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
  for (const name of agents) writeFileSync(join(repo, '.claude', 'agents', `${name}.md`), `# ${name}\n`);
  return repo;
}

describe('WorkspaceAgentCatalog', () => {
  const catalog = new WorkspaceAgentCatalog();

  it('returns true when .claude/agents/<name>.md exists', async () => {
    const repo = repoWith(['caf-validator', 'caf-documentation']);
    expect(await catalog.hasAgent(repo, 'caf-validator')).toBe(true);
    expect(await catalog.hasAgent(repo, 'caf-documentation')).toBe(true);
  });

  it('returns false when it does not', async () => {
    const repo = repoWith(['caf-qa']);
    expect(await catalog.hasAgent(repo, 'caf-validator')).toBe(false);
  });

  it('returns false when .claude/agents itself is missing', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'caf-orchestrator-agent-catalog-'));
    dirs.push(repo);
    expect(await catalog.hasAgent(repo, 'caf-documentation')).toBe(false);
  });

  it('returns false for a directory with the agent file name', async () => {
    const repo = repoWith([]);
    mkdirSync(join(repo, '.claude', 'agents', 'caf-validator.md'));
    expect(await catalog.hasAgent(repo, 'caf-validator')).toBe(false);
  });

  it('never resolves outside .claude/agents (path-like names are rejected)', async () => {
    const repo = repoWith([]);
    writeFileSync(join(repo, 'evil.md'), 'x');
    expect(await catalog.hasAgent(join(repo, '.claude', 'agents'), '../../evil')).toBe(false);
  });
});
