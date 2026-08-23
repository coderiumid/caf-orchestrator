import { describe, it, expect } from 'vitest';
import { extractTicketPrefix } from '../../src/infrastructure/linear/ticket-prefix.js';

describe('extractTicketPrefix', () => {
  it('extracts the prefix from a well-formed identifier', () => {
    expect(extractTicketPrefix('GAN-43')).toBe('GAN');
    expect(extractTicketPrefix('CAF-123')).toBe('CAF');
    expect(extractTicketPrefix('A-1')).toBe('A');
  });

  it('returns undefined for an identifier with a trailing suffix after the digits', () => {
    expect(extractTicketPrefix('GAN-43-extra')).toBeUndefined();
    expect(extractTicketPrefix('GAN-43x')).toBeUndefined();
  });

  it('returns undefined for lowercase prefixes', () => {
    expect(extractTicketPrefix('gan-1')).toBeUndefined();
  });

  it('returns undefined when there is no dash/digits', () => {
    expect(extractTicketPrefix('GAN')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(extractTicketPrefix('')).toBeUndefined();
  });

  it('returns undefined for a purely numeric identifier', () => {
    expect(extractTicketPrefix('12345')).toBeUndefined();
  });
});
