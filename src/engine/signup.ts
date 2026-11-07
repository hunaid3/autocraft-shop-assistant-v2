/**
 * Self sign-up on WhatsApp for a number that belongs to no shop. A short conversation:
 *   intro → shop name → GSTIN (or Skip) → state (only if no GSTIN) → UPI ID (or Skip) → Create shop.
 * Answers are kept per phone for 24 hours. "cancel" stops at any point.
 * The shop is created by app.provision_tenant: settings, owner membership, wallet and welcome credits.
 * (A WhatsApp Flows form can replace these questions later; the creation step stays the same.)
 */
import { GREETING, looksAutomated } from './replyGuard.js';
import type { Tx } from '../db/tenantTx.js';
import { checkGstin } from '../domain/gstin.js';
import { normKey } from '../domain/itemMatch.js';
import type { InboundMessage } from '../webhook/parse.js';
import type { Reply } from './router.js';

type Step = 'intro' | 'name' | 'gstin' | 'state' | 'upi' | 'confirm';
interface Answers { name?: string; gstin?: string; stateCode?: string; stateName?: string; upi?: string; extra?: boolean }

const text = (t: string): Reply => ({ kind: 'text', text: t });
const buttons = (t: string, b: Array<[string, string]>): Reply => ({ kind: 'buttons', text: t, buttons: b.map(([id, title]) => ({ id, title })) });

const PITCH = '👋 Welcome to *AutoCraft Shop Assistant*\n\nMake GST bills and quotations, track stock and purchases, and read supplier bills from a photo, all here on WhatsApp.';
const intro = (bonus: number | null) => PITCH + (bonus
  ? `\n\n🎁 *${bonus} free credits* to start (1 credit = ₹1). Takes 1 minute.`
  : '\n\nWelcome back! This number has already had its welcome credits, so the new shop starts at 0 credits; send *recharge* after setup. Takes 1 minute.');
const ASK_GSTIN_EXTRA = "What is the new shop's GSTIN?\n\nA second shop on the same number needs its own GSTIN. (A shop without GSTIN needs a different WhatsApp number.)";
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

async function bonusFor(tx: Tx, phone: string, gstin?: string): Promise<number | null> {
  const { rows: [r] } = await tx.query(
    "select app.welcome_available($1, $2) as ok, (select value::text::int from platform_settings where key = 'signup_bonus_credits') as n", [phone, gstin ?? null]);
  return r.ok && r.n > 0 ? r.n : null;
}

/** "add shop": the owner of shops that all have a GSTIN starts the same questions for one more shop. */
export async function startExtraShop(tx: Tx, phone: string): Promise<Reply[]> {
  // Any GSTIN stands in for the new one here: the question is whether all current shops have one
  const { rows: [r] } = await tx.query('select app.can_join_shop($1, $2) as ok', [phone, 'NEW-SHOP-GSTIN']);
  if (!r.ok) {
    return [text('This number is in a shop without a GSTIN, so it can\'t open another shop.\n\n' +
      'One number can have several shops only when each shop has its own GSTIN. Use a different WhatsApp number for the new shop, ' +
      'or send *support* if your current shop now has a GSTIN.')];
  }
  await tx.query(
    `insert into signup_sessions (phone, step, answers, expires_at) values ($1, 'name', $2, now() + interval '24 hours')
     on conflict (phone) do update set step = excluded.step, answers = excluded.answers, expires_at = excluded.expires_at`,
    [phone, JSON.stringify({ extra: true })]);
  return [text('🏬 *Open another shop*\n\nYou will own it from this same number and can switch between shops any time with *switch shop*. Send *cancel* to stop.\n\n' + ASK_NAME)];
}

/** Is this number in the middle of opening another shop? */
export async function extraShopPending(tx: Tx, phone: string): Promise<boolean> {
  const { rowCount } = await tx.query("select 1 from signup_sessions where phone = $1 and expires_at > now() and (answers->>'extra')::boolean", [phone]);
  return Boolean(rowCount);
}

