/**
 * Self sign-up on WhatsApp for a number that belongs to no shop. A short conversation:
 *   intro → shop name → GSTIN (or Skip) → state (only if no GSTIN) → UPI ID (or Skip) → Create shop.
 * Answers are kept per phone for 24 hours. "cancel" stops at any point.
 * The shop is created by app.provision_tenant: settings, owner membership, wallet and welcome credits.
 * (A WhatsApp Flows form can replace these questions later; the creation step stays the same.)
 */
import type { Tx } from '../db/tenantTx.js';
import { checkGstin } from '../domain/gstin.js';
import { normKey } from '../domain/itemMatch.js';
import type { InboundMessage } from '../webhook/parse.js';
import type { Reply } from './router.js';

type Step = 'intro' | 'name' | 'gstin' | 'state' | 'upi' | 'confirm';
interface Answers { name?: string; gstin?: string; stateCode?: string; stateName?: string; upi?: string }

const text = (t: string): Reply => ({ kind: 'text', text: t });
const buttons = (t: string, b: Array<[string, string]>): Reply => ({ kind: 'buttons', text: t, buttons: b.map(([id, title]) => ({ id, title })) });

const INTRO = '👋 Welcome to *AutoCraft Shop Assistant*\n\nMake GST bills and quotations, track stock and purchases, and read supplier bills from a photo, all here on WhatsApp.\n\n🎁 *100 free credits* to start (1 credit = ₹1). Takes 1 minute.';
const ASK_NAME = "What is your shop's name? (as it should appear on your bills)";
const ASK_GSTIN = 'Do you have a GSTIN? Send it here, or tap *No GSTIN* if your shop is not registered for GST.\n\n_You can add it later too._';
const ASK_STATE = 'Which state is your shop in? (e.g. *Telangana*)';
const ASK_UPI = 'Your UPI ID for payments? It adds a scan-to-pay QR on every bill (e.g. *shopname@okhdfcbank*). Or tap *Skip*.';

// Short forms people type for states (GST state codes)
const STATE_ALIASES: Record<string, string> = {
  ts: '36', tg: '36', ap: '37', mh: '27', ka: '29', tn: '33', kl: '32', dl: '07', 'new delhi': '07', up: '09', mp: '23', wb: '19',
  gj: '24', rj: '08', pb: '03', hr: '06', br: '10', od: '21', orissa: '21', jh: '20', cg: '22', uk: '05', hp: '02', ga: '30', as: '18',
  jk: '01', pondicherry: '34', puducherry: '34', bombay: '27', bangalore: '29', bengaluru: '29', hyderabad: '36', chennai: '33', kolkata: '19', mumbai: '27'
};

function id(m: InboundMessage): string {
  return (m.kind === 'button' ? m.buttonId ?? '' : '').toUpperCase();
}
const said = (m: InboundMessage, re: RegExp) => re.test((m.text ?? '').trim().toLowerCase());

async function findState(tx: Tx, raw: string): Promise<{ code: string; name: string } | null> {
  const k = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  const code = /^\d{1,2}$/.test(k) ? k.padStart(2, '0') : STATE_ALIASES[k];
  const { rows } = await tx.query('select code, name from gst_states where active order by code');
  if (code) return rows.find((r) => r.code === code) ?? null;
  const n = normKey(raw);
  if (n.length < 3) return null;
  const exact = rows.find((r) => normKey(r.name) === n);
  if (exact) return exact;
  const starts = rows.filter((r) => normKey(r.name).startsWith(n));
  return starts.length === 1 ? starts[0] : null;
}

function summary(a: Answers): string {
  return '📋 *Please check:*\n' +
    `• Shop: *${a.name}*\n` +
    `• GSTIN: ${a.gstin ?? 'none (bills will be *bills of supply*, no GST)'}\n` +
    `• State: ${a.stateName} (${a.stateCode})\n` +
    `• UPI: ${a.upi ?? 'not set'}`;
}

