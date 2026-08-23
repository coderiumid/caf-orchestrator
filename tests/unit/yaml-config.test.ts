import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readYamlConfig } from '../../src/config/yaml-config.js';

describe('readYamlConfig', () => {
  it('throws a clear, actionable error when the file does not exist', () => {
    const missingPath = join(tmpdir(), 'caf-orchestrator-does-not-exist', 'caf.config.yaml');
    expect(() => readYamlConfig(missingPath)).toThrow(/Config file not found at/);
    expect(() => readYamlConfig(missingPath)).toThrow(/caf.config.example.yaml/);
  });

  it('throws a clear error when the file contains invalid YAML syntax', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caf-orchestrator-yaml-test-'));
    const filePath = join(dir, 'caf.config.yaml');
    writeFileSync(filePath, 'server:\n  port: [unterminated\n');

    try {
      expect(() => readYamlConfig(filePath)).toThrow(/Failed to parse .* as YAML/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses valid YAML into a plain object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caf-orchestrator-yaml-test-'));
    const filePath = join(dir, 'caf.config.yaml');
    writeFileSync(filePath, 'server:\n  port: 4000\n');

    try {
      const parsed = readYamlConfig(filePath);
      expect(parsed).toEqual({ server: { port: 4000 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty object for an empty file rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caf-orchestrator-yaml-test-'));
    const filePath = join(dir, 'caf.config.yaml');
    writeFileSync(filePath, '');

    try {
      expect(readYamlConfig(filePath)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
