import blessed from 'neo-blessed';
import type { ToastTone } from '../../domain/models/toast.js';
import { pad } from '../../shared/format.js';
import { escapeTags } from '../formatters/markup.js';
import { TOAST_COLOR, TOAST_ICON } from '../formatters/toast.js';
import { bold, C, dim, fg } from '../theme.js';

type Screen = blessed.Widgets.Screen;
type Box = blessed.Widgets.BoxElement;

export interface DialogHooks {
  /** Called after an overlay or prompt closes, to put keyboard focus back where it belongs. */
  restoreFocus(): void;
  /** Called for every toast, so the UI can remember the last action. */
  onToast(message: string, tone: ToastTone): void;
}

export interface PaletteItem {
  label: string;
  /** Shortcut shown on the right, if the command has one. */
  keys?: string;
  run(): void;
}

export interface Dialogs {
  /** Scrollable raised surface in the middle of the screen; Esc / q close it. */
  overlay(label: string, content: string, height?: string | number): Box;
  /** Yes/cancel dialog: y or click YES runs onYes; n, Esc or click CANCEL closes. */
  confirm(message: string, onYes: () => void): void;
  /** One-line text prompt at the bottom; submit gets the trimmed text. */
  prompt(label: string, initial: string, onSubmit: (value: string) => void): void;
  /** Type-to-filter command list; Enter runs the highlighted command. */
  palette(items: readonly PaletteItem[]): void;
  /** Floating notification, bottom-right; newest wins. */
  toast(message: string, tone?: ToastTone): void;
  /** Hides the toast if there is one; returns whether there was. */
  dismissToast(): boolean;
  /** True while an overlay is open — global hotkeys stand down. */
  isOpen(): boolean;
}

