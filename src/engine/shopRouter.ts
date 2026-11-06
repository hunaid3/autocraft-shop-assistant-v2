/**
 * The Phase 2 router (Code.gs actionProcess_ + actionButton_). For a registered shop member:
 *   understand → question: answer | entry: draft + confirm card | Confirm: commit | Cancel/Edit.
 * Unknown numbers and multi-shop numbers still get the Phase 1 replies (onboarding is Phase 4).
 *
 * Confirm runs in a savepoint: a refusal the person must read (not enough credits, bill already
 * entered, stock blocked) rolls back just the commit and is answered, instead of failing the job.
 */
import { istDate } from '../domain/format.js';
import { buildDraft, resolveDraft, saveDraft, takePendingDraft } from './drafts.js';
import { commitDraft, UserError } from './commit.js';
import { understand } from './parse.js';
import { HOW_TO, helpText, runQuery } from './queries.js';
import { phase1Router, type Reply, type Router } from './router.js';
import { loadShop, loadCatalog } from './shop.js';
import type { Intent, Parser } from './intents.js';

const OWNER_ONLY = new Set<Intent['type']>(['purchase', 'expense', 'stock_count']);
const MEDIA_SOON = 'Reading bill photos and PDFs is being switched on in the next update. For now, type the entry, e.g.\n*bought 50 airdopes @ 850 from Sharma Traders bill 4471*';

const text = (t: string): Reply[] => [{ kind: 'text', text: t }];

function buttonIntent(id: string | undefined): Intent {
  switch ((id ?? '').toUpperCase()) {
    case 'CONFIRM': return { type: 'confirm' };
    case 'CANCEL': return { type: 'cancel' };
    case 'EDIT': return { type: 'edit' };
    default: return { type: 'unknown' };
  }
}

export function shopRouter(parser: Parser, opts: { lowBalance?: number } = {}): Router {
  const lowBalance = opts.lowBalance ?? 20;

  return async (ctx) => {
    const { sender, message, tx } = ctx;
    if (sender.kind !== 'member') return phase1Router(ctx);
    if (['image', 'document'].includes(message.kind)) return text(MEDIA_SOON);
    if (!['text', 'button'].includes(message.kind)) return phase1Router(ctx);

    const shop = await loadShop(tx, sender.tenantId);
    const intent: Intent = message.kind === 'button'
      ? buttonIntent(message.buttonId)
      : await understand(message.text ?? '', parser, { today: istDate(), catalog: (await loadCatalog(tx)).flatMap((i) => [i.name, ...i.aliases]) });

    if (OWNER_ONLY.has(intent.type) && sender.role !== 'owner') {
      return text('Only the owner can do that. You can make bills and check stock.');
    }

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
          const r = await commitDraft(tx, shop, d.payload, d.cost, sender.userId);
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
      case 'stock_count': {
        const b = await buildDraft(tx, shop, intent);
        if (!b.ok) return text(b.reply);
        if (b.cost > b.balance) {
          return text(`${b.summary}\n\n💳 This needs ${b.cost} credits and you have ${b.balance}, so it can't be saved yet. Nothing was saved.`);
        }
        await saveDraft(tx, shop.id, sender.userId, b, ctx.messageId ?? null);
        return [{
          kind: 'buttons',
          text: (b.summary + '\n\nSave this?').slice(0, 1024),
          buttons: [{ id: 'CONFIRM', title: '✅ Confirm' }, { id: 'EDIT', title: '✏️ Edit' }, { id: 'CANCEL', title: '❌ Cancel' }]
        }];
      }
    }
  };
}

