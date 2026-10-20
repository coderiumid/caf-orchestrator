/** blessed tag markup helpers. */

/** Escapes `{` and `}` so user/log text can't be read as a tag. */
export function escapeTags(text: string): string {
  return text.replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}'));
}
