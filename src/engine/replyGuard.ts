/**
 * Reply guard: the shared number must not keep answering banks, adverts and other bots.
 * This file holds the text checks; the limits themselves live in the database (app.reply_guard,
 * app.reply_loop_check) so every worker sees the same counts.
 */

/** Messages a machine sent (OTPs, bank alerts, promotions with an opt-out). Only used for numbers that aren't shops. */
const AUTOMATED: RegExp[] = [
  /\b(otp|one[\s-]?time[\s-]?pass(word|code)|verification code|security code|login code|auth(entication)? code)\b/i,
  /\bis your [\w\s]{0,20}(code|otp|pin|password)\b/i,
  /\b(a\/c|acct|account|card|upi)\b[\s\S]{0,80}\b(credited|debited|withdrawn|spent|deducted|reversed)\b/i,
  /\b(credited|debited|deducted)\b[\s\S]{0,60}(rs\.?|inr|₹)\s?\d/i,
  /\b(avl|available|avbl)\.? (bal|balance)\b/i,
  /\b(reply|send|sms|text|type)\s+['"*]?stop['"*]?\b|\bunsubscribe\b|\bopt[\s-]?out\b|\bt\s?&\s?c\s?apply\b/i,
  /\b(do not|don't|never) share (this|your|the)\b/i,
  /\b(pre[\s-]?approved|cashback|% off|flat \d+%|limited[\s-]time offer|offer valid|shop now|apply now|claim now|lucky draw)\b/i,
  /\b(delivered|dispatched|shipped|out for delivery)\b[\s\S]{0,60}\b(order|awb|tracking|shipment)\b/i
];

export function looksAutomated(text: string | undefined | null): boolean {
  const t = (text ?? '').trim();
  if (t.length < 12) return false;   // "hi", "start", a shop name: never
  return AUTOMATED.some((r) => r.test(t));
}

/** Words that show a person wants to talk: these always get the welcome card. */
export const GREETING = /^\s*(hi+|hello+|hey+|helo|hlo|namaste|namaskar|salaam|salam|assalamu?\s?alaikum|good (morning|afternoon|evening)|start|menu|help|register|join|sign ?up|demo)\b/i;

export const MUTED_NOTICE =
  "⏸️ I'm getting a lot of messages very quickly from this number, so I'm pausing replies for an hour to be safe. " +
  'Nothing was lost. If this was you, try again after an hour, or email support@autocraft-solutions.com.';
