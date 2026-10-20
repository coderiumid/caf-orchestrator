/**
 * One palette for the whole TUI. Surfaces are separated by three greys instead
 * of borders; colour is reserved for status (ok / warn / bad / info) plus one
 * accent for "what you are on". Hex values are reduced to the nearest of the
 * terminal's 256 colours by blessed.
 */
export const C = {
  base: '#0b0b0b',
  panel: '#151515',
  raised: '#0b0b0b',
  text: '#e4e4e4',
  dim: '#8c8c8c',
  faint: '#5a5a5a',
  accent: '#fab283',
  ok: '#7fd88f',
  warn: '#f5c26b',
  bad: '#ef6f6f',
  info: '#6fb7d8',
  purple: '#c79bf2',
} as const;

/** `{#hex-fg}text{/}`. */
export function fg(color: string, text: string): string {
  return `{${color}-fg}${text}{/}`;
}

export const dim = (text: string): string => fg(C.dim, text);
export const faint = (text: string): string => fg(C.faint, text);
export const bold = (text: string): string => `{bold}${text}{/bold}`;

/** Maps the colour names the application view-models use onto the palette. */
const NAMED: Record<string, string> = {
  green: C.ok,
  red: C.bad,
  yellow: C.warn,
  cyan: C.info,
  blue: C.info,
  magenta: C.purple,
  gray: C.dim,
  white: C.text,
};

export function themeColor(name: string): string {
  return NAMED[name] ?? name;
}
