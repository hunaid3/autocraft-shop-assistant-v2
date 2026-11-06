/** Builders for WhatsApp Cloud API webhook bodies, shaped like Meta's real payloads. */
import { signBody } from '../../src/webhook/signature.js';

export const PHONE_NUMBER_ID = '100000000000001';
export const APP_SECRET = 'test-app-secret';
export const VERIFY_TOKEN = 'test-verify-token';
export const BOT_PHONE = '919000000000';

let seq = 0;
export const wamid = () => `wamid.TEST${process.pid}x${Date.now()}x${++seq}`;

export function text(from: string, body: string, id = wamid()) {
  return { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } };
}

export function buttonReply(from: string, buttonId: string, title: string, id = wamid()) {
  return { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: buttonId, title } } };
}

export function image(from: string, mediaId: string, caption?: string, id = wamid()) {
  return { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'image',
    image: { id: mediaId, mime_type: 'image/jpeg', sha256: 'abc', ...(caption ? { caption } : {}) } };
}

export function payload(opts: { messages?: unknown[]; statuses?: unknown[]; contacts?: unknown[]; phoneNumberId?: string }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_ID',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: BOT_PHONE, phone_number_id: opts.phoneNumberId ?? PHONE_NUMBER_ID },
          contacts: opts.contacts ?? [],
          messages: opts.messages ?? [],
          statuses: opts.statuses ?? []
        }
      }]
    }]
  };
}

export function status(waMessageId: string, s: 'sent' | 'delivered' | 'read' | 'failed', recipient = '919876543210') {
  return { id: waMessageId, status: s, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: recipient };
}

/** Body + headers exactly as Meta would POST them. */
export function signed(body: unknown, secret = APP_SECRET) {
  const raw = JSON.stringify(body);
  return { payload: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(raw, secret) } };
}
