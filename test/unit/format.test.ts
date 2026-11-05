import { describe, expect, it } from 'vitest';
import { amountInWords, formatDocNumber, formatInr, fyOf, istDate } from '../../src/domain/format.js';

describe('formatInr', () => {
  it.each([
    [123456750, '12,34,567.50'],
    [100000, '1,000'],
    [99, '0.99'],
    [1000000000, '1,00,00,000'],
    [-150050, '-1,500.50']
  ])('%i → %s', (p, s) => expect(formatInr(p)).toBe(s));

  it('symbol and fixed decimals', () => {
    expect(formatInr(125000, { symbol: true, alwaysDecimals: true })).toBe('₹1,250.00');
  });
});

describe('amountInWords', () => {
  it.each([
    [0, 'Zero Rupees Only'],
    [125000, 'Rupees One Thousand Two Hundred Fifty Only'],
    [1234550, 'Rupees Twelve Thousand Three Hundred Forty Five and Fifty Paise Only'],
    [147600, 'Rupees One Thousand Four Hundred Seventy Six Only'],
    [1_00_00_000_00, 'Rupees One Crore Only'],
    [12_34_56_789_05, 'Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine and Five Paise Only'],
    [50, 'Rupees Zero and Fifty Paise Only']
  ])('%i', (p, words) => expect(amountInWords(p)).toBe(words));
});

describe('financial year', () => {
  it.each([
    ['2026-11-06', '2026-27'],
    ['2027-03-31', '2026-27'],
    ['2027-04-01', '2027-28'],
    ['2099-04-01', '2099-00']
  ])('%s → %s', (d, fy) => expect(fyOf(d)).toBe(fy));

  it('uses the India calendar date, not UTC', () => {
    // 31 Mar 2027, 20:00 UTC is already 1 Apr in India → new financial year
    expect(istDate(new Date('2027-03-31T20:00:00Z'))).toBe('2027-04-01');
    expect(fyOf(istDate(new Date('2027-03-31T20:00:00Z')))).toBe('2027-28');
  });
});

describe('formatDocNumber', () => {
  it('pads the serial and adds revisions', () => {
    expect(formatDocNumber('INV', '2026-27', 12)).toBe('INV/2026-27/0012');
    expect(formatDocNumber('QT', '2026-27', 12, 1)).toBe('QT/2026-27/0012-R1');
    expect(formatDocNumber('INV', '2026-27', 12345)).toBe('INV/2026-27/12345');
  });
});
