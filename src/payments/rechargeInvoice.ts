/**
 * GST tax invoice for a paid recharge, issued by Mahir Traders (the Razorpay account holder) to the shop.
 * The numbers are fixed in the database by app.issue_recharge_invoice when the payment is applied;
 * this job only draws the PDF (same template as shop bills), files it in the shop's folder and sends it.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '../db/tenantTx.js';
import type { DocumentDeps } from '../documents/invoiceJob.js';
import { pdfFilename } from '../documents/invoiceJob.js';
import { invoiceHtml, type InvoiceDoc } from '../documents/invoiceHtml.js';
import { formatInr } from '../domain/format.js';
import { enqueue } from '../queue/queue.js';

export interface RechargeInvoicePayload { kind: 'recharge_invoice_pdf'; tenant_id: string; invoice_id: string; notify_phone: string | null }

const n = (x: unknown) => Number(x);

export function rechargeInvoiceDoc(r: Record<string, any>): InvoiceDoc { // eslint-disable-line @typescript-eslint/no-explicit-any
  const iss = r.issuer ?? {};
  const buy = r.buyer ?? {};
  return {
    title: 'TAX INVOICE',
    number: r.number,
    date: r.doc_date,
    shop: {
      name: iss.legal_name + (iss.trade_name ? ` (${iss.trade_name})` : ''), address: iss.address, phone: iss.phone ? '+' + String(iss.phone).replace(/^\+/, '') : null,
      email: iss.email, gstin: iss.gstin, stateCode: iss.state_code, stateName: iss.state_name ?? ''
    },
    billTo: { name: buy.name, address: buy.address, phone: buy.phone ? '+' + buy.phone : null, gstin: buy.gstin },
    placeOfSupply: { code: r.place_of_supply, name: buy.state_name ?? '' },
    supply: r.supply_type,
    lines: [{
      name: r.description, hsn: r.sac, qty: '1', unit: 'pack', ratePaise: n(r.taxable_paise), discountPaise: 0,
      taxablePaise: n(r.taxable_paise), gstRate: n(r.gst_rate), gstPaise: n(r.cgst_paise) + n(r.sgst_paise) + n(r.igst_paise), totalPaise: n(r.total_paise)
    }],
    totals: { taxablePaise: n(r.taxable_paise), cgstPaise: n(r.cgst_paise), sgstPaise: n(r.sgst_paise), igstPaise: n(r.igst_paise), roundOffPaise: 0, totalPaise: n(r.total_paise) },
    terms: [
      `Paid in full online${r.provider_payment_id ? ` (payment ID ${r.provider_payment_id})` : ''}. Reverse charge: No.`,
      `${r.credits} credits added to ${buy.trade_name ?? buy.name}; credits are valid for 24 months and are not refundable or transferable.`,
      'Service: AutoCraft Shop Assistant (WhatsApp billing and stock software).'
    ]
  };
}

export async function processRechargeInvoicePdf(deps: DocumentDeps, p: RechargeInvoicePayload): Promise<'made' | 'already_done'> {
  const row = await withTenant(deps.pool, p.tenant_id, async (tx) => (await tx.query(
    `select r.*, to_char(r.invoice_date, 'YYYY-MM-DD') as doc_date, pay.provider_payment_id
       from recharge_invoices r left join payments pay on pay.id = r.payment_id where r.id = $1`, [p.invoice_id])).rows[0]);
  if (!row) throw new Error('recharge invoice not found');
  if (row.pdf_file_id) return 'already_done';
  const doc = rechargeInvoiceDoc(row);
  const pdf = await deps.renderer.render(await invoiceHtml(doc));
  const filename = pdfFilename(doc.number);
  const path = `${p.tenant_id}/recharge-invoices/${filename}`;
  await deps.fileStore.put(path, pdf, 'application/pdf');

  return withTenant(deps.pool, p.tenant_id, async (tx) => {
    const { rows: [file] } = await tx.query(
      `insert into files (tenant_id, kind, bucket, path, mime, size_bytes) values ($1, 'invoice_pdf', $2, $3, 'application/pdf', $4)
       on conflict (bucket, path) do update set size_bytes = excluded.size_bytes returning id`, [p.tenant_id, deps.fileStore.bucket, path, pdf.length]);
    const linked = await tx.query('update recharge_invoices set pdf_file_id = $2 where id = $1 and pdf_file_id is null', [p.invoice_id, file.id]);
    if (!linked.rowCount) return 'already_done' as const;
    if (p.notify_phone) {
      const out = { kind: 'document', to: p.notify_phone, fileId: file.id, filename,
        caption: `🧾 GST invoice ${doc.number} for your recharge: ₹${formatInr(doc.totals.totalPaise)} (incl. ₹${formatInr(doc.totals.cgstPaise + doc.totals.sgstPaise + doc.totals.igstPaise)} GST)` };
      const { rows: [m] } = await tx.query(
        `insert into messages (wa_message_id, tenant_id, direction, phone, msg_type, payload, status) values ($1, $2, 'out', $3, 'document', $4, 'pending') returning id`,
        ['pending:' + randomUUID(), p.tenant_id, p.notify_phone, JSON.stringify(out)]);
      await enqueue(tx, p.notify_phone, { outbound_id: m.id, tenant_id: p.tenant_id }, 'outbound');
    }
    return 'made' as const;
  });
}
