import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Layer rules for src/tui, mirroring the app's own domain / application /
 * infrastructure / presentation split. Imports may only point "inward":
 *
 *   domain          -> shared
 *   application     -> domain, shared
 *   infrastructure  -> domain, shared
 *   presentation    -> application, domain, shared   (never infrastructure)
 *   shared          -> (nothing in tui)
 *   index.ts        -> composition root, may import anything
 */
const SRC = resolve(__dirname, '../../src');
const TUI = join(SRC, 'tui');

const ALLOWED: Record<string, string[]> = {
  domain: ['domain', 'shared'],
  application: ['application', 'domain', 'shared'],
  infrastructure: ['infrastructure', 'domain', 'shared'],
  presentation: ['presentation', 'application', 'domain', 'shared'],
  shared: ['shared'],
};

/** Only these layers may touch these packages. */
const PACKAGE_OWNERS: Array<{ pattern: RegExp; layers: string[]; why: string }> = [
  { pattern: /^neo-blessed$/, layers: ['presentation'], why: 'terminal UI belongs to presentation' },
  { pattern: /^(ioredis|bullmq|better-sqlite3)$/, layers: ['infrastructure'], why: 'I/O clients belong to infrastructure' },
  { pattern: /^(node:)?child_process$/, layers: ['infrastructure'], why: 'spawning belongs to infrastructure' },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [full] : [];
  });
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf-8');
  return [...text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

const layerOf = (file: string): string => {
  const rel = relative(TUI, file).split(sep);
  return rel.length === 1 ? 'root' : rel[0];
};

describe('TUI layering', () => {
  const files = sourceFiles(TUI);

  it('finds the layers', () => {
    expect(new Set(files.map(layerOf))).toEqual(new Set(['root', 'domain', 'application', 'infrastructure', 'presentation', 'shared']));
  });

  for (const file of files) {
    const layer = layerOf(file);
    if (layer === 'root') continue;
    it(`${relative(TUI, file)} only imports allowed layers`, () => {
      for (const spec of importsOf(file)) {
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec.replace(/\.js$/, ''));
          // The one forbidden outside module: config/index.ts throws at import without a full env.
          expect(target, `${spec} pulls in config/index.ts`).not.toBe(join(SRC, 'config', 'index'));
          if (target.startsWith(TUI + sep)) {
            const targetLayer = relative(TUI, target).split(sep)[0];
            expect(ALLOWED[layer], `${layer} must not import ${targetLayer} (${spec})`).toContain(targetLayer);
          }
        } else {
          for (const rule of PACKAGE_OWNERS) {
            if (rule.pattern.test(spec)) expect(rule.layers, `${layer} must not import ${spec}: ${rule.why}`).toContain(layer);
          }
        }
      }
    });
  }
});
