import { describe, expect, it } from 'vitest';
import { levelAtLeast } from '../../src/tui/domain/models/log-line.js';
import { LineSplitter, parseLogLine } from '../../src/tui/infrastructure/process/log-parser.js';

describe('parseLogLine', () => {
  it('parses a pino JSON line and keeps remaining bindings', () => {
    const line = parseLogLine('worker', '{"level":"warn","time":123,"pid":1,"hostname":"h","msg":"Job stalled","jobId":"7"}');
    expect(line).toMatchObject({ source: 'worker', level: 'warn', time: 123, message: 'Job stalled', fields: { jobId: '7' } });
  });

  it('maps numeric pino levels', () => {
    expect(parseLogLine('server', '{"level":50,"msg":"x"}').level).toBe('error');
  });

  it('falls back to raw text, stderr counting as error', () => {
    expect(parseLogLine('server', 'plain text', 5)).toMatchObject({ level: 'info', message: 'plain text', time: 5 });
    expect(parseLogLine('server', 'boom', 5, true).level).toBe('error');
  });

  it('treats broken JSON as raw text', () => {
    expect(parseLogLine('server', '{"level":').message).toBe('{"level":');
  });
});

describe('cloudflared lines', () => {
  it('reads level, time and message from the plain-text format', () => {
    const line = parseLogLine('tunnel', '2026-06-18T13:39:02Z INF Registered tunnel connection connIndex=0 location=sin01', 5, false);
    expect(line).toMatchObject({ source: 'tunnel', level: 'info', time: Date.parse('2026-06-18T13:39:02Z'), message: 'Registered tunnel connection connIndex=0 location=sin01' });
    expect(parseLogLine('tunnel', '2026-06-18T13:39:02Z ERR Unable to reach the origin service', 5).level).toBe('error');
    expect(parseLogLine('tunnel', '2026-06-18T13:39:02Z WRN something', 5).level).toBe('warn');
  });

  it('keeps unformatted lines at info unless flagged as stderr', () => {
    expect(parseLogLine('tunnel', 'Thank you for trying Cloudflare Tunnel', 5, false).level).toBe('info');
  });
});

describe('levelAtLeast', () => {
  it('orders levels', () => {
    expect(levelAtLeast('error', 'warn')).toBe(true);
    expect(levelAtLeast('info', 'warn')).toBe(false);
  });
});

describe('LineSplitter', () => {
  it('carries a partial trailing line across chunks', () => {
    const s = new LineSplitter();
    expect(s.push('a\nb')).toEqual(['a']);
    expect(s.push('c\n')).toEqual(['bc']);
    expect(s.push('tail')).toEqual([]);
    expect(s.flush()).toEqual(['tail']);
  });
});
