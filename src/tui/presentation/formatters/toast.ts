import type { ToastTone } from '../../domain/models/toast.js';
import { C } from '../theme.js';

export const TOAST_COLOR: Record<ToastTone, string> = { ok: C.ok, warn: C.warn, bad: C.bad, info: C.info };
export const TOAST_ICON: Record<ToastTone, string> = { ok: '✔', warn: '!', bad: '✖', info: 'i' };
