/**
 * Detects a non-retryable API error (quota exhausted, model not found, ...) from a
 * `claude --output-format json` run so the pipeline can stop cleanly instead of
 * burning a BullMQ retry (see run-agent-pipeline.use-case.ts — full-retry v1 has
 * no step-resume, so retrying a config/quota error just repeats the same failure).
 */

export interface ApiErrorInfo {
  status: number | undefined;
  resetDelayMs: number | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number') return v;
  }
  return undefined;
}

/**
 * `--output-format json` stdout shape varies by CLI version — the status and
 * reset-delay hint can be top-level or nested under `error`/inside the `result`
 * field (itself sometimes a JSON string). Check every place we've seen it rather
 * than asserting one exact shape.
 */
export function parseApiError(stdout: string): ApiErrorInfo | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  const root = asRecord(parsed);
  if (!root) return undefined;

  const errorObj = asRecord(root['error']);

  let nested: Record<string, unknown> | undefined;
  const resultField = root['result'];
  if (typeof resultField === 'string') {
    try {
      nested = asRecord(JSON.parse(resultField));
    } catch {
      nested = undefined;
    }
  } else {
    nested = asRecord(resultField);
  }
  const nestedError = asRecord(nested?.['error']);

  const isError = root['is_error'] === true || nested?.['is_error'] === true;
  if (!isError) return undefined;

  const status = firstNumber(root['api_error_status'], errorObj?.['status'], nested?.['api_error_status'], nestedError?.['status']);

  const resetDelayMs = firstNumber(
    root['quotaResetDelay'],
    root['retryDelay'],
    errorObj?.['quotaResetDelay'],
    errorObj?.['retryDelay'],
    nested?.['quotaResetDelay'],
    nested?.['retryDelay'],
    nestedError?.['quotaResetDelay'],
    nestedError?.['retryDelay'],
  );

  return { status, resetDelayMs };
}

export function formatResetDelay(resetDelayMs: number | undefined): string {
  if (resetDelayMs === undefined) return 'reset time unknown';
  const minutes = Math.ceil(resetDelayMs / 60_000);
  return `~${minutes} minute(s)`;
}

/** Marker thrown after a non-retryable error has already been reported (postComment
 * + log) so the caller can catch it once and `return` without treating it as a
 * real failure requiring a BullMQ retry. */
export class NonRetryableApiError extends Error {
  constructor(
    public readonly agentName: string,
    public readonly status: number,
  ) {
    super(`${agentName} agent hit non-retryable API error (${status})`);
    this.name = 'NonRetryableApiError';
  }
}
