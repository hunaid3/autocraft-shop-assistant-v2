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
import { HOW_TO, profileText, runQuery } from './queries.js';
import { signupRoute } from './signup.js';
import { checkStaffAdd, inviteRoute, listStaff, removeStaff, staffCard } from './staff.js';
import { helpMenu, helpTopic, type HelpTopic } from './help.js';
import { ASK_PROBLEM, captureSupport } from './support.js';
import { createLoginLink, LINK_MINUTES } from '../dashboard/api.js';
import { expiryNudge, packMenu, prepareLink, saveLink, type PreparedLink } from '../payments/recharge.js';
import type { PaymentGateway } from '../payments/razorpay.js';
import { supportRules } from './parse.js';
import { creditBalance, creditCost } from './shop.js';
import { phase1Router, type PrepareContext, type Reply, type RouteContext, type Router } from './router.js';
import { loadShop, loadCatalog } from './shop.js';
import type { Intent, ParseContext, Parser } from './intents.js';

// Staff may bill, quote, enter purchases (typed or photo), move stock and ask stock questions.
const OWNER_ONLY = new Set<Intent['type']>(['expense', 'stock_count', 'profile_update', 'staff_add', 'staff_list', 'staff_remove', 'dashboard', 'recharge']);
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
  | { logo: { path: string; mime: string; size: number } }
  | { bill: BillReading; file: BillFile }
  | { reply: string }
  | { payLink: PreparedLink }
  | { support: { text: string; file?: { path: string; mime: string; size: number } } };

const text = (t: string): Reply[] => [{ kind: 'text', text: t }];

