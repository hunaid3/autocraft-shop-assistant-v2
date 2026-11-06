/**
 * Decides the reply to one inbound message. Phase 1 answers by sender type only; Phase 2
 * replaces the member branch with the command router (stock, bill, quote, confirm...).
 *
 * Two steps per message:
 *   prepare (optional) — runs BEFORE any transaction: slow reads such as the AI reader, downloading
 *     media from WhatsApp, reading a bill photo. It may store an uploaded file, but must not change
 *     business data. If it throws, the job is retried.
 *   route — runs inside the transaction that also records the message as processed and queues the
 *     replies, so any database work it does commits together with them. Quick work only; it must not
 *     call WhatsApp or any outside service.
 */
import type pg from 'pg';
import type { Tx } from '../db/tenantTx.js';
import type { InboundMessage } from '../webhook/parse.js';
import type { Sender } from './senders.js';

export type Reply =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; text: string; buttons: Array<{ id: string; title: string }> };

export interface RouteContext {
  sender: Sender;
  message: InboundMessage;
  tx: Tx;
  /** our messages.id for this inbound message (drafts point back to it) */
  messageId?: string;
  /** whatever prepare() returned */
  prepared?: unknown;
}

export interface PrepareContext {
  sender: Sender;
  message: InboundMessage;
  pool: pg.Pool;
  messageId: string;
}

export type Router = ((ctx: RouteContext) => Promise<Reply[]>) & {
  prepare?: (ctx: PrepareContext) => Promise<unknown>;
};

const CANT_READ: Partial<Record<InboundMessage['kind'], string>> = {
  audio: "I can't listen to voice notes yet. Please type your message.",
  video: "I can't read videos. Send a photo or PDF of a bill, or type your message.",
  sticker: '🙂 Send me an entry or a question, or type *help*.',
  location: "I don't use locations. Type your message, or *help* for examples.",
  contacts: "I can't read contact cards yet. Type the name and number instead.",
  order: "I can't read catalogue orders yet. Type the items instead.",
  unsupported: "I couldn't read that message. Please type it, or *help* for examples."
};

export const phase1Router: Router = async ({ sender, message }) => {
  const cant = CANT_READ[message.kind];

  if (sender.kind === 'unknown') {
    return [{
      kind: 'text',
      text: '👋 Welcome to *AutoCraft Shop Assistant*: billing, stock and GST invoices on WhatsApp.\n\n' +
        'This number is not registered yet. Self sign-up is coming soon; until then, ask AutoCraft to add your shop.'
    }];
  }

  if (sender.kind === 'multiple') {
    return [{
      kind: 'text',
      text: 'Your number is registered with more than one shop:\n' +
        sender.memberships.map((m, i) => `${i + 1}. ${m.tenantName}`).join('\n') +
        '\n\nChoosing a shop from WhatsApp is coming soon. For now, please ask AutoCraft which shop this number should use.'
    }];
  }

  if (cant) return [{ kind: 'text', text: cant }];
  return [{
    kind: 'text',
    text: `Hi${sender.userName ? ' ' + sender.userName : ''} 👋 *${sender.tenantName}* is connected to the new AutoCraft engine.\n\n` +
      'Billing, stock and quotations are being switched on in the next update.'
  }];
};
