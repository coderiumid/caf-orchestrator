import { describe, it, expect } from 'vitest';
import { envSchema, VALIDATOR_KEPT_ENV_KEYS, VALIDATOR_STRIPPED_ENV_KEYS } from '../../src/config/schema.js';

// CAF-SDD-04f AC-5: every envSchema key is explicitly classified for the validator child
// process — stripped or kept, exactly one. A new key without a class fails this test.

describe('validator env classification', () => {
  const stripped: readonly string[] = VALIDATOR_STRIPPED_ENV_KEYS;
  const kept: readonly string[] = VALIDATOR_KEPT_ENV_KEYS;

  it.each(Object.keys(envSchema.shape))('%s is in exactly one class', (key) => {
    const classes = Number(stripped.includes(key)) + Number(kept.includes(key));
    expect(classes, `${key} must be added to VALIDATOR_STRIPPED_ENV_KEYS or VALIDATOR_KEPT_ENV_KEYS`).toBe(1);
  });

  it('classifies no key that is not in envSchema', () => {
    const keys = Object.keys(envSchema.shape);
    for (const key of [...stripped, ...kept]) expect(keys).toContain(key);
  });
});
