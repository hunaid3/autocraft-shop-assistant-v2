import { describe, expect, it } from 'vitest';
import { fixedRules, SimpleParser } from '../../src/engine/parse.js';

const ctx = { today: '2026-11-06', catalog: [] };
const p = new SimpleParser();

describe('fixed rules', () => {
  it.each([
    ['yes', { type: 'confirm' }], ['Haan', { type: 'confirm' }], ['ok.', { type: 'confirm' }],
    ['no', { type: 'cancel' }], ['nahi', { type: 'cancel' }],
    ['help', { type: 'help' }], ['Hi', { type: 'greeting' }],
    ['credits', { type: 'query', report: 'credits' }],
    ['stock', { type: 'query', report: 'stock_all' }],
    ['low stock', { type: 'query', report: 'low_stock' }],
    ['sales today', { type: 'query', report: 'sales_period', period: 'today' }],
    ['sales this month', { type: 'query', report: 'sales_period', period: 'this_month' }],
    ['stock of airdopes 141', { type: 'query', report: 'item_stock', item: 'airdopes 141' }],
    ['bill', { type: 'how_to', about: 'invoice' }],
    ['purchase', { type: 'how_to', about: 'purchase' }]
  ])('%s', (text, intent) => expect(fixedRules(text)).toEqual(intent));

  it('leaves real entries to the reader', () => {
    expect(fixedRules('bill Ravi 10 airdopes at 1250')).toBeNull();
    expect(fixedRules('stock count airdopes 40')).toBeNull();
  });
});

describe('SimpleParser', () => {
  it('reads a bill with a customer and several lines', async () => {
    expect(await p.parse('bill Ravi Electronics 10 airdopes at 1250, 5 cables at 199', ctx)).toEqual({
      type: 'invoice', party: { name: 'Ravi Electronics' },
      lines: [
        { name: 'airdopes', qty: '10', unit: undefined, ratePaise: 125000, discountPaise: undefined },
        { name: 'cables', qty: '5', unit: undefined, ratePaise: 19900, discountPaise: undefined }
      ]
    });
  });

  it('keeps model numbers in item names, reads units, @, discounts and a GSTIN', async () => {
    const r = await p.parse('bill to Sharma gstin 27AABCU9603R1ZM 2 kg boAt Airdopes 141 @ 1,250.50 less 50', ctx);
    expect(r).toEqual({
      type: 'invoice', party: { name: 'Sharma', gstin: '27AABCU9603R1ZM' },
      lines: [{ name: 'boAt Airdopes 141', qty: '2', unit: 'kg', ratePaise: 125050, discountPaise: 5000 }]
    });
  });

  it('walk-in bill with no rate (uses the saved price)', async () => {
    const r = await p.parse('bill 3 cables', ctx);
    expect(r).toMatchObject({ type: 'invoice', party: {}, lines: [{ name: 'cables', qty: '3', ratePaise: undefined }] });
    expect(await p.parse('bill cash 3 cables', ctx)).toMatchObject({ party: {} });
  });

  it('reads a purchase with supplier and bill number', async () => {
    expect(await p.parse('bought 50 airdopes @ 850 from Sharma Traders bill 4471', ctx)).toEqual({
      type: 'purchase', party: { name: 'Sharma Traders' }, billNo: '4471',
      lines: [{ name: 'airdopes', qty: '50', unit: undefined, ratePaise: 85000, discountPaise: undefined }]
    });
  });

  it('reads an expense with mode and payee', async () => {
    expect(await p.parse('paid 3500 shop rent cash', ctx)).toEqual(
      { type: 'expense', amountPaise: 350000, category: 'Shop Rent', mode: 'cash', paidTo: undefined });
    expect(await p.parse('paid ₹1,200 electricity upi to TSSPDCL', ctx)).toMatchObject(
      { amountPaise: 120000, category: 'Electricity', mode: 'upi', paidTo: 'TSSPDCL' });
  });

  it('reads a stock count', async () => {
    expect(await p.parse('stock count airdopes 141 40, cable 25', ctx)).toEqual({
      type: 'stock_count', lines: [{ name: 'airdopes 141', qty: '40', unit: undefined }, { name: 'cable', qty: '25', unit: undefined }]
    });
  });

  it('asks for the format instead of guessing on a half-entry', async () => {
    expect(await p.parse('bill Ravi airdopes', ctx)).toEqual({ type: 'how_to', about: 'invoice' });
    expect(await p.parse('what is the weather', ctx)).toEqual({ type: 'unknown' });
  });
});

describe('stock that leaves without a bill', () => {
  const so = (reason: string, lines: unknown[], party?: string) => ({ type: 'stock_out', reason, lines, party });
  it.each([
    ['gave 2 airdopes sample to Ravi', so('sample_demo', [{ name: 'airdopes', qty: '2', unit: undefined }], 'Ravi')],
    ['gave 2 airdopes as sample to Ravi Electronics', so('sample_demo', [{ name: 'airdopes', qty: '2', unit: undefined }], 'Ravi Electronics')],
    ['3 cables damaged', so('damaged_lost', [{ name: 'cables', qty: '3', unit: undefined }])],
    ['sent 5 airdopes, 2 cables on approval to Ravi', so('on_approval', [{ name: 'airdopes', qty: '5', unit: undefined }, { name: 'cables', qty: '2', unit: undefined }], 'Ravi')],
    ['sold 1 cable without bill', so('cash_sale_no_bill', [{ name: 'cable', qty: '1', unit: undefined }])],
    ['stock out 10 pcs cable branch transfer', so('branch_transfer', [{ name: 'cable', qty: '10', unit: 'pcs' }])],
    ['transfer 10 cable to Abids branch', so('branch_transfer', [{ name: 'cable', qty: '10', unit: undefined }], 'Abids branch')],
    ['took 1 cable for shop use', so('internal_use', [{ name: 'cable', qty: '1', unit: undefined }])]
  ])('%s', async (text, intent) => expect(await p.parse(text, ctx)).toEqual(intent));

  it('asks why when no reason is given', async () => {
    const r = await p.parse('gave 2 airdopes to Ravi', ctx);
    expect(r.type).toBe('unknown');
    expect((r as { hint: string }).hint).toContain('Why did it go out?');
  });

  it('a normal sale is still an invoice', async () => {
    expect((await p.parse('sold Ravi 2 airdopes at 1250', ctx)).type).toBe('invoice');
  });

  it('returns', async () => {
    expect(await p.parse('returned 2 airdopes from Ravi', ctx)).toEqual({ type: 'stock_return', lines: [{ name: 'airdopes', qty: '2', unit: undefined }], party: 'Ravi' });
    expect(await p.parse('2 airdopes came back', ctx)).toEqual({ type: 'unknown' });
  });

  it('the list and the format', () => {
    expect(fixedRules('unbilled')).toEqual({ type: 'query', report: 'open_unbilled' });
    expect(fixedRules('stock out')).toEqual({ type: 'how_to', about: 'stock_out' });
  });
});
