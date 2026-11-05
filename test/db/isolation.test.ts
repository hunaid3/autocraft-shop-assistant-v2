import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/db/tenantTx.js';
import { admin, asDashboard, engine, expectSqlError, newItem, newShop } from './helpers.js';

let A: Awaited<ReturnType<typeof newShop>>;
let B: Awaited<ReturnType<typeof newShop>>;
let itemA: string;
let itemB: string;

beforeAll(async () => {
  A = await newShop('Shop A');
  B = await newShop('Shop B');
  itemA = await newItem(A.tenantId, 'Airdopes 141');
  itemB = await newItem(B.tenantId, 'Secret item of B');
});
afterAll(async () => { await engine.end(); await admin.end(); });

describe('schema coverage', () => {
  it('every table in public has row-level security on', async () => {
    const { rows } = await admin.query(`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relkind = 'r' and not c.relrowsecurity`);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('every app function pins its search_path (Supabase advisor 0011)', async () => {
    const { rows } = await admin.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'app'
      where not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    expect(rows.map((r) => r.proname)).toEqual([]);
  });

  it('reference tables are readable by apps but not writable', async () => {
    const { rows } = await engine.query('select count(*)::int n from gst_rates');
    expect(rows[0].n).toBeGreaterThan(0);
    await expectSqlError(engine.query("update credit_prices set credits = 0 where action_code = 'invoice'"), '42501');
  });

  it('anon can read nothing at all', async () => {
    const c = await admin.connect();
    try {
      await c.query('begin; set local role anon');
      await expectSqlError(c.query('select * from items'), '42501');
    } finally { await c.query('rollback'); c.release(); }
  });
});

describe('core engine (app_engine)', () => {
  it('sees only the shop in its context', async () => {
    const names = await withTenant(engine, A.tenantId, async (tx) => (await tx.query('select name from items')).rows.map((r) => r.name));
    expect(names).toEqual(['Airdopes 141']);
  });

  it('sees nothing when no shop is set', async () => {
    const { rows } = await engine.query('select count(*)::int as n from items');
    expect(rows[0].n).toBe(0);
  });

  it('cannot read another shop by id', async () => {
    const { rows } = await withTenant(engine, A.tenantId, (tx) => tx.query('select * from items where id = $1', [itemB]));
    expect(rows).toHaveLength(0);
  });

  it('cannot write a row into another shop', async () => {
    await expectSqlError(
      withTenant(engine, A.tenantId, (tx) => tx.query("insert into items (tenant_id, name, gst_rate) values ($1, 'x', 18)", [B.tenantId])),
      '42501');
  });

  it("cannot point at another shop's item, even with its real id (composite FK)", async () => {
    await expectSqlError(
      withTenant(engine, A.tenantId, (tx) =>
        tx.query("insert into stock_ledger (tenant_id, item_id, qty_in, movement_type) values ($1, $2, 5, 'opening')", [A.tenantId, itemB])),
      '23503');
  });

  it("cannot update another shop's rows", async () => {
    const r = await withTenant(engine, A.tenantId, (tx) => tx.query("update items set name = 'hacked' where id = $1", [itemB]));
    expect(r.rowCount).toBe(0);
  });

  it('has no DELETE privilege on business tables', async () => {
    await expectSqlError(withTenant(engine, A.tenantId, (tx) => tx.query('delete from items where id = $1', [itemA])), '42501');
  });

  it('only sees members of its own shop', async () => {
    const { rows } = await withTenant(engine, A.tenantId, (tx) => tx.query('select phone from users'));
    expect(rows.map((r) => r.phone)).toEqual([A.ownerPhone]);
  });

  it('the shop context does not leak across pooled connections', async () => {
    await withTenant(engine, A.tenantId, (tx) => tx.query('select 1'));
    // reuse the pool without context — must see nothing
    const counts = await Promise.all(Array.from({ length: 20 }, () => engine.query('select count(*)::int as n from items')));
    expect(counts.every((c) => c.rows[0].n === 0)).toBe(true);
  });

  it('resolves a sender to their shop and role', async () => {
    const { rows } = await engine.query('select tenant_id, role from app.resolve_sender($1)', [A.ownerPhone]);
    expect(rows).toEqual([{ tenant_id: A.tenantId, role: 'owner' }]);
  });
});

describe('dashboard (authenticated + JWT)', () => {
  it('reads its own shop only', async () => {
    const names = await asDashboard(A.tenantId, async (c) => (await c.query('select name from items')).rows.map((r) => r.name));
    expect(names).toEqual(['Airdopes 141']);
  });

  it('cannot pick another shop by setting the engine variable', async () => {
    const names = await asDashboard(A.tenantId, async (c) => {
      await c.query("select set_config('app.tenant_id', $1, true)", [B.tenantId]);
      return (await c.query('select name from items')).rows.map((r) => r.name);
    });
    expect(names).toEqual(['Airdopes 141']);
  });

  it('a JWT without tenant_id sees nothing', async () => {
    const n = await asDashboard(null, async (c) => (await c.query('select count(*)::int as n from items')).rows[0].n);
    expect(n).toBe(0);
  });

  it('is read-only', async () => {
    await asDashboard(A.tenantId, (c) => expectSqlError(c.query("update items set name = 'x'"), '42501'));
    await asDashboard(A.tenantId, (c) => expectSqlError(c.query("insert into expenses (tenant_id, expense_date, category, amount_paise) values ($1, current_date, 'x', 100)", [A.tenantId]), '42501'));
  });

  it('cannot read drafts, login links or messages', async () => {
    for (const t of ['drafts', 'dashboard_links', 'messages']) {
      await asDashboard(A.tenantId, (c) => expectSqlError(c.query(`select * from ${t}`), '42501'));
    }
  });

  it('cannot call engine-only functions', async () => {
    await asDashboard(A.tenantId, (c) => expectSqlError(c.query("select app.provision_tenant('919999999999','x','x','36')"), '42501'));
    await asDashboard(A.tenantId, (c) => expectSqlError(c.query('select * from app.resolve_sender($1)', [A.ownerPhone]), '42501'));
  });
});