function buttonIntent(id: string | undefined): Intent {
  switch ((id ?? '').toUpperCase()) {
    case 'CONFIRM': return { type: 'confirm' };
    case 'CANCEL': return { type: 'cancel' };
    case 'EDIT': return { type: 'edit' };
    case 'MENU': return { type: 'help' };
    case 'SUPPORT': return { type: 'support' };
    case 'RECHARGE': return { type: 'recharge' };
    default: {
      const t = /^HELP:([A-Z]+)$/.exec((id ?? '').toUpperCase());
      return t ? { type: 'help_topic', topic: t[1]!.toLowerCase() as HelpTopic } : { type: 'unknown' };
    }
  }
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function shopRouter(parser: Parser, opts: { lowBalance?: number; media?: MediaDeps; botPhone?: string; dashboardUrl?: string; payments?: PaymentGateway } = {}): Router {
  const lowBalance = opts.lowBalance ?? 20;
  const botPhone = opts.botPhone;
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

  /** A photo with caption "logo": keep it in the shop folder; the PDF templates embed it. */
  async function prepareLogo(c: PrepareContext, tenantId: string): Promise<Prepared> {
    if (!media) return { reply: "Saving a logo isn't switched on yet." };
    if (!c.message.media?.id) return { reply: "I couldn't open that photo. Please send it again." };
    let file: { bytes: Buffer; mime: string };
    try {
      file = await media.whatsapp.downloadMedia(c.message.media.id, 2 * 1024 * 1024);
    } catch (e) {
      if (e instanceof MediaTooLargeError) return { reply: 'That logo is too large. Please send a smaller image (under 2 MB).' };
      throw e;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mime)) return { reply: 'Please send the logo as a JPG or PNG photo.' };
    const ext = file.mime === 'image/png' ? 'png' : file.mime === 'image/webp' ? 'webp' : 'jpg';
    const path = `${tenantId}/logo/${c.message.waMessageId.replace(/[^A-Za-z0-9._-]/g, '_')}.${ext}`;
    await media.fileStore.put(path, file.bytes, file.mime);
    return { logo: { path, mime: file.mime, size: file.bytes.length } };
  }

  const routeInner = async (ctx: RouteContext): Promise<Reply[]> => {
    const { sender, message, tx } = ctx;
    if (sender.kind === 'unknown' && message.kind === 'text') {
      // Someone not registered (e.g. stuck at sign-up) can still reach AutoCraft
      const s = supportRules(message.text ?? '');
      if (s?.type === 'support') {
        return s.problem ? captureSupport(tx, sender, null, s.problem, null)
          : text('💬 Send *support* followed by your problem in one message, e.g.\n*support my GSTIN is already registered*');
      }
    }
    if (sender.kind === 'unknown' && ['text', 'button'].includes(message.kind)) {
      // A waiting staff invite comes before setting up a shop of their own
      return (await inviteRoute(tx, sender.phone, message.kind === 'button' ? message.buttonId : undefined, message.text ?? '')) ?? signupRoute(tx, sender.phone, message);
    }
    if (sender.kind !== 'member') return phase1Router(ctx);
    const isMedia = message.kind === 'image' || message.kind === 'document';
    if (!isMedia && !['text', 'button'].includes(message.kind)) return phase1Router(ctx);

    const shop = await loadShop(tx, sender.tenantId);
    const prepared = ctx.prepared as Prepared | undefined;
    if (isMedia && !prepared) return text("I couldn't read that file. Please send it again.");
    if (prepared && 'reply' in prepared) return text(prepared.reply);
    if (prepared && 'payLink' in prepared) {
      if (sender.role !== 'owner') return text(OWNER_ONLY_TEXT);
      return saveLink(tx, shop.id, sender.userId, prepared.payLink);
    }
    if (prepared && 'support' in prepared) {
      let fileId: string | null = null;
      if (prepared.support.file) {
        fileId = (await tx.query(
          `insert into files (tenant_id, kind, path, mime, size_bytes, created_by) values ($1, 'export', $2, $3, $4, $5)
           on conflict (bucket, path) do update set size_bytes = excluded.size_bytes returning id`,
          [shop.id, prepared.support.file.path, prepared.support.file.mime, prepared.support.file.size, sender.userId])).rows[0].id;
      }
      const d = await takePendingDraft(tx, sender.userId);
      if (d) await resolveDraft(tx, d.id, 'confirmed');
      return captureSupport(tx, sender, shop.id, prepared.support.text || '(photo only)', fileId);
    }
    if (prepared && 'logo' in prepared) {
      const { rows: [f] } = await tx.query(
        `insert into files (tenant_id, kind, path, mime, size_bytes, created_by) values ($1, 'logo', $2, $3, $4, $5)
         on conflict (bucket, path) do update set size_bytes = excluded.size_bytes returning id`,
        [shop.id, prepared.logo.path, prepared.logo.mime, prepared.logo.size, sender.userId]);
      await tx.query('update tenants set logo_file_id = $2 where id = $1', [shop.id, f.id]);
      return text('✅ Logo saved. It will appear on new bills and quotations. Send another photo with caption *logo* to change it.');
    }

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
    if (intent.type === 'query' && ['sales_period', 'credits'].includes(intent.report) && sender.role !== 'owner') return text('Sales and credits are visible to the owner only.');

    switch (intent.type) {
      case 'help':
      case 'greeting':
        return helpMenu(sender.userName, sender.role);
      case 'help_topic':
        return helpTopic(intent.topic, sender.role);
      case 'support': {
        if (intent.problem) return captureSupport(tx, sender, shop.id, intent.problem, null);
        await saveDraft(tx, shop.id, sender.userId, { ok: true, cost: 0, balance: 0, summary: 'Waiting for the problem message', payload: { kind: 'support_request' } }, ctx.messageId ?? null);
        return text(ASK_PROBLEM);
      }
      case 'how_to':
        return text(HOW_TO[intent.about]);
      case 'profile_show':
        return text(await profileText(tx, shop.id));
      case 'staff_add': {
        const ok = await checkStaffAdd(tx, shop.id, botPhone, intent.phone);
        if ('error' in ok) return text(ok.error);
        const cost = await creditCost(tx, 'staff_add');
        const balance = await creditBalance(tx);
        const summary = staffCard(ok.phone, intent.name, cost, balance);
        if (cost > balance) return text(`${summary}\n\n💳 Not enough credits yet, so nothing was done.`);
        await saveDraft(tx, shop.id, sender.userId, { ok: true, cost, balance, summary, payload: { kind: 'staff_add', phone: ok.phone, name: intent.name } }, ctx.messageId ?? null);
        return [{ kind: 'buttons', text: summary + '\n\nSend the invite?', buttons: [{ id: 'CONFIRM', title: '✅ Confirm' }, { id: 'CANCEL', title: '❌ Cancel' }] }];
      }
      case 'staff_list':
        return listStaff(tx);
      case 'recharge':
        return packMenu(tx);
      case 'dashboard': {
        const link = await createLoginLink(tx, shop.id, sender.userId, opts.dashboardUrl ?? 'https://app.autocraft-solutions.com');
        return text(`📊 Your dashboard: ${link}\n\nThe link works once, within ${LINK_MINUTES} minutes. That browser then stays signed in for 30 days. Don't forward it: it opens your shop's data.`);
      }
      case 'staff_remove':
        return removeStaff(tx, shop.id, sender.userId, intent.who);
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
          const low = r.balance < lowBalance ? `\n\n⚠️ Only ${r.balance} credits left. Send *recharge* to top up.` : '';
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
      case 'quotation':
      case 'quote_revise':
      case 'quote_convert':
      case 'purchase':
      case 'expense':
      case 'stock_count':
      case 'stock_out':
      case 'stock_return':
      case 'profile_update': {
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

  /** Owner's replies also carry a reminder when credits are about to expire (in-chat, no template needed). */
  const route = async (ctx: RouteContext): Promise<Reply[]> => {
    const replies = await routeInner(ctx);
    if (ctx.sender.kind === 'member' && ctx.sender.role === 'owner' && replies.length) {
      const nudge = await expiryNudge(ctx.tx, ctx.sender.tenantId);
      if (nudge) replies.push(nudge);
    }
    return replies;
  };

  const prepare = async (c: PrepareContext): Promise<Prepared | undefined> => {
    if (c.sender.kind !== 'member') return undefined;
    const m = c.message;
    // A pack tapped: create the Razorpay link now (an outside call, so before the transaction)
    const pack = m.kind === 'button' ? /^PACK:([a-z0-9_]+)$/i.exec(m.buttonId ?? '') : null;
    if (pack) {
      if (c.sender.role !== 'owner') return { reply: OWNER_ONLY_TEXT };
      try {
        const r = await prepareLink(c.pool, opts.payments, c.sender.tenantId, c.sender.phone, pack[1]!.toLowerCase());
        return 'error' in r && !('paymentId' in r) ? { reply: r.error } : { payLink: r as PreparedLink };
      } catch {
        // Not retried: a retry could open a second link. The owner can tap again.
        return { reply: "Couldn't open a payment link just now. Please tap the pack again in a minute." };
      }
    }
    // Waiting for a "Talk to AutoCraft" message? Then this message is the problem (a photo is attached, not read).
    if ((m.kind === 'text' || m.kind === 'image') && !/^\s*(cancel|stop|no)\s*$/i.test(m.text ?? '')) {
      const waiting = await withTenant(c.pool, c.sender.tenantId, (tx) => tx.query(
        "select 1 from drafts where user_id = $1 and status = 'pending' and kind = 'support_request' and expires_at > now()", [c.sender.kind === 'member' ? c.sender.userId : null]));
      if (waiting.rowCount) {
        if (m.kind === 'text') return { support: { text: m.text ?? '' } };
        if (media && m.media?.id) {
          try {
            const f = await media.whatsapp.downloadMedia(m.media.id, 5 * 1024 * 1024);
            const ext = f.mime === 'image/png' ? 'png' : 'jpg';
            const path = `${c.sender.tenantId}/support/${m.waMessageId.replace(/[^A-Za-z0-9._-]/g, '_')}.${ext}`;
            await media.fileStore.put(path, f.bytes, f.mime);
            return { support: { text: m.text ?? '', file: { path, mime: f.mime, size: f.bytes.length } } };
          } catch {
            return { support: { text: (m.text ?? '') + ' (a photo was sent but could not be saved)' } };
          }
        }
        return { support: { text: (m.text ?? '') + ' (photo)' } };
      }
    }
    if (m.kind === 'image' || m.kind === 'document') {
      if (m.kind === 'image' && /^\s*(?:my\s+|shop\s+)?logo\b/i.test(m.text ?? '')) {
        return c.sender.role === 'owner' ? prepareLogo(c, c.sender.tenantId) : { reply: OWNER_ONLY_TEXT };
      }
      return prepareBill(c, c.sender.tenantId);
    }
    if (m.kind === 'text') return { intent: await understand(m.text ?? '', parser, await parseContext(c, c.sender.tenantId)) };
    return undefined;
  };

  return Object.assign(route, { prepare });
}
