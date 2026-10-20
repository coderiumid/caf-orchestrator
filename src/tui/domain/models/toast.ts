export type ToastTone = 'ok' | 'warn' | 'bad' | 'info';

export interface ToastSpec {
  tone: ToastTone;
  text: string;
}