export function createDialogs(screen: Screen, hooks: DialogHooks): Dialogs {
  let open = false;
  let toastBox: Box | null = null;
  let toastTimer: NodeJS.Timeout | null = null;
  const closers = new WeakMap<Box, () => void>();

  /** The raised surface with a bold title; `body` is where content goes and what takes focus. */
  function frame(label: string, content: string, height: string | number, width: string | number): { outer: Box; body: Box; close: () => void } {
    open = true;
    const outer = blessed.box({ parent: screen, top: 'center', left: 'center', width, height, tags: true, style: { bg: C.raised, fg: C.text } });
    blessed.box({ parent: outer, top: 1, left: 2, width: '100%-4', height: 1, tags: true, content: bold(escapeTags(label)), style: { bg: C.raised, fg: C.text } });
    const body = blessed.box({
      parent: outer,
      top: 3,
      left: 2,
      width: '100%-4',
      height: '100%-4',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      content,
      style: { bg: C.raised, fg: C.text },
    });
    body.focus();
    const close = () => {
      open = false;
      outer.destroy();
      hooks.restoreFocus();
      screen.render();
    };
    closers.set(body, close);
    body.key(['escape', 'q'], close);
    screen.render();
    return { outer, body, close };
  }

  function overlay(label: string, content: string, height: string | number = '80%'): Box {
    return frame(label, content, height, '80%').body;
  }

  function confirm(message: string, onYes: () => void): void {
    const { outer, body, close } = frame('Confirm', `${bold(escapeTags(message))}`, 9, '60%');
    const yes = blessed.button({ parent: outer, bottom: 1, left: 2, width: 12, height: 1, tags: true, mouse: true, align: 'center', content: bold('y  yes'), style: { bg: C.accent, fg: '#000000', hover: { bg: C.ok } } });
    const no = blessed.button({ parent: outer, bottom: 1, left: 16, width: 18, height: 1, tags: true, mouse: true, align: 'center', content: 'n / esc  cancel', style: { bg: C.base, fg: C.dim, hover: { bg: C.panel } } });
    const accept = () => {
      close();
      onYes();
    };
    yes.on('press', accept);
    no.on('press', close);
    body.key(['y'], accept);
    body.key(['n'], close);
  }

  function prompt(label: string, initial: string, onSubmit: (value: string) => void): void {
    if (open) return;
    const bar = blessed.box({ parent: screen, bottom: 1, left: 0, width: '100%', height: 3, tags: true, style: { bg: C.raised, fg: C.text } });
    blessed.box({ parent: bar, top: 1, left: 2, width: label.length + 2, height: 1, tags: true, content: fg(C.accent, `${escapeTags(label)} ›`), style: { bg: C.raised } });
    const input = blessed.textbox({ parent: bar, top: 1, left: label.length + 6, width: `100%-${label.length + 8}`, height: 1, inputOnFocus: true, value: initial, style: { bg: C.raised, fg: C.text } });
    const done = () => {
      bar.destroy();
      hooks.restoreFocus();
    };
    input.on('submit', (value: string) => {
      done();
      onSubmit((value ?? '').trim());
    });
    input.on('cancel', () => {
      done();
      screen.render();
    });
    input.focus();
    input.readInput();
    screen.render();
  }

  function palette(items: readonly PaletteItem[]): void {
    if (open) return;
    open = true;
    const width = 64;
    const height = Math.min(items.length + 6, Math.max(10, (screen.height as number) - 4));
    const outer = blessed.box({ parent: screen, top: 'center', left: 'center', width, height, tags: true, style: { bg: C.raised, fg: C.text } });
    blessed.box({ parent: outer, top: 1, left: 2, width: 20, height: 1, tags: true, content: bold('Commands'), style: { bg: C.raised } });
    blessed.box({ parent: outer, top: 1, right: 2, width: 12, height: 1, tags: true, align: 'right', content: dim('esc close'), style: { bg: C.raised } });
    blessed.box({ parent: outer, top: 3, left: 2, width: 2, height: 1, tags: true, content: fg(C.accent, '›'), style: { bg: C.raised } });
    const input = blessed.textbox({ parent: outer, top: 3, left: 4, width: width - 8, height: 1, inputOnFocus: true, style: { bg: C.raised, fg: C.text } });
    const rowWidth = width - 6;
    const list = blessed.list({
      parent: outer,
      top: 5,
      left: 2,
      width: width - 4,
      height: height - 6,
      keys: false,
      mouse: true,
      style: { bg: C.raised, fg: C.text, item: { bg: C.raised, fg: C.text }, selected: { bg: C.accent, fg: '#000000' } },
    });
    let shown: PaletteItem[] = [...items];
    const fill = () => {
      if (!open) return; // a keypress can land after the palette closed
      const needle = ((input as unknown as { getValue(): string }).getValue() ?? '').trim().toLowerCase();
      shown = items.filter((it) => !needle || it.label.toLowerCase().includes(needle));
      list.setItems(shown.length > 0 ? shown.map((it) => ` ${pad(it.label, rowWidth - 14)}${(it.keys ?? '').padStart(12)}`) : ['  no matching command']);
      list.select(0);
      screen.render();
    };
    const close = () => {
      open = false;
      outer.destroy();
      hooks.restoreFocus();
      screen.render();
    };
    const runSelected = () => {
      const it = shown[(list as unknown as { selected: number }).selected];
      close();
      it?.run();
    };
    input.key(['up'], () => {
      list.up(1);
      screen.render();
    });
    input.key(['down'], () => {
      list.down(1);
      screen.render();
    });
    input.on('keypress', () => setImmediate(fill));
    input.on('submit', runSelected);
    input.on('cancel', close);
    list.on('click', () => setImmediate(runSelected));
    fill();
    input.focus();
    input.readInput();
  }

  function toast(message: string, tone: ToastTone = 'info'): void {
    hooks.onToast(message, tone);
    toastBox?.destroy();
    if (toastTimer) clearTimeout(toastTimer);
    const color = TOAST_COLOR[tone];
    const bar = fg(color, '▌');
    toastBox = blessed.box({
      parent: screen,
      bottom: 2,
      right: 2,
      width: Math.min((screen.width as number) - 4, message.length + 10),
      height: 3,
      tags: true,
      content: `${bar}\n${bar} ${fg(color, TOAST_ICON[tone])}  ${escapeTags(message)} \n${bar}`,
      style: { bg: C.raised, fg: C.text },
    });
    toastBox.setFront();
    screen.render();
    const mine = toastBox;
    toastTimer = setTimeout(() => {
      mine.destroy();
      if (toastBox === mine) toastBox = null;
      screen.render();
    }, tone === 'bad' ? 6000 : 3500);
    toastTimer.unref?.();
  }

  function dismissToast(): boolean {
    if (!toastBox) return false;
    toastBox.destroy();
    toastBox = null;
    screen.render();
    return true;
  }

  return { overlay, confirm, prompt, palette, toast, dismissToast, isOpen: () => open };
}
