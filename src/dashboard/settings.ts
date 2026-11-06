/**
 * Shop settings from the dashboard (owner sessions). What the bill shows and how the shop works:
 * name, address, contact, UPI, bank details, logo, terms, invoice and quotation prefixes, GST
 * default, stock rules. The GSTIN and state are NOT editable here: they were confirmed at sign-up.
 *
 * Invoice prefix: at most 3 characters (Rule 46: the number stays within 16 characters), and it can
 * change only before the financial year's first invoice, so one year's bills form one series.
 * Every change is written to the audit log with the names of the fields changed.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withTenant, type Tx } from '../db/tenantTx.js';
import type { FileStore } from '../documents/fileStore.js';
import { normPhone } from '../engine/staff.js';

const opt = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();
const trimmed = (max: number) => z.string().transform((s) => s.replace(/\s+/g, ' ').trim()).pipe(z.string().max(max));
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

export const SettingsInput = z.object({
  name: trimmed(80).pipe(z.string().min(2, 'Shop name is too short')).optional(),
  legal_name: z.preprocess(blankToNull, opt(trimmed(120))),
  address: z.preprocess(blankToNull, opt(z.string().trim().max(300))),
  phone: z.preprocess(blankToNull, opt(z.string().transform((s, ctx) => normPhone(s) ?? (ctx.addIssue({ code: 'custom', message: 'Phone should be a 10-digit mobile number' }), z.NEVER)))),
  email: z.preprocess(blankToNull, opt(z.string().trim().toLowerCase().max(120).regex(/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/, 'That email address doesn\'t look right'))),
  upi_id: z.preprocess(blankToNull, opt(z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{2,256}@[a-z]{2,64}$/, 'A UPI ID looks like name@okaxis'))),
  bank_account_name: z.preprocess(blankToNull, opt(trimmed(80))),
  bank_name: z.preprocess(blankToNull, opt(trimmed(80))),
  bank_account_no: z.preprocess(blankToNull, opt(z.string().transform((s) => s.replace(/\s/g, '')).pipe(z.string().regex(/^\d{6,20}$/, 'Account number should be 6 to 20 digits')))),
  bank_ifsc: z.preprocess(blankToNull, opt(z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like HDFC0001234'))),
  invoice_terms: z.array(trimmed(200)).max(6, 'Up to 6 lines of terms').transform((a) => a.filter(Boolean)).optional(),
  invoice_prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,3}$/, 'Invoice prefix: 1 to 3 letters or digits (GST invoice numbers are limited to 16 characters)').optional(),
  quotation_prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,8}$/, 'Quotation prefix: 1 to 8 letters, digits or -').optional(),
  quotation_title: z.enum(['quotation', 'estimate']).optional(),
  quotation_validity_days: z.coerce.number().int().min(1).max(365).optional(),
  default_gst_rate: z.coerce.number().min(0).max(100).optional(),
  prices_include_gst: z.boolean().optional(),
  stock_shortfall: z.enum(['allow', 'block']).optional(),
  low_stock_default: z.coerce.number().min(0).max(1_000_000).optional()
}).strict();
export type SettingsInput = z.infer<typeof SettingsInput>;

const TENANT_COLS = ['name', 'legal_name', 'address', 'phone', 'email', 'upi_id'] as const;
const SETTINGS_COLS = ['bank_account_name', 'bank_name', 'bank_account_no', 'bank_ifsc', 'invoice_terms', 'invoice_prefix', 'quotation_prefix',
  'quotation_title', 'quotation_validity_days', 'default_gst_rate', 'prices_include_gst', 'stock_shortfall', 'low_stock_default'] as const;
const LOCKED = new Set(['gstin', 'state_code', 'state', 'gst', 'gst_number']);

export async function readSettings(tx: Tx, tenantId: string) {
  const { rows: [r] } = await tx.query(
    `select t.name, t.legal_name, t.gstin, t.state_code, g.name as state_name, t.address, t.phone, t.email, t.upi_id,
            (t.logo_file_id is not null) as has_logo,
            s.bank_account_name, s.bank_name, s.bank_account_no, s.bank_ifsc, s.invoice_terms, s.invoice_prefix, s.quotation_prefix,
            s.quotation_title, s.quotation_validity_days, s.default_gst_rate::float as default_gst_rate, s.prices_include_gst,
            s.stock_shortfall, s.low_stock_default::float as low_stock_default,
            exists (select 1 from invoices where fy = app.fy_of(app.today_ist())) as prefix_locked,
            app.fy_of(app.today_ist()) as fy
       from tenants t join tenant_settings s on s.tenant_id = t.id join gst_states g on g.code = t.state_code where t.id = $1`, [tenantId]);
  const rates = (await tx.query('select rate::float as r from gst_rates where active order by rate')).rows.map((x) => Number(x.r));
  return { ...r, gst_rates: rates };
}

export class SettingsError extends Error {}

/** Apply a change set. Returns the names of the fields that actually changed. */
export async function saveSettings(tx: Tx, tenantId: string, userId: string, body: unknown): Promise<string[]> {
  if (body && typeof body === 'object') {
    const locked = Object.keys(body).filter((k) => LOCKED.has(k));
    if (locked.length) throw new SettingsError('The GSTIN and state were confirmed at sign-up and can\'t be changed here. Send *support* on WhatsApp if they need to change.');
  }
  const parsed = SettingsInput.safeParse(body);
  if (!parsed.success) throw new SettingsError(parsed.error.issues[0]?.message ?? 'Please check the values');
  const input = parsed.data;
  const cur = await readSettings(tx, tenantId);

  const changed = (k: string) => k in input && JSON.stringify((input as Record<string, unknown>)[k] ?? null) !== JSON.stringify(cur[k] ?? null);
  const fields = [...TENANT_COLS, ...SETTINGS_COLS].filter(changed);
  if (!fields.length) return [];

  if (fields.includes('invoice_prefix') && cur.prefix_locked) {
    throw new SettingsError(`Bills for ${cur.fy} already use the prefix ${cur.invoice_prefix}. To keep one series per year, the prefix can change from 1 April (the next financial year).`);
  }
  if (fields.includes('default_gst_rate') && !cur.gst_rates.includes(Number(input.default_gst_rate))) {
    throw new SettingsError(`Default GST must be one of ${cur.gst_rates.join(', ')}%`);
  }
  if (fields.includes('bank_account_no') || fields.includes('bank_ifsc')) {
    const no = 'bank_account_no' in input ? input.bank_account_no : cur.bank_account_no;
    const ifsc = 'bank_ifsc' in input ? input.bank_ifsc : cur.bank_ifsc;
    if (Boolean(no) !== Boolean(ifsc)) throw new SettingsError('Bank details need both the account number and the IFSC (or leave both empty)');
  }

  const set = async (table: 'tenants' | 'tenant_settings', cols: readonly string[]) => {
    const mine = cols.filter((c) => fields.includes(c as (typeof fields)[number]));
    if (!mine.length) return;
    const vals = mine.map((c) => (input as Record<string, unknown>)[c] ?? null);
    const assign = mine.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await tx.query(`update ${table} set ${assign} where ${table === 'tenants' ? 'id' : 'tenant_id'} = $1`, [tenantId, ...vals]);
  };
  await set('tenants', TENANT_COLS);
  await set('tenant_settings', SETTINGS_COLS);
  await tx.query(
    "insert into audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id, detail) values ($1, 'user', $2, 'settings.update', 'tenant', $1, $3)",
    [tenantId, userId, JSON.stringify({ fields, via: 'dashboard' })]);
  return fields;
}

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export function logoType(bytes: Buffer): 'image/png' | 'image/jpeg' | null {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

export function registerSettings(app: FastifyInstance, deps: {
  pool: pg.Pool; fileStore?: FileStore;
  auth: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}): void {
  const { pool, auth } = deps;
  const inShop = <T>(req: FastifyRequest, work: (tx: Tx) => Promise<T>) => withTenant(pool, req.session!.tenantId, work);

  app.get('/api/settings', { preHandler: auth }, async (req) => inShop(req, (tx) => readSettings(tx, req.session!.tenantId)));

  app.put('/api/settings', { preHandler: auth }, async (req, reply) => {
    try {
      const fields = await inShop(req, (tx) => saveSettings(tx, req.session!.tenantId, req.session!.userId, req.body));
      return { ok: true, changed: fields };
    } catch (e) {
      if (e instanceof SettingsError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/settings/logo', { preHandler: auth }, async (req, reply) => {
    if (!deps.fileStore) return reply.code(404).send({ error: 'no logo' });
    const f = await inShop(req, async (tx) => (await tx.query('select f.path, f.mime from tenants t join files f on f.id = t.logo_file_id where t.id = $1', [req.session!.tenantId])).rows[0]);
    if (!f) return reply.code(404).send({ error: 'no logo' });
    return reply.header('content-type', f.mime).send(await deps.fileStore.get(f.path));
  });

  app.post('/api/settings/logo', { preHandler: auth, bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
    if (!deps.fileStore) return reply.code(503).send({ error: 'File storage is not available' });
    const data = (req.body as { data?: unknown } | null)?.data;
    if (typeof data !== 'string' || data.length > 2_900_000) return reply.code(400).send({ error: 'Please choose a PNG or JPG image under 2 MB' });
    const bytes = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
    const mime = logoType(bytes);
    if (!mime || bytes.length > LOGO_MAX_BYTES) return reply.code(400).send({ error: 'Please choose a PNG or JPG image under 2 MB' });
    const tenantId = req.session!.tenantId;
    const path = `${tenantId}/logo/dashboard-${Date.now()}.${mime === 'image/png' ? 'png' : 'jpg'}`;
    await deps.fileStore.put(path, bytes, mime);
    await inShop(req, async (tx) => {
      const { rows: [f] } = await tx.query(
        "insert into files (tenant_id, kind, path, mime, size_bytes, created_by) values ($1, 'logo', $2, $3, $4, $5) returning id",
        [tenantId, path, mime, bytes.length, req.session!.userId]);
      await tx.query('update tenants set logo_file_id = $2 where id = $1', [tenantId, f.id]);
      await tx.query(
        "insert into audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id, detail) values ($1, 'user', $2, 'settings.update', 'tenant', $1, $3)",
        [tenantId, req.session!.userId, JSON.stringify({ fields: ['logo'], via: 'dashboard' })]);
    });
    return { ok: true };
  });

  app.delete('/api/settings/logo', { preHandler: auth }, async (req) => {
    await inShop(req, async (tx) => {
      await tx.query('update tenants set logo_file_id = null where id = $1', [req.session!.tenantId]);
      await tx.query(
        "insert into audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id, detail) values ($1, 'user', $2, 'settings.update', 'tenant', $1, $3)",
        [req.session!.tenantId, req.session!.userId, JSON.stringify({ fields: ['logo_removed'], via: 'dashboard' })]);
    });
    return { ok: true };
  });
}
