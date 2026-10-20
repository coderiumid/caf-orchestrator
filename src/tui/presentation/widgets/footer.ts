import blessed from 'neo-blessed';
import { DEFAULT_HINTS, renderKeyHints } from '../formatters/footer.js';
import { escapeTags } from '../formatters/markup.js';
import { C, dim } from '../theme.js';

export interface Footer {
  /** Shows a one-off hint (button hover); `null` restores the key reference. */
  hint(text: string | null): void;
  /** Replaces the footer with a plain message (e.g. while quitting). */
  message(markup: string): void;
  /** Re-fits the key reference to the current terminal width. */
  refresh(): void;
}

export function createFooter(screen: blessed.Widgets.Screen): Footer {
  const box = blessed.box({ parent: screen, bottom: 0, left: 0, width: '100%', height: 1, tags: true, style: { bg: C.base, fg: C.text } });
  const keys = () => renderKeyHints(DEFAULT_HINTS, (screen.width as number) - 2);
  box.setContent(keys());
  return {
    hint(text) {
      box.setContent(text === null ? keys() : ` ${dim(escapeTags(text))}`);
      screen.render();
    },
    message(markup) {
      box.setContent(markup);
      screen.render();
    },
    refresh() {
      box.setContent(keys());
    },
  };
}
