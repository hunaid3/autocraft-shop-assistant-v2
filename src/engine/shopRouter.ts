/**
 * The Phase 2 router (Code.gs actionProcess_ + actionButton_). For a registered shop member:
 *   understand → question: answer | entry: draft + confirm card | Confirm: commit | Cancel/Edit.
 * Unknown numbers and multi-shop numbers still get the Phase 1 replies (onboarding is Phase 4).
 *
 * prepare() does the slow parts outside the database transaction: the AI reader for text, and for a
 * bill photo or PDF: download it from WhatsApp, keep the original in the shop's folder, read it.
 *
 * Confirm runs in a savepoint: a refusal the person must read (not enough credits, bill already
 * entered, stock blocked) rolls back just the commit and is answered, instead of failing the job.
 */
import { withTenant } from '../db/tenantTx.js';
import { istDate } from '../domain/format.js';
import type { FileStore } from '../documents/fileStore.js';
import { pdfToPngs } from '../documents/pdfImages.js';
import { MediaTooLargeError, type WhatsAppClient } from '../whatsapp/client.js';
import type { BillReader, BillReading } from './billReader.js';
import { buildDraft, resolveDraft, saveDraft, takePendingDraft } from './drafts.js';
import { commitDraft, UserError } from './commit.js';
import { understand } from './parse.js';
import { HOW_TO, helpText, runQuery } from './queries.js';
import { phase1Router, type PrepareContext, type Reply, type RouteContext, type Router } from './router.js';
import { loadShop, loadCatalog } from './shop.js';
import type { Intent, ParseContext, Parser } from './intents.js';

const OWNER_ONLY = new Set<Intent['type']>(['purchase', 'expense', 'stock_count']);
const OWNER_ONLY_TEXT = 'Only the owner can do that. You can make bills and check stock.';
const BILL_EXAMPLE = '*bought 50 airdopes @ 850 from Sharma Traders bill 4471*';

export interface MediaDeps {
  whatsapp: Pick<WhatsAppClient, 'downloadMedia'>;
  fileStore: FileStore;
  billReader: BillReader;
  pdfToImages?: (pdf: Buffer) => Promise<Buffer[]>;
}

type BillFile = { path: string; mime: string; size: number; kind: 'bill_image' | 'bill_pdf' };
type Prepared =
  | { intent: Intent }
  | { bill: BillReading; file: BillFile }
  | { reply: string };

const text = (t: string): Reply[] => [{ kind: 'text', text: t }];

