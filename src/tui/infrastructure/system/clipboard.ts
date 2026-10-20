import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

type SpawnFn = (command: string, args: readonly string[], options: { stdio: ['pipe', 'ignore', 'ignore'] }) => ChildProcess;

/** Clipboard commands to try, in order, per platform. The text goes in on stdin, never on the command line. */
export function clipboardCommands(platform: NodeJS.Platform): Array<{ command: string; args: string[] }> {
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }];
  if (platform === 'win32') return [{ command: 'clip', args: [] }];
  return [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
  ];
}

function tryCommand(spawnFn: SpawnFn, command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
    child.stdin?.on('error', () => resolve(false));
    child.stdin?.end(text);
  });
}

/** Copies `text` to the system clipboard; false when no clipboard tool is available or it failed. */
export async function copyToClipboard(text: string, platform: NodeJS.Platform = process.platform, spawnFn: SpawnFn = nodeSpawn as unknown as SpawnFn): Promise<boolean> {
  for (const { command, args } of clipboardCommands(platform)) {
    if (await tryCommand(spawnFn, command, args, text)) return true;
  }
  return false;
}
