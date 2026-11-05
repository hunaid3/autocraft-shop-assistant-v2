import { describe, expect, it } from 'vitest';
import { docTotals, gstRateBp, lineAmounts, supplyType, toPaise, toQtyMilli } from '../../src/domain/money.js';

describe('toPaise', () => {
  it.each([
    ['1,250.50', 125050],
    ['₹1250', 125000],
    ['Rs. 99', 9900],
    [1250.5, 125050],
    ['0.5', 50],
    ['12.345', 1235], // extra places round half-up
    ['12.344', 1234],
    ['-10', -1000]
  ])('%s → %i paise', (input, expected) => expect(toPaise(input)).toBe(expected));

  it.each(['', 'abc', '1.2.3', '₹', '12a'])('rejects %j', (bad) => expect(() => toPaise(bad)).toThrow(RangeError));

  it('never uses floats: 0.1 + 0.2 style values are exact', () => {
    expect(toPaise('0.10') + toPaise('0.20')).toBe(30);
  });
});

describe('quantities and rates', () => {
  it('reads qty to 3 places', () => {
    expect(toQtyMilli('2.5')).toBe(2500);
    expect(toQtyMilli(10)).toBe(10000);
    expect(toQtyMilli('0.125')).toBe(125);
  });
  it('reads GST rates as basis points', () => {
    expect(gstRateBp(18)).toBe(1800);
    expect(gstRateBp('0.25')).toBe(25);
    expect(gstRateBp(40)).toBe(4000);
  });
});

describe('lineAmounts', () => {
  it('GST on top (prices exclude GST)', () => {
    // bill Ravi Electronics 10 airdopes at 1250 @ 18%
    expect(lineAmounts({ qty: 10, ratePaise: 125000, gstRate: 18, pricesIncludeGst: false })).toEqual({
      grossPaise: 1250000, taxablePaise: 1250000, gstPaise: 225000, totalPaise: 1475000
    });
  });

  it('GST inside the price (prices include GST)', () => {
    expect(lineAmounts({ qty: 1, ratePaise: 11800, gstRate: 18, pricesIncludeGst: true })).toEqual({
      grossPaise: 11800, taxablePaise: 10000, gstPaise: 1800, totalPaise: 11800
    });
  });

  it('inclusive price always splits back to exactly the gross', () => {
    for (let rate = 1; rate <= 99999; rate += 997) {
      for (const g of [0, 5, 18, 40, 0.25, 3]) {
        const r = lineAmounts({ qty: 1, ratePaise: rate, gstRate: g, pricesIncludeGst: true });
        expect(r.taxablePaise + r.gstPaise).toBe(rate);
      }
    }
  });

  it('fractional quantity and discount', () => {
    // 2.5 kg at ₹199, ₹10 off, 5%
    const r = lineAmounts({ qty: '2.5', ratePaise: 19900, discountPaise: 1000, gstRate: 5, pricesIncludeGst: false });
    expect(r.grossPaise).toBe(48750);
    expect(r.gstPaise).toBe(2438); // 2437.5 rounds half-up
    expect(r.totalPaise).toBe(51188);
  });

  it('rejects zero quantity and over-sized discounts', () => {
    expect(() => lineAmounts({ qty: 0, ratePaise: 100, gstRate: 18, pricesIncludeGst: false })).toThrow();
    expect(() => lineAmounts({ qty: 1, ratePaise: 100, discountPaise: 101, gstRate: 18, pricesIncludeGst: false })).toThrow();
  });

  it('handles large invoices without overflow', () => {
    const r = lineAmounts({ qty: '100000', ratePaise: 99_999_99_00, gstRate: 18, pricesIncludeGst: false });
    expect(r.taxablePaise).toBe(999_999_900_000_00);
  });
});

describe('supply type and totals', () => {
  it('same state or walk-in is intra, otherwise inter', () => {
    expect(supplyType('36', '36')).toBe('intra');
    expect(supplyType('36', null)).toBe('intra');
    expect(supplyType('36', '27')).toBe('inter');
  });

  it('splits GST into CGST/SGST with the odd paisa on CGST', () => {
    const t = docTotals([{ taxablePaise: 1000000, gstPaise: 180001 }], 'intra', false);
    expect(t.cgstPaise).toBe(90001);
    expect(t.sgstPaise).toBe(90000);
    expect(t.igstPaise).toBe(0);
    expect(t.totalPaise).toBe(1180001);
  });

  it('IGST for inter-state', () => {
    const t = docTotals([{ taxablePaise: 1000000, gstPaise: 180000 }], 'inter');
    expect([t.cgstPaise, t.sgstPaise, t.igstPaise]).toEqual([0, 0, 180000]);
  });

  it('rounds the total to the rupee and records round-off within ±50 paise', () => {
    expect(docTotals([{ taxablePaise: 125000, gstPaise: 22550 }], 'intra')).toMatchObject({ totalPaise: 147600, roundOffPaise: 50 });
    expect(docTotals([{ taxablePaise: 125000, gstPaise: 22549 }], 'intra')).toMatchObject({ totalPaise: 147500, roundOffPaise: -49 });
  });

  it('total always equals the parts (same rule the database enforces)', () => {
    for (let g = 0; g < 500; g += 7) {
      const t = docTotals([{ taxablePaise: 99_99 + g, gstPaise: g * 3 }], g % 2 ? 'intra' : 'inter');
      expect(t.totalPaise).toBe(t.taxablePaise + t.cgstPaise + t.sgstPaise + t.igstPaise + t.roundOffPaise);
      expect(Math.abs(t.roundOffPaise)).toBeLessThanOrEqual(50);
    }
  });
});
