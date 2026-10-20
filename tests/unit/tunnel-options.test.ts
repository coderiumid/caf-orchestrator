import { describe, expect, it } from 'vitest';
import { describeCommand, parseTunnelArgs, resolveTunnelOptions } from '../../src/tunnel/tunnel-options.js';

const resolve = (env: Record<string, string | undefined> = {}, argv: string[] = [], serverPort = 3030) => resolveTunnelOptions({ env, argv, serverPort });

describe('resolveTunnelOptions', () => {
  it('builds the documented command with defaults', () => {
    const r = resolve();
    expect(r.ok && describeCommand(r.options)).toBe('cloudflared tunnel run --url http://localhost:3030 ai-code-review');
    expect(r.ok && r.options.publicUrl).toBeNull();
    expect(r.ok && r.options.webhookUrls).toBeNull();
  });

  it('reads name, public url and target from env and derives webhook urls', () => {
    const r = resolve({ TUNNEL_NAME: 'my-tunnel', TUNNEL_URL: 'https://local.ganjardev.my.id/', TUNNEL_TARGET_URL: 'http://127.0.0.1:4000' });
    if (!r.ok) throw new Error(r.error);
    expect(r.options.args).toEqual(['tunnel', 'run', '--url', 'http://127.0.0.1:4000', 'my-tunnel']);
    expect(r.options.publicUrl).toBe('https://local.ganjardev.my.id');
    expect(r.options.webhookUrls).toEqual({
      linear: 'https://local.ganjardev.my.id/webhooks/linear',
      github: 'https://local.ganjardev.my.id/webhooks/github',
      health: 'https://local.ganjardev.my.id/health',
    });
  });

  it('lets flags override env, in both --k v and --k=v form', () => {
    const r = resolve({ TUNNEL_NAME: 'a', TUNNEL_URL: 'https://a.example.com' }, ['--name', 'b', '--url=https://b.example.com']);
    if (!r.ok) throw new Error(r.error);
    expect(r.options.name).toBe('b');
    expect(r.options.publicUrl).toBe('https://b.example.com');
  });

  it('honours CLOUDFLARED_BIN and the server port default', () => {
    const r = resolve({ CLOUDFLARED_BIN: '/opt/bin/cloudflared' }, [], 4321);
    if (!r.ok) throw new Error(r.error);
    expect(r.options.command).toBe('/opt/bin/cloudflared');
    expect(r.options.targetUrl).toBe('http://localhost:4321');
  });

  it.each([
    [{ TUNNEL_NAME: 'bad name; rm -rf /' }, 'TUNNEL_NAME'],
    [{ TUNNEL_NAME: '--url' }, 'TUNNEL_NAME'],
    [{ TUNNEL_URL: 'http://insecure.example.com' }, 'must use https'],
    [{ TUNNEL_URL: 'not a url' }, 'not a valid URL'],
    [{ TUNNEL_TARGET_URL: 'ftp://localhost' }, 'must use http'],
  ])('rejects %j', (env, message) => {
    const r = resolve(env);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(message);
  });

  it('rejects unknown or valueless flags', () => {
    expect(resolve({}, ['--bogus', 'x']).ok).toBe(false);
    expect(resolve({}, ['--name']).ok).toBe(false);
  });
});

describe('parseTunnelArgs', () => {
  it('takes the last occurrence', () => {
    expect(parseTunnelArgs(['--name', 'a', '--name=b']).flags.name).toBe('b');
  });
});