function buttonIntent(id: string | undefined): Intent {
  switch ((id ?? '').toUpperCase()) {
    case 'CONFIRM': return { type: 'confirm' };
    case 'CANCEL': return { type: 'cancel' };
    case 'EDIT': return { type: 'edit' };
    default: return { type: 'unknown' };
  }
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function shopRouter(parser: Parser, opts: { lowBalance?: number; media?: MediaDeps } = {}): Router {
  const lowBalance = opts.lowBalance ?? 20;
  const media = opts.media;

  async function parseContext(c: PrepareContext | RouteContext, tenantId: string): Promise<ParseContext> {
    const catalog = 'tx' in c ? await loadCatalog(c.tx) : await withTenant(c.pool, tenantId, (tx) => loadCatalog(tx));
    return { today: istDate(), catalog: catalog.flatMap((i) => [i.name, ...i.aliases]) };
  }

  async function prepareBill(c: PrepareContext, tenantId: string): Promise<Prepared> {
    const m = c.message;
    if (!media) return { reply: `Reading bill photos isn't switched on yet. Please type the purchase, e.g.\n${BILL_EXAMPLE}` };
    if (!m.media?.id) return { reply: "I couldn't open that file. Please send it again." };
    const declared = m.media.mimeType ?? '';
    if (m.kind === 'document' && declared !== 'application/pdf') {
      return { reply: 'I can read bills sent as a photo or a PDF. Excel item lists are coming with bulk upload.' };
    }
    let file: { bytes: Buffer; mime: string };
    try {
      file = await media.whatsapp.downloadMedia(m.media.id);
    } catch (e) {
      if (e instanceof MediaTooLargeError) return { reply: 'That file is too large (over 10 MB). Please send a photo of the bill instead.' };
      throw e;
    }
    const isPdf = file.mime === 'application/pdf' || declared === 'application/pdf';
    if (!isPdf && !IMAGE_MIMES.has(file.mime)) return { reply: 'Please send the bill as a photo (JPG or PNG) or a PDF.' };

    // Keep the original in the shop's folder: it's the record behind the purchase.
    const ext = isPdf ? 'pdf' : file.mime === 'image/png' ? 'png' : file.mime === 'image/webp' ? 'webp' : 'jpg';
    const path = `${tenantId}/bills/${m.waMessageId.replace(/[^A-Za-z0-9._-]/g, '_')}.${ext}`;
    await media.fileStore.put(path, file.bytes, isPdf ? 'application/pdf' : file.mime);

    let images: Array<{ bytes: Buffer; mime: string }>;
    try {
      images = isPdf
        ? (await (media.pdfToImages ?? ((b: Buffer) => pdfToPngs(b)))(file.bytes)).map((b) => ({ bytes: b, mime: 'image/png' }))
        : [{ bytes: file.bytes, mime: file.mime }];
    } catch {
      // A broken or password-protected PDF won't open on a retry either.
      return { reply: "I couldn't open that PDF (it may be damaged or password-protected). Please send a photo of the bill instead." };
    }
    if (!images.length) return { reply: "That PDF has no pages I can read. Please send a photo of the bill instead." };

    const bill = await media.billReader.read(images, await parseContext(c, tenantId));
    return { bill, file: { path, mime: isPdf ? 'application/pdf' : file.mime, size: file.bytes.length, kind: isPdf ? 'bill_pdf' : 'bill_image' } };
  }

  const route = async (ctx: RouteContext): Promise<Reply[]> => {
    const { sender, message, tx } = ctx;
    if (sender.kind !== 'member') return phase1Router(ctx);
    const isMedia = message.kind === 'image' || message.kind === 'document';
    if (!isMedia && !['text', 'button'].includes(message.kind)) return phase1Router(ctx);

    const shop = await loadShop(tx, sender.tenantId);
    const prepared = ctx.prepared as Prepared | undefined;
    if (isMedia && !prepared) return text("I couldn't read that file. Please send it again.");
    if (prepared && 'reply' in prepared) return text(prepared.reply);

    let intent: Intent;
    let note = '';
    if (prepared && 'bill' in prepared) {
      const { bill, file } = prepared;
      if (!bill.isBill) return text(`That doesn't look like a bill${bill.problem ? ` (${bill.problem})` : ''}. Send a clear photo of the supplier's bill, or type it, e.g.\n${BILL_EXAMPLE}`);
      if (!bill.lines.length) return text(`I couldn't read the items on that bill${bill.problem ? `: ${bill.problem}` : ''}. Try a sharper, straight-on photo in good light, or type it, e.g.\n${BILL_EXAMPLE}`);
      const { rows: [f] } = await tx.query(
        `insert into files (tenant_id, kind, path, mime, size_bytes, created_by) values ($1, $2, $3, $4, $5, $6)
         on conflict (bucket, path) do update set size_bytes = excluded.size_bytes returning id`,
        [shop.id, file.kind, file.path, file.mime, file.size, sender.userId]);
      intent = {
        type: 'purchase', party: { name: bill.supplier.name, gstin: bill.supplier.gstin }, lines: bill.lines, billNo: bill.billNo,
        source: file.kind, fileId: f.id, billDate: bill.billDate, printed: bill.printed
      };
      if (bill.problem) note = `\n⚠️ ${bill.problem}`;
    } else if (prepared && 'intent' in prepared) {
      intent = prepared.intent;
    } else {
      intent = message.kind === 'button' ? buttonIntent(message.buttonId) : await understand(message.text ?? '', parser, await parseContext(ctx, sender.tenantId));
    }

    if (OWNER_ONLY.has(intent.type) && sender.role !== 'owner') return text(OWNER_ONLY_TEXT);

    switch (intent.type) {
      case 'help':
      case 'greeting':
        return text(helpText(sender.userName, sender.role));
      case 'how_to':
        return text(HOW_TO[intent.about]);
      case 'query':
        return text(await runQuery(tx, intent, sender.role));
      case 'unknown':
        return text((intent.hint ? intent.hint + '\n\n' : "I didn't catch that. ") + 'Type *help* to see examples.');

      case 'cancel':
      case 'edit': {
        const d = await takePendingDraft(tx, sender.userId);
        if (!d || d.expired) return text("There's nothing waiting for confirmation right now.");
        await resolveDraft(tx, d.id, 'cancelled');
        return text(intent.type === 'edit' ? 'No problem. Send the corrected entry as a new message.' : 'Cancelled. Nothing was saved.');
      }

      case 'confirm': {
        const d = await takePendingDraft(tx, sender.userId);
        if (!d) return text("There's nothing waiting for confirmation right now. Send an entry or a question, or type *help*.");
        if (d.expired) return text('That entry waited too long (drafts last 10 minutes), so nothing was saved. Please send it again.');
        await tx.query('savepoint confirm_draft');
        try {
          const r = await commitDraft(tx, shop, d.payload, d.cost, sender.userId, sender.phone);
          await tx.query('release savepoint confirm_draft');
          await resolveDraft(tx, d.id, 'confirmed');
          await tx.query(
            "insert into audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id, detail) values ($1, 'user', $2, 'draft.confirm', $3, $4, $5)",
            [shop.id, sender.userId, r.refType, r.refId, JSON.stringify({ draft_id: d.id, credits: d.cost })]);
          const low = r.balance < lowBalance ? `\n\n⚠️ Only ${r.balance} credits left. Recharge from WhatsApp is coming soon; ask AutoCraft to top up.` : '';
          return text(r.reply + low);
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'AC001') {
            await tx.query('rollback to savepoint confirm_draft');
            const { rows } = await tx.query('select balance from credit_wallets');
            return text(`💳 Not enough credits: this needs ${d.cost}, you have ${rows[0]?.balance ?? 0}. Nothing was saved.\n\nAfter topping up, tap ✅ Confirm again within 10 minutes.`);
          }
          if (e instanceof UserError) {
            await tx.query('rollback to savepoint confirm_draft');
            await resolveDraft(tx, d.id, 'cancelled');
            return text(e.message);
          }
          throw e; // a real fault: the whole job rolls back and is retried
        }
      }

      case 'invoice':
      case 'purchase':
      case 'expense':
      case 'stock_count':
      case 'stock_out':
      case 'stock_return': {
        const b = await buildDraft(tx, shop, intent);
        if (!b.ok) return text(b.reply);
        if (b.cost > b.balance) {
          return text(`${b.summary}\n\n💳 This needs ${b.cost} credits and you have ${b.balance}, so it can't be saved yet. Nothing was saved.`);
        }
        await saveDraft(tx, shop.id, sender.userId, b, ctx.messageId ?? null);
        return [{
          kind: 'buttons',
          text: (b.summary + note + '\n\nSave this?').slice(0, 1024),
          buttons: [{ id: 'CONFIRM', title: '✅ Confirm' }, { id: 'EDIT', title: '✏️ Edit' }, { id: 'CANCEL', title: '❌ Cancel' }]
        }];
      }
    }
  };

  const prepare = async (c: PrepareContext): Promise<Prepared | undefined> => {
    if (c.sender.kind !== 'member') return undefined;
    const m = c.message;
    if (m.kind === 'image' || m.kind === 'document') {
      // Purchases are owner-only: don't download or spend AI on a staff member's photo
      if (c.sender.role !== 'owner') return { reply: OWNER_ONLY_TEXT };
      return prepareBill(c, c.sender.tenantId);
    }
    if (m.kind === 'text') return { intent: await understand(m.text ?? '', parser, await parseContext(c, c.sender.tenantId)) };
    return undefined;
  };

  return Object.assign(route, { prepare });
}
