import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProjectRegistry } from '../../src/config/project-registry.js';

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

describe('ProjectRegistry.fromRawProjects', () => {
  it('loads 2 valid dummy projects, getByPrefix returns the right config', () => {
    const registry = ProjectRegistry.fromRawProjects({ 'project-a': validA, 'project-b': validB });

    expect(registry.getByPrefix('GAN')?.repoCloneUrl).toBe(validA.repoCloneUrl);
    expect(registry.getByPrefix('DUM')?.repoCloneUrl).toBe(validB.repoCloneUrl);
    expect(registry.getAll()).toHaveLength(2);
  });

  it('getByPrefix returns undefined for an unknown prefix, does not throw', () => {
    const registry = ProjectRegistry.fromRawProjects({ 'project-a': validA });
    expect(registry.getByPrefix('NOPE')).toBeUndefined();
  });

  it('getAll returns an empty array for an empty/undefined projects map', () => {
    expect(ProjectRegistry.fromRawProjects({}).getAll()).toEqual([]);
    expect(ProjectRegistry.fromRawProjects(undefined).getAll()).toEqual([]);
  });

  it('throws with both project names when ticketPrefix is duplicated', () => {
    let error: unknown;
    try {
      ProjectRegistry.fromRawProjects({
        'project-a': validA,
        'project-b': { ...validB, ticketPrefix: 'GAN' },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('project-a');
    expect(message).toContain('project-b');
    expect(message).toContain('Duplicate ticketPrefix');
  });

  it('throws naming the project and field when a required field is empty', () => {
    let error: unknown;
    try {
      ProjectRegistry.fromRawProjects({ 'project-a': { ...validA, repoCloneUrl: '' } });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('project-a.repoCloneUrl');
  });

  it('throws when 2 projects have identical workspaceDir', () => {
    let error: unknown;
    try {
      ProjectRegistry.fromRawProjects({
        'project-a': validA,
        'project-b': { ...validB, workspaceDir: validA.workspaceDir },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('identical workspaceDir');
  });

  it('throws when one workspaceDir is nested inside another', () => {
    let error: unknown;
    try {
      ProjectRegistry.fromRawProjects({
        'project-a': { ...validA, workspaceDir: '/tmp/caf-workspace/a' },
        'project-b': { ...validB, workspaceDir: '/tmp/caf-workspace/a/sub' },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('nested inside');
  });

  it('throws when ticketPrefix is lowercase or contains a dash', () => {
    expect(() => ProjectRegistry.fromRawProjects({ 'project-a': { ...validA, ticketPrefix: 'gan' } })).toThrow(
      /ticketPrefix/,
    );
    expect(() => ProjectRegistry.fromRawProjects({ 'project-a': { ...validA, ticketPrefix: 'GAN-1' } })).toThrow(
      /ticketPrefix/,
    );
  });
});

describe('ProjectRegistry.load', () => {
  it('throws a clear error for a missing file (reuses readYamlConfig)', () => {
    const missingPath = join(tmpdir(), 'caf-orchestrator-registry-does-not-exist', 'caf.config.yaml');
    expect(() => ProjectRegistry.load(missingPath)).toThrow(/Config file not found at/);
  });

  it('throws when the file has no projects: key at all (would silently never trigger the pipeline)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caf-orchestrator-registry-test-'));
    const filePath = join(dir, 'caf.config.yaml');
    writeFileSync(filePath, 'server:\n  port: 4000\n');

    try {
      expect(() => ProjectRegistry.load(filePath)).toThrow(/at least one project must be configured/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a valid projects: section from a real YAML file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caf-orchestrator-registry-test-'));
    const filePath = join(dir, 'caf.config.yaml');
    writeFileSync(
      filePath,
      [
        'projects:',
        '  test-project:',
        '    ticketPrefix: TST',
        '    repoCloneUrl: https://example.com/org/repo.git',
        '    baseBranch: main',
        '    workspaceDir: /tmp/caf-orchestrator/workspace/test-project',
        '',
      ].join('\n'),
    );

    try {
      const registry = ProjectRegistry.load(filePath);
      expect(registry.getByPrefix('TST')?.repoCloneUrl).toBe('https://example.com/org/repo.git');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('regression: the real caf.config.yaml loads clean and includes umkm-pos', () => {
    const realConfigPath = resolve(process.cwd(), 'caf.config.yaml');

    const registry = ProjectRegistry.load(realConfigPath);
    const umkmPos = registry.getByPrefix('GAN');

    expect(umkmPos).toBeDefined();
    expect(umkmPos?.repoCloneUrl).toBe('git@github.com:ganjardbc/umkm-pos.git');
    expect(umkmPos?.baseBranch).toBe('main');
  });
});
