import { describe, expect, it } from 'vitest';
import { checkGstin, findGstin, gstinCheckChar } from '../../src/domain/gstin.js';

describe('GSTIN', () => {
  it('accepts a real-format GSTIN with the right check character', () => {
    const base = '36AABCU9603R1Z';
    const g = base + gstinCheckChar(base);
    expect(checkGstin(g.toLowerCase())).toEqual({ ok: true, gstin: g, stateCode: '36' });
    expect(checkGstin('27AAPFU0939F1ZV')).toMatchObject({ ok: true, stateCode: '27' });
  });
  it('catches a typo through the check character', () => {
    expect(checkGstin('27AAPFU0939F1ZW')).toMatchObject({ ok: false, reason: expect.stringContaining('last character') });
  });
  it('explains wrong length and shape', () => {
    expect(checkGstin('27AAPFU0939F1Z')).toMatchObject({ ok: false, reason: expect.stringContaining('15 characters') });
    expect(checkGstin('ABCDEFGHIJKLMNO')).toMatchObject({ ok: false });
  });
  it('finds a GSTIN in a sentence', () => {
    expect(findGstin('my gst number is 27aapfu0939f1zv please add')).toBe('27AAPFU0939F1ZV');
    expect(findGstin('no number here')).toBeUndefined();
  });
});
