import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Linear signs the raw webhook body with HMAC-SHA256, hex-encoded, with no
 * prefix (unlike GitHub's `sha256=<hex>` format) — see linear-webhook-signature-research.md.
 */
export function verifyLinearSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) {
    return false;
  }

  let provided: Buffer;
  let expected: Buffer;
  try {
    provided = Buffer.from(signatureHeader, 'hex');
    expected = Buffer.from(
      createHmac('sha256', secret).update(rawBody).digest('hex'),
      'hex',
    );
  } catch {
    return false;
  }

  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}

/**
 * Reject deliveries whose Linear-Timestamp header is too old/skewed, to guard
 * against replay of a captured request. Linear recommends a 60s tolerance.
 */
export function isLinearTimestampFresh(
  timestampHeader: string | undefined,
  toleranceMs: number,
  now: number = Date.now(),
): boolean {
  if (!timestampHeader) {
    return false;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  return Math.abs(now - timestamp) <= toleranceMs;
}

/**
 * GitHub signs the raw webhook body with HMAC-SHA256, hex-encoded, prefixed
 * `sha256=` (unlike Linear's bare hex) — confirmed against real webhook
 * deliveries, see plan-checkpoint-b.md §1. Legacy `X-Hub-Signature` (`sha1=`)
 * is intentionally ignored; GitHub always also sends sha256 when a secret is
 * configured.
 */
export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) {
    return false;
  }

  let provided: Buffer;
  let expected: Buffer;
  try {
    provided = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');
    expected = Buffer.from(
      createHmac('sha256', secret).update(rawBody).digest('hex'),
      'hex',
    );
  } catch {
    return false;
  }

  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}

const BRANCH_PATTERN = /^[a-zA-Z0-9_\-\/\.:]+$/;

export function isSafeBranchName(branch: string): boolean {
  return BRANCH_PATTERN.test(branch);
}
