import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { verifyLinearSignature, isLinearTimestampFresh } from '../../src/infrastructure/vcs/security.js';

const SECRET = 'test-webhook-secret';

async function loadFixtureRawBody(): Promise<Buffer> {
  const path = join(process.cwd(), 'tests/fixtures/linear-issue-update-ready-for-ai.json');
  return readFile(path);
}

function signBody(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

describe('verifyLinearSignature', () => {
  it('accepts a signature computed over the raw fixture body with the correct secret', async () => {
    const rawBody = await loadFixtureRawBody();
    const signature = signBody(rawBody, SECRET);

    expect(verifyLinearSignature(rawBody, signature, SECRET)).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const rawBody = await loadFixtureRawBody();
    const signature = signBody(rawBody, 'wrong-secret');

    expect(verifyLinearSignature(rawBody, signature, SECRET)).toBe(false);
  });

  it('rejects when the body has been tampered with after signing', async () => {
    const rawBody = await loadFixtureRawBody();
    const signature = signBody(rawBody, SECRET);

    const tamperedBody = Buffer.from(rawBody.toString('utf-8').replace('CAF-123', 'CAF-999'));

    expect(verifyLinearSignature(tamperedBody, signature, SECRET)).toBe(false);
  });

  it('rejects when the signature header is missing', async () => {
    const rawBody = await loadFixtureRawBody();

    expect(verifyLinearSignature(rawBody, undefined, SECRET)).toBe(false);
  });

  it('rejects a malformed (non-hex) signature header without throwing', async () => {
    const rawBody = await loadFixtureRawBody();

    expect(verifyLinearSignature(rawBody, 'not-a-valid-hex-signature!!', SECRET)).toBe(false);
  });

  it('rejects a signature of different length than expected (no timingSafeEqual crash)', async () => {
    const rawBody = await loadFixtureRawBody();

    expect(verifyLinearSignature(rawBody, 'ab', SECRET)).toBe(false);
  });
});

describe('isLinearTimestampFresh', () => {
  const TOLERANCE_MS = 60_000;

  it('accepts a timestamp exactly at now', () => {
    const now = 1_751_587_200_000;
    expect(isLinearTimestampFresh(String(now), TOLERANCE_MS, now)).toBe(true);
  });

  it('accepts a timestamp exactly at the tolerance boundary (60s old)', () => {
    const now = 1_751_587_200_000;
    const timestamp = now - TOLERANCE_MS;
    expect(isLinearTimestampFresh(String(timestamp), TOLERANCE_MS, now)).toBe(true);
  });

  it('rejects a timestamp 1ms past the tolerance boundary', () => {
    const now = 1_751_587_200_000;
    const timestamp = now - TOLERANCE_MS - 1;
    expect(isLinearTimestampFresh(String(timestamp), TOLERANCE_MS, now)).toBe(false);
  });

  it('rejects a timestamp far in the future (clock skew / spoofed replay)', () => {
    const now = 1_751_587_200_000;
    const timestamp = now + TOLERANCE_MS + 1;
    expect(isLinearTimestampFresh(String(timestamp), TOLERANCE_MS, now)).toBe(false);
  });

  it('rejects a missing timestamp header', () => {
    expect(isLinearTimestampFresh(undefined, TOLERANCE_MS)).toBe(false);
  });

  it('rejects a non-numeric timestamp header', () => {
    expect(isLinearTimestampFresh('not-a-number', TOLERANCE_MS)).toBe(false);
  });
});
