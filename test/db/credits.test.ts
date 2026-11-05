import { afterAll, describe, expect, it } from 'vitest';
import { INSUFFICIENT_CREDITS, withTenant } from '../../src/db/tenantTx.js';
import { admin, engine, expectSqlError, newShop } from './helpers.js';

afterAll(async () => { await engine.end(); await admin.end(); });

const debit = (t: string, amount: number, action = 'invoice') =>
  withTenant(engine, t, async (tx) => (await tx.query('select app.credits_debit_checked($1, $2, $3) as b', [t, amount, action])).rows[0].b as number);

async function balance(t: string): Promise<number> {
  return (await admin.query('select balance from credit_wallets where tenant_id = $1', [t])).rows[0].balance;
}

/** The three invariants documented in the credits migration. */
async function assertInvariants(t: string): Promise<void> {
  const { rows } = await admin.query(`
    select w.balance,
      (select coalesce(sum(delta), 0)::int from credit_ledger where tenant_id = w.tenant_id) as ledger_sum,
      (select coalesce(sum(credits_remaining), 0)::int from credit_lots where tenant_id = w.tenant_id and expires_at > now()) as lots_sum,
      (select coalesce(sum(credits_remaining), 0)::int from credit_lots where tenant_id = w.tenant_id and expires_at <= now()) as expired_left
    from credit_wallets w where w.tenant_id = $1`, [t]);
  const r = rows[0];
  expect(r.ledger_sum).toBe(r.balance);
  expect(r.lots_sum).toBe(Math.max(r.balance, 0));
  expect(r.expired_left).toBe(0);
}

/** Admin-only: move a lot's expiry (the guard forbids this to apps). */
async function backdateLot(lotId: string, interval: string) {
  const c = await admin.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.purge', 'on', true)");
    await c.query(`update credit_lots set expires_at = now() + $2::interval where id = $1`, [lotId, interval]);
    await c.query('commit');
  } finally { c.release(); }
}