export async function signupRoute(tx: Tx, phone: string, m: InboundMessage): Promise<Reply[]> {
  const { rows: [s] } = await tx.query(
    `select step, answers, expires_at < now() as expired, coalesce(intro_sent_at > now() - interval '24 hours', false) as intro_recent
       from signup_sessions where phone = $1 for update`, [phone]);
  const save = (step: Step, a: Answers) => tx.query(
    `insert into signup_sessions (phone, step, answers, expires_at) values ($1, $2, $3, now() + interval '24 hours')
     on conflict (phone) do update set step = excluded.step, answers = excluded.answers, expires_at = excluded.expires_at`,
    [phone, step, JSON.stringify(a)]);

  if (said(m, /^(cancel|stop|exit|quit)$/) || id(m) === 'NOTNOW') {
    const wasExtra = Boolean((s?.answers as Answers | undefined)?.extra);
    await tx.query('delete from signup_sessions where phone = $1', [phone]);
    return [text(wasExtra ? 'Stopped. No new shop was created.' : 'No problem. Send *Hi* any time to set up your shop.')];
  }

  const wantsStart = id(m) === 'START' || said(m, /^(start|start free|register|sign ?up|join|yes|create shop)$/);
  const introCard = async () => buttons(intro(await bonusFor(tx, phone)), [['START', '🚀 Start'], ['NOTNOW', 'Not now']]);
  // The welcome card goes out at most once a day, unless the person greets us or taps a button: banks,
  // adverts and other bots that keep messaging get silence instead of a card each time.
  const notTalkingToUs = !wantsStart && m.kind !== 'button' && !GREETING.test(m.text ?? '');
  const atIntro = !s || s.expired || s.step === 'intro';
  if (atIntro && m.kind === 'text' && looksAutomated(m.text)) return [];
  if (atIntro && notTalkingToUs && s?.intro_recent) return [];
  const sendIntro = async () => {
    await save('intro', {});
    await tx.query('update signup_sessions set intro_sent_at = now() where phone = $1', [phone]);
    return [await introCard()];
  };
  if (!s || s.expired) {
    if (wantsStart) { await save('name', {}); return [text(ASK_NAME)]; }
    return sendIntro();
  }

  const a = s.answers as Answers;
  const extra = Boolean(a.extra);
  const gstinAsk = () => extra ? text(ASK_GSTIN_EXTRA) : buttons(ASK_GSTIN, [['SKIP', 'No GSTIN']]);
  const value = (m.text ?? '').trim();
  const skip = id(m) === 'SKIP' || said(m, /^(skip|no|none|nil|na|n\/a|no gstin|not registered|later)$/);

  switch (s.step as Step) {
    case 'intro':
      if (wantsStart) { await save('name', {}); return [text(ASK_NAME)]; }
      return sendIntro();

    case 'name': {
      if (m.kind !== 'text' || value.length < 2) return [text(ASK_NAME)];
      if (value.length > 80) return [text('That is a bit long for a bill heading. Please send a shorter shop name (up to 80 characters).')];
      await save('gstin', { ...(extra ? { extra } : {}), name: value.replace(/\s+/g, ' ') });
      return [gstinAsk()];
    }

    case 'gstin': {
      const orSkip = extra ? '' : ', or tap *No GSTIN*';
      const again = (t: string) => extra ? text(t) : buttons(t, [['SKIP', 'No GSTIN']]);
      if (skip) {
        if (extra) return [text('A second shop on this number needs its own GSTIN. Send the GSTIN, or *cancel*. (A shop without GSTIN needs a different WhatsApp number.)')];
        await save('state', { ...a, gstin: undefined }); return [text(ASK_STATE)];
      }
      const g = checkGstin(value);
      if (!g.ok) return [again(`That GSTIN doesn't look right: ${g.reason}. Please check and send it again${orSkip}.`)];
      if ((await tx.query('select app.gstin_in_use($1) as used', [g.gstin])).rows[0].used) {
        return [again(`${g.gstin} is already registered to a shop on AutoCraft. If it's yours, send *support* followed by a short note and we'll sort it out.${extra ? '' : ' Or tap *No GSTIN* to continue without it.'}`)];
      }
      if (!(await tx.query('select app.can_join_shop($1, $2) as ok', [phone, g.gstin])).rows[0].ok) {
        return [text('This number already belongs to a shop without a GSTIN. One number can be in several shops only when each shop has its own GSTIN, so please use a different WhatsApp number for this shop.')];
      }
      const st = await findState(tx, g.stateCode);
      if (!st) return [again(`The GSTIN starts with ${g.stateCode}, which is not a state code I know. Please check it${orSkip}.`)];
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
      if (id(m) === 'RESTART' || said(m, /^(start over|restart|edit|change)$/)) { await save('name', extra ? { extra } : {}); return [text(ASK_NAME)]; }
      if (!(id(m) === 'CREATE' || said(m, /^(create|create shop|yes|ok|confirm)$/))) {
        return [buttons(summary(a), [['CREATE', '✅ Create shop'], ['RESTART', '↩️ Start over']])];
      }
      if (a.gstin && (await tx.query('select app.gstin_in_use($1) as used', [a.gstin])).rows[0].used) {
        await save('gstin', { ...a, gstin: undefined });
        return [extra ? text(`${a.gstin} was just registered to another shop. Send *support* with a short note if it's yours.`)
          : buttons(`${a.gstin} was just registered to another shop. Send *support* with a short note if it's yours, or tap *No GSTIN*.`, [['SKIP', 'No GSTIN']])];
      }
      if (!(await tx.query('select app.can_join_shop($1, $2) as ok', [phone, a.gstin ?? null])).rows[0].ok) {
        await tx.query('delete from signup_sessions where phone = $1', [phone]);
        return [text('This number already belongs to a shop. One number can be in several shops only when each shop has its own GSTIN, so please use a different WhatsApp number for this shop.')];
      }
      const bonus = await bonusFor(tx, phone, a.gstin);
      await tx.query('select app.provision_tenant($1, $2, $3, $4, $5, null, null, $6) as id',
        [phone, m.profileName?.slice(0, 80) ?? null, a.name, a.stateCode, a.gstin ?? null, a.upi ?? null]);
      await tx.query('delete from signup_sessions where phone = $1', [phone]);
      const credits = bonus
        ? `you have *${bonus} free credits*`
        : 'this number (or GSTIN) has already had its welcome credits, so the shop starts at 0 credits. Send *recharge* to add some';
      return [
        text(`🎉 *${a.name}* is ready! You are the owner, and ${credits}.\n\n` +
          (extra ? 'You are now working in this shop. Send *switch shop* to go back to your other shop.\n\n' : '') +
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
