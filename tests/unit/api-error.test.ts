import { describe, it, expect } from 'vitest';
import { parseApiError, formatResetDelay, NonRetryableApiError } from '../../src/infrastructure/agent/api-error.js';

describe('parseApiError', () => {
  it('returns undefined when stdout is not valid JSON', () => {
    expect(parseApiError('planner stdout: analyzed ticket, about to write tasks.md')).toBeUndefined();
  });

  it('returns undefined when JSON is valid but is_error is false', () => {
    expect(parseApiError(JSON.stringify({ is_error: false, result: 'ok' }))).toBeUndefined();
  });

  it('detects a top-level 429 with quotaResetDelay', () => {
    const stdout = JSON.stringify({ is_error: true, api_error_status: 429, quotaResetDelay: 120_000 });
    expect(parseApiError(stdout)).toEqual({ status: 429, resetDelayMs: 120_000 });
  });

  it('detects a 429 nested under error.status with error.retryDelay', () => {
    const stdout = JSON.stringify({
      is_error: true,
      error: { status: 429, retryDelay: 30_000 },
    });
    expect(parseApiError(stdout)).toEqual({ status: 429, resetDelayMs: 30_000 });
  });

  it('detects a 429 nested inside a JSON-string `result` field', () => {
    const stdout = JSON.stringify({
      is_error: true,
      result: JSON.stringify({ is_error: true, api_error_status: 429, quotaResetDelay: 60_000 }),
    });
    expect(parseApiError(stdout)).toEqual({ status: 429, resetDelayMs: 60_000 });
  });

  it('reports resetDelayMs as undefined when the JSON has no reset hint', () => {
    const stdout = JSON.stringify({ is_error: true, api_error_status: 429 });
    expect(parseApiError(stdout)).toEqual({ status: 429, resetDelayMs: undefined });
  });

  it('detects a 404 model-not-found error', () => {
    const stdout = JSON.stringify({ is_error: true, api_error_status: 404 });
    expect(parseApiError(stdout)).toEqual({ status: 404, resetDelayMs: undefined });
  });

  it('detects a 404 nested under error.status', () => {
    const stdout = JSON.stringify({
      is_error: true,
      error: { status: 404, message: 'model not found' },
    });
    expect(parseApiError(stdout)).toEqual({ status: 404, resetDelayMs: undefined });
  });

  it('reports an unrecognized status (e.g. 500) so callers can decide how to handle it', () => {
    const stdout = JSON.stringify({ is_error: true, api_error_status: 500 });
    expect(parseApiError(stdout)).toEqual({ status: 500, resetDelayMs: undefined });
  });
});

describe('formatResetDelay', () => {
  it('formats a millisecond delay as rounded-up minutes', () => {
    expect(formatResetDelay(90_000)).toBe('~2 minute(s)');
  });

  it('falls back to an explicit unknown message', () => {
    expect(formatResetDelay(undefined)).toBe('reset time unknown');
  });
});

describe('NonRetryableApiError', () => {
  it('carries agentName and status', () => {
    const err = new NonRetryableApiError('qa', 429);
    expect(err.agentName).toBe('qa');
    expect(err.status).toBe(429);
    expect(err.message).toContain('qa');
    expect(err.message).toContain('429');
  });
});
