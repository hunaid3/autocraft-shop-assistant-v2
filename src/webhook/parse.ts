/**
 * Turns a WhatsApp Cloud API webhook body into flat inbound messages and delivery statuses.
 * Unknown shapes are skipped, never thrown: a malformed entry must not drop the good ones
 * next to it, and Meta retries anything we answer with an error.
 */

export type InboundKind =
  | 'text' | 'button' | 'image' | 'document' | 'audio' | 'video' | 'sticker'
  | 'location' | 'contacts' | 'reaction' | 'order' | 'system' | 'unsupported';

export interface InboundMessage {
  waMessageId: string;
  from: string;               // sender, E.164 digits
  phoneNumberId: string;      // which of our numbers received it
  profileName?: string;
  sentAt: Date;
  kind: InboundKind;
  text?: string;              // body, caption, or button title
  buttonId?: string;          // our id for a tapped reply button / list row / template quick reply
  media?: { id: string; mimeType?: string; filename?: string; sha256?: string };
  replyToWaId?: string;       // the message this one quotes
  raw: unknown;
}

export interface StatusUpdate {
  waMessageId: string;
  status: string;             // sent | delivered | read | failed
  recipient: string;
  at: Date;
  error?: string;
}

/** These are stored but not processed: nothing to answer. */
export const NOT_PROCESSED: ReadonlySet<InboundKind> = new Set<InboundKind>(['reaction', 'system']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const ts = (v: unknown): Date => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
};

function toMessage(m: Obj, phoneNumberId: string, names: Map<string, string>): InboundMessage | null {
  const waMessageId = str(m.id);
  const from = str(m.from);
  if (!waMessageId || !from || !/^\d{8,15}$/.test(from)) return null;

  const base = {
    waMessageId, from, phoneNumberId, sentAt: ts(m.timestamp), raw: m,
    profileName: names.get(from),
    replyToWaId: isObj(m.context) ? str(m.context.id) : undefined
  };
  const type = str(m.type) ?? 'unsupported';

  switch (type) {
    case 'text':
      return { ...base, kind: 'text', text: isObj(m.text) ? str(m.text.body) : undefined };
    case 'interactive': {
      const i = isObj(m.interactive) ? m.interactive : {};
      const reply = isObj(i.button_reply) ? i.button_reply : isObj(i.list_reply) ? i.list_reply : undefined;
      if (reply) return { ...base, kind: 'button', buttonId: str(reply.id), text: str(reply.title) };
      // nfm_reply = a completed WhatsApp Flow (signup form); body is JSON text
      if (isObj(i.nfm_reply)) return { ...base, kind: 'button', buttonId: 'FLOW_REPLY', text: str(i.nfm_reply.response_json) };
      return { ...base, kind: 'unsupported' };
    }
    case 'button': { // quick reply on a template message
      const b = isObj(m.button) ? m.button : {};
      return { ...base, kind: 'button', buttonId: str(b.payload), text: str(b.text) };
    }
    case 'image': case 'document': case 'audio': case 'video': case 'sticker': {
      const media = isObj(m[type]) ? (m[type] as Obj) : {};
      const id = str(media.id);
      return {
        ...base, kind: type,
        text: str(media.caption),
        media: id ? { id, mimeType: str(media.mime_type), filename: str(media.filename), sha256: str(media.sha256) } : undefined
      };
    }
    case 'location': case 'contacts': case 'reaction': case 'order': case 'system':
      return { ...base, kind: type };
    default:
      return { ...base, kind: 'unsupported' };
  }
}

export function parseWebhook(body: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  if (!isObj(body) || body.object !== 'whatsapp_business_account') return { messages, statuses };

  for (const entry of arr(body.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObj(change) || change.field !== 'messages' || !isObj(change.value)) continue;
      const v = change.value;
      const phoneNumberId = isObj(v.metadata) ? str(v.metadata.phone_number_id) ?? '' : '';

      const names = new Map<string, string>();
      for (const c of arr(v.contacts)) {
        if (isObj(c) && str(c.wa_id) && isObj(c.profile) && str(c.profile.name)) names.set(c.wa_id as string, c.profile.name as string);
      }
      for (const m of arr(v.messages)) {
        const msg = isObj(m) ? toMessage(m, phoneNumberId, names) : null;
        if (msg) messages.push(msg);
      }
      // statuses is always present, often empty: check length, not truthiness
      for (const s of arr(v.statuses)) {
        if (!isObj(s) || !str(s.id) || !str(s.status)) continue;
        const errs = arr(s.errors).filter(isObj);
        statuses.push({
          waMessageId: s.id as string, status: s.status as string, recipient: str(s.recipient_id) ?? '', at: ts(s.timestamp),
          error: errs.length ? errs.map((e) => `${e.code ?? ''} ${e.title ?? ''}`.trim()).join('; ') : undefined
        });
      }
    }
  }
  return { messages, statuses };
}
