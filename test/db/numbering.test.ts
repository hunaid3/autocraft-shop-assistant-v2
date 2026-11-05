import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/db/tenantTx.js';
import { admin, engine, newShop } from './helpers.js';

let A: string;
let B: string;
beforeAll(async () => { A = (await newShop('Num A')).tenantId; B = (await newShop('Num B')).tenantId; });
afterAll(async () => { await engine.end(); await admin.end(); });

const next = (tenant: string, fy = '2026-27', type = 'invoice') =>
  withTenant(engine, tenant, async (tx) => (await tx.query('select app.next_doc_serial($1, $2, $3) as s', [tenant, type, fy])).rows[0].s as number);

describe('document numbering', () => {
  it('counts per shop, per type, per financial year', async () => {
    expect(await next(A)).toBe(1);
    expect(await next(A)).toBe(2);
    expect(await next(B)).toBe(1);
    expect(await next(A, '2026-27', 'quotation')).toBe(1);
    expect(await next(A, '2027-28')).toBe(1);
    expect(await next(A)).toBe(3);
  });

  it('a rolled-back bill gives its number back (no gaps)', async () => {
    const t = (await newShop('Rollback')).tenantId;
    await next(t);
    await expect(withTenant(engine, t, async (tx) => {
      await tx.query("select app.next_doc_serial($1, 'invoice', '2026-27')", [t]);
      throw new Error('PDF render failed');
    })).rejects.toThrow('PDF render failed');
    expect(await next(t)).toBe(2);
  });

  it('50 bills at the same moment get 1..50 exactly once', async () => {
    const t = (await newShop('Rush hour')).tenantId;
    const serials = await Promise.all(Array.from({ length: 50 }, () => next(t)));
    expect([...serials].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('SQL and TypeScript agree on the financial year', async () => {
    const { rows } = await admin.query(`select app.fy_of('2026-11-06') a, app.fy_of('2027-03-31') b, app.fy_of('2027-04-01') c`);
    expect(rows[0]).toEqual({ a: '2026-27', b: '2026-27', c: '2027-28' });
  });
});