describe('credits', () => {
  it('a new shop starts with 100 credits expiring in 12 months', async () => {
    const { tenantId } = await newShop();
    expect(await balance(tenantId)).toBe(100);
    const { rows } = await admin.query(
      "select source, credits_remaining, (expires_at - created_at) > interval '364 days' as year from credit_lots where tenant_id = $1", [tenantId]);
    expect(rows).toEqual([{ source: 'signup_bonus', credits_remaining: 100, year: true }]);
    await assertInvariants(tenantId);
  });

  it('prices come from the table', async () => {
    const { rows } = await admin.query(
      "select app.credit_cost('invoice') inv, app.credit_cost('bulk_import', 248) bulk, app.credit_cost('bulk_import', 10) ten, app.credit_cost('query') q");
    expect(rows[0]).toEqual({ inv: 3, bulk: 25, ten: 1, q: 0 });
  });

  it('debits and refuses when the balance is too low, leaving nothing changed', async () => {
    const { tenantId: t } = await newShop();
    expect(await debit(t, 3)).toBe(97);
    expect(await debit(t, 97)).toBe(0);
    await expectSqlError(debit(t, 1), INSUFFICIENT_CREDITS);
    expect(await balance(t)).toBe(0);
    await assertInvariants(t);
  });

  it('a failed action costs nothing: the debit rolls back with the document', async () => {
    const { tenantId: t } = await newShop();
    await expect(withTenant(engine, t, async (tx) => {
      await tx.query("select app.credits_debit_checked($1, 3, 'invoice')", [t]);
      throw new Error('WhatsApp send failed before commit');
    })).rejects.toThrow();
    expect(await balance(t)).toBe(100);
  });

  it('spends the lot that expires first', async () => {
    const { tenantId: t } = await newShop();
    // A later-expiring lot bought now, and the signup lot moved to expire sooner
    await admin.query("select app.credits_grant($1, 300, 'top_up')", [t]);
    const signup = (await admin.query("select id from credit_lots where tenant_id = $1 and source = 'signup_bonus'", [t])).rows[0].id;
    await backdateLot(signup, '10 days');
    await debit(t, 110);
    const { rows } = await admin.query('select source, credits_remaining from credit_lots where tenant_id = $1 order by expires_at', [t]);
    expect(rows).toEqual([{ source: 'signup_bonus', credits_remaining: 0 }, { source: 'top_up', credits_remaining: 290 }]);
    await assertInvariants(t);
  });

  it('expired credits drop off, and are never spent', async () => {
    const { tenantId: t } = await newShop();
    await debit(t, 40);
    const lot = (await admin.query('select id from credit_lots where tenant_id = $1', [t])).rows[0].id;
    await backdateLot(lot, '-1 minute');
    await expectSqlError(debit(t, 1), INSUFFICIENT_CREDITS);
    // the failed debit rolled back its expiry too; the nightly job makes it stick
    expect(await admin.query('select app.credits_expire() as n').then((r) => r.rows[0].n)).toBeGreaterThanOrEqual(60);
    expect(await balance(t)).toBe(0);
    const kinds = (await admin.query('select kind, delta from credit_ledger where tenant_id = $1 order by id', [t])).rows;
    expect(kinds).toEqual([{ kind: 'signup_bonus', delta: 100 }, { kind: 'debit', delta: -40 }, { kind: 'expiry', delta: -60 }]);
    await assertInvariants(t);
  });

  it('grace balance lets a bill finish, and the next recharge settles it', async () => {
    const { tenantId: t } = await newShop();
    await withTenant(engine, t, (tx) => tx.query('update tenant_settings set credit_grace = 10 where tenant_id = $1', [t]));
    await debit(t, 99);
    expect(await debit(t, 3)).toBe(-2);
    await expectSqlError(debit(t, 9), INSUFFICIENT_CREDITS); // would be -11
    await assertInvariants(t);
    await admin.query("select app.credits_grant($1, 300, 'top_up')", [t]);
    expect(await balance(t)).toBe(298);
    await assertInvariants(t);
  });

  it('40 bills at once on 100 credits: exactly 33 succeed, balance 1', async () => {
    const { tenantId: t } = await newShop();
    const results = await Promise.allSettled(Array.from({ length: 40 }, () => debit(t, 3)));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(33);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failures.every((f) => f.reason.code === INSUFFICIENT_CREDITS)).toBe(true);
    expect(await balance(t)).toBe(1);
    await assertInvariants(t);
  });

  it("the engine can't touch another shop's wallet or mint credits", async () => {
    const A = (await newShop()).tenantId;
    const B = (await newShop()).tenantId;
    await expectSqlError(withTenant(engine, A, (tx) => tx.query("select app.credits_debit_checked($1, 3, 'invoice')", [B])), '42501');
    await expectSqlError(withTenant(engine, A, (tx) => tx.query("select app.credits_grant($1, 1000, 'top_up')", [A])), '42501');
    await expectSqlError(withTenant(engine, A, (tx) => tx.query('update credit_wallets set balance = 99999')), '42501');
    await expectSqlError(withTenant(engine, A, (tx) =>
      tx.query("insert into credit_ledger (tenant_id, delta, kind, balance_after) values ($1, 500, 'admin_adjust', 600)", [A])), '42501');
    expect(await balance(B)).toBe(100);
  });

  it('a Razorpay webhook delivered twice credits once', async () => {
    const { tenantId: t } = await newShop();
    await withTenant(engine, t, (tx) => tx.query(
      "insert into payments (tenant_id, pack_code, amount_paise, credits, provider_link_id) values ($1, 'regular', 99900, 1100, $2)",
      [t, 'plink_' + t.slice(0, 8)]));
    const apply = () => engine.query("select app.apply_payment($1, $2) as c", ['plink_' + t.slice(0, 8), 'pay_' + t.slice(0, 8)]);
    const both = await Promise.all([apply(), apply()]);
    expect(both.map((r) => r.rows[0].c).sort()).toEqual([0, 1100]);
    expect(await balance(t)).toBe(1200);
    await assertInvariants(t);
  });
});
