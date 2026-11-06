/**
 * The 'documents' job: saved invoice → PDF → shop's folder → linked to the invoice → queued to send.
 * Runs after Confirm has committed, so a slow or failed render never holds up or undoes a bill.
 * Safe to run twice: once the invoice has its PDF, the job does nothing.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTenant, type Tx } from '../db/tenantTx.js';
import { formatInr } from '../domain/format.js';
import { enqueue } from '../queue/queue.js';
import type { FileStore } from './fileStore.js';
import { invoiceHtml, type InvoiceDoc } from './invoiceHtml.js';
import type { PdfRenderer } from './pdf.js';

export interface DocumentDeps { pool: pg.Pool; renderer: PdfRenderer; fileStore: FileStore }
export interface InvoicePdfPayload { kind: 'invoice_pdf'; tenant_id: string; invoice_id: string; notify_phone: string | null }

export const pdfFilename = (number: string) => number.replace(/[/\\]/g, '-') + '.pdf';

export async function loadInvoiceDoc(tx: Tx, invoiceId: string, fileStore: FileStore): Promise<{ doc: InvoiceDoc; pdfFileId: string | null; userId: string | null }> {
  const { rows: [inv] } = await tx.query(
    `select i.*, ps.name as pos_name from invoices i join gst_states ps on ps.code = i.place_of_supply where i.id = $1`, [invoiceId]);
  if (!inv) throw new Error('invoice not found in this shop');
  const { rows: lines } = await tx.query('select * from invoice_lines where invoice_id = $1 order by line_no', [invoiceId]);
  const { rows: [shop] } = await tx.query(
    `select t.*, st.name as state_name, s.bank_account_name, s.bank_name, s.bank_account_no, s.bank_ifsc, s.invoice_terms,
            f.path as logo_path, f.mime as logo_mime
       from tenants t join tenant_settings s on s.tenant_id = t.id join gst_states st on st.code = t.state_code
       left join files f on f.id = t.logo_file_id
      where t.id = $1`, [inv.tenant_id]);

  let logoDataUri: string | null = null;
  if (shop.logo_path) {
    try { logoDataUri = `data:${shop.logo_mime};base64,` + (await fileStore.get(shop.logo_path)).toString('base64'); } catch { logoDataUri = null; }
  }
  const p = (x: unknown) => Number(x);
  const billTo = inv.bill_to ?? {};
  return {
    pdfFileId: inv.pdf_file_id, userId: inv.created_by,
    doc: {
      title: shop.gstin ? 'TAX INVOICE' : 'BILL OF SUPPLY',
      number: inv.number,
      date: (inv.invoice_date instanceof Date ? inv.invoice_date.toISOString() : String(inv.invoice_date)).slice(0, 10),
      shop: {
        name: shop.name, address: shop.address, phone: shop.phone ? '+' + shop.phone : null, email: shop.email, gstin: shop.gstin,
        stateCode: shop.state_code, stateName: shop.state_name, upiId: shop.upi_id, logoDataUri,
        bank: { accountName: shop.bank_account_name, bankName: shop.bank_name, accountNo: shop.bank_account_no, ifsc: shop.bank_ifsc }
      },
      billTo: { name: billTo.name ?? 'Cash / Walk-in', address: billTo.address, phone: billTo.phone, gstin: inv.customer_gstin },
      placeOfSupply: { code: inv.place_of_supply, name: inv.pos_name },
      supply: inv.supply_type,
      lines: lines.map((l) => ({
        name: l.item_name, hsn: l.hsn, qty: String(l.qty), unit: l.unit, ratePaise: p(l.rate_paise), discountPaise: p(l.discount_paise),
        taxablePaise: p(l.taxable_paise), gstRate: Number(l.gst_rate), gstPaise: p(l.gst_paise), totalPaise: p(l.line_total_paise)
      })),
      totals: {
        taxablePaise: p(inv.taxable_paise), cgstPaise: p(inv.cgst_paise), sgstPaise: p(inv.sgst_paise), igstPaise: p(inv.igst_paise),
        roundOffPaise: p(inv.round_off_paise), totalPaise: p(inv.total_paise)
      },
      terms: shop.invoice_terms ?? []
    }
  };
}

export async function processInvoicePdf(deps: DocumentDeps, p: InvoicePdfPayload): Promise<'made' | 'already_done'> {
  const loaded = await withTenant(deps.pool, p.tenant_id, (tx) => loadInvoiceDoc(tx, p.invoice_id, deps.fileStore));
  if (loaded.pdfFileId) return 'already_done';

  const pdf = await deps.renderer.render(await invoiceHtml(loaded.doc));
  const filename = pdfFilename(loaded.doc.number);
  const path = `${p.tenant_id}/invoices/${filename}`;
  await deps.fileStore.put(path, pdf, 'application/pdf');

  return withTenant(deps.pool, p.tenant_id, async (tx) => {
    const { rows: [file] } = await tx.query(
      `insert into files (tenant_id, kind, bucket, path, mime, size_bytes, created_by)
       values ($1, 'invoice_pdf', $2, $3, 'application/pdf', $4, $5)
       on conflict (bucket, path) do update set size_bytes = excluded.size_bytes
       returning id`, [p.tenant_id, deps.fileStore.bucket, path, pdf.length, loaded.userId]);
    const linked = await tx.query('update invoices set pdf_file_id = $2 where id = $1 and pdf_file_id is null', [p.invoice_id, file.id]);
    if (!linked.rowCount) return 'already_done' as const;   // another run got there first

    if (p.notify_phone) {
      const out = { kind: 'document', to: p.notify_phone, fileId: file.id, filename,
        caption: `🧾 ${loaded.doc.number}: ₹${formatInr(loaded.doc.totals.totalPaise)}` };
      const { rows: [m] } = await tx.query(
        `insert into messages (wa_message_id, tenant_id, user_id, direction, phone, msg_type, payload, status)
         values ($1, $2, $3, 'out', $4, 'document', $5, 'pending') returning id`,
        ['pending:' + randomUUID(), p.tenant_id, loaded.userId, p.notify_phone, JSON.stringify(out)]);
      await enqueue(tx, p.notify_phone, { outbound_id: m.id, tenant_id: p.tenant_id }, 'outbound');
    }
    return 'made' as const;
  });
}
