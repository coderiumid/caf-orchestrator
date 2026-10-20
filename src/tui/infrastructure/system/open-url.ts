import { spawn } from 'node:child_process';

/** Opens a URL in the default browser, detached; failures are ignored. */
export function openUrl(url: string, platform: NodeJS.Platform = process.platform): void {
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}