export async function signupRoute(tx: Tx, phone: string, m: InboundMessage): Promise<Reply[]> {
  const { rows: [s] } = await tx.query(
    'select step, answers, expires_at < now() as expired from signup_sessions where phone = $1 for update', [phone]);
  const save = (step: Step, a: Answers) => tx.query(
    `insert into signup_sessions (phone, step, answers, expires_at) values ($1, $2, $3, now() + interval '24 hours')
     on conflict (phone) do update set step = excluded.step, answers = excluded.answers, expires_at = excluded.expires_at`,
    [phone, step, JSON.stringify(a)]);

  if (said(m, /^(cancel|stop|exit|quit)$/) || id(m) === 'NOTNOW') {
    await tx.query('delete from signup_sessions where phone = $1', [phone]);
    return [text('No problem. Send *Hi* any time to set up your shop.')];
  }

  const wantsStart = id(m) === 'START' || said(m, /^(start|start free|register|sign ?up|join|yes|create shop)$/);
  if (!s || s.expired) {
    if (wantsStart) { await save('name', {}); return [text(ASK_NAME)]; }
    await save('intro', {});
    return [buttons(INTRO, [['START', '🚀 Start free'], ['NOTNOW', 'Not now']])];
  }

  const a = s.answers as Answers;
  const value = (m.text ?? '').trim();
  const skip = id(m) === 'SKIP' || said(m, /^(skip|no|none|nil|na|n\/a|no gstin|not registered|later)$/);

  switch (s.step as Step) {
    case 'intro':
      if (wantsStart) { await save('name', {}); return [text(ASK_NAME)]; }
      return [buttons(INTRO, [['START', '🚀 Start free'], ['NOTNOW', 'Not now']])];

    case 'name': {
      if (m.kind !== 'text' || value.length < 2) return [text(ASK_NAME)];
      if (value.length > 80) return [text('That is a bit long for a bill heading. Please send a shorter shop name (up to 80 characters).')];
      await save('gstin', { name: value.replace(/\s+/g, ' ') });
      return [buttons(ASK_GSTIN, [['SKIP', 'No GSTIN']])];
    }

    case 'gstin': {
      if (skip) { await save('state', { ...a, gstin: undefined }); return [text(ASK_STATE)]; }
      const g = checkGstin(value);
      if (!g.ok) return [buttons(`That GSTIN doesn't look right: ${g.reason}. Please check and send it again, or tap *No GSTIN*.`, [['SKIP', 'No GSTIN']])];
      const st = await findState(tx, g.stateCode);
      if (!st) return [buttons(`The GSTIN starts with ${g.stateCode}, which is not a state code I know. Please check it, or tap *No GSTIN*.`, [['SKIP', 'No GSTIN']])];
      const next = { ...a, gstin: g.gstin, stateCode: st.code, stateName: st.name };
      await save('upi', next);
      return [buttons(`✓ GSTIN ${g.gstin} (${st.name}).\n\n${ASK_UPI}`, [['SKIP', 'Skip']])];
    }

    case 'state': {
      const st = value ? await findState(tx, value) : null;
      if (!st) return [text(`I couldn't match "${value.slice(0, 40)}" to a state. Please type the full name, e.g. *Telangana* or *Maharashtra*.`)];
      await save('upi', { ...a, stateCode: st.code, stateName: st.name });
      return [buttons(ASK_UPI, [['SKIP', 'Skip']])];
    }

    case 'upi': {
      let upi: string | undefined;
      if (!skip) {
        if (!/^[a-z0-9._-]{2,256}@[a-z]{2,64}$/i.test(value)) return [buttons("That doesn't look like a UPI ID (it has an @, like *name@okaxis*). Send it again, or tap *Skip*.", [['SKIP', 'Skip']])];
        upi = value.toLowerCase();
      }
      const next = { ...a, upi };
      await save('confirm', next);
      return [buttons(summary(next), [['CREATE', '✅ Create shop'], ['RESTART', '↩️ Start over']])];
    }

    case 'confirm': {
      if (id(m) === 'RESTART' || said(m, /^(start over|restart|edit|change)$/)) { await save('name', {}); return [text(ASK_NAME)]; }
      if (!(id(m) === 'CREATE' || said(m, /^(create|create shop|yes|ok|confirm)$/))) {
        return [buttons(summary(a), [['CREATE', '✅ Create shop'], ['RESTART', '↩️ Start over']])];
      }
      const { rows: [t] } = await tx.query('select app.provision_tenant($1, $2, $3, $4, $5, null, null, $6) as id',
        [phone, m.profileName?.slice(0, 80) ?? null, a.name, a.stateCode, a.gstin ?? null, a.upi ?? null]);
      await tx.query('delete from signup_sessions where phone = $1', [phone]);
      void t;
      const { rows: [b] } = await tx.query("select value::text::int as n from platform_settings where key = 'signup_bonus_credits'");
      return [
        text(`🎉 *${a.name}* is ready! You are the owner, and you have *${b?.n ?? 100} free credits*.\n\n` +
          'Try your first entry now:\n' +
          '📥 *bought* 50 airdopes @ 850 from Sharma Traders (adds stock)\n' +
          '🧾 *bill* Ravi 2 airdopes at 1250\n' +
          '📝 *quote* Ravi 10 airdopes at 1200\n\n' +
          'You always see a summary first; nothing is saved until you tap ✅ Confirm.\n\n' +
          'Add more details any time: *update address …*, *update upi …*, send a photo with caption *logo*. Type *profile* to see your shop details, *help* for everything.')
      ];
    }
  }
}
