import { describe, expect, it } from 'vitest';
import {
  gstinCheckChar,
  isExpired,
  isValidGstin,
  isValidIfsc,
  isValidPan,
  panFromGstin,
  resolveBank,
} from '../src/index.js';

describe('GSTIN', () => {
  const first14 = '27AABCU9603R1Z';
  const valid = first14 + gstinCheckChar(first14);

  it('accepts a GSTIN with a correct checksum (case/space-insensitive)', () => {
    expect(isValidGstin(valid)).toBe(true);
    expect(isValidGstin(` ${valid.toLowerCase()} `)).toBe(true);
  });

  it('rejects a wrong checksum, bad shape or invalid state code', () => {
    const wrong = first14 + (valid.endsWith('A') ? 'B' : 'A');
    expect(isValidGstin(wrong)).toBe(false);
    expect(isValidGstin('27AABCU9603R1X5')).toBe(false);
    expect(isValidGstin('99AABCU9603R1Z' + gstinCheckChar('99AABCU9603R1Z'))).toBe(false);
  });

  it('extracts the embedded PAN', () => {
    expect(panFromGstin(valid)).toBe('AABCU9603R');
  });
});

describe('PAN / IFSC / bank', () => {
  it('validates PAN format', () => {
    expect(isValidPan('AABCU9603R')).toBe(true);
    expect(isValidPan('AABCU9603')).toBe(false);
  });

  it('resolves bank from IFSC prefix instead of fuzzy name matching', () => {
    expect(isValidIfsc('HDFC0001234')).toBe(true);
    expect(resolveBank('hdfc0001234')).toEqual({ code: 'HDFC', name: 'HDFC Bank' });
    expect(resolveBank('ZZZZ0001234')).toEqual({ code: 'ZZZZ', name: null });
    expect(resolveBank('HDFC1001234')).toBeNull(); // 5th char must be 0
  });
});

describe('expiry', () => {
  it('flags past dates only', () => {
    const today = new Date('2026-06-15T00:00:00Z');
    expect(isExpired('2026-06-14', today)).toBe(true);
    expect(isExpired('2026-06-15', today)).toBe(false);
    expect(isExpired(undefined, today)).toBe(false);
  });
});
