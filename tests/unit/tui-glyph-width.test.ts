import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * blessed counts every glyph as one cell, but terminals draw emoji-presentation
 * characters two cells wide. A single one in a row shifts the rest of the row
 * and leaves stray border fragments. Keep the TUI to single-width glyphs.
 */
const TUI_DIR = join(__dirname, '../../src/tui');
// Not all emoji-capable, but these are the ones that rendered double-width in terminals.
const KNOWN_WIDE = /[⏳⌛⚠⚡✋⏱‼✅❌❗❓⭐🚀]/u;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

describe('TUI glyph widths', () => {
  for (const file of sourceFiles(TUI_DIR)) {
    it(`${file.slice(TUI_DIR.length + 1)} uses no double-width glyphs`, () => {
      const text = readFileSync(file, 'utf-8');
      expect(text.match(/\p{Emoji_Presentation}/gu) ?? []).toEqual([]);
      expect(text.match(KNOWN_WIDE) ?? []).toEqual([]);
    });
  }
});
