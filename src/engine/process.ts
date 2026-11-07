/**
 * The two jobs the worker runs.
 *
 * inbound  { message_id }            → resolve the sender, run the router, and in ONE transaction:
 *                                       attach shop + person to the message, mark it processed,
 *                                       write the replies to the outbox, queue one send job each.
 * outbound { outbound_id, tenant_id } → send one outbox message to WhatsApp, store Meta's id.
 *
 * Because replies leave through the outbox, a WhatsApp outage only delays replies: the inbound
 * work is never redone, and a confirmed bill can never be created twice.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTenant, withoutTenant, type Tx } from '../db/tenantTx.js';
import { enqueue } from '../queue/queue.js';
import type { InboundMessage } from '../webhook/parse.js';
import { WhatsAppSendError, type OutboundMessage, type WhatsAppClient } from '../whatsapp/client.js';
import { resolveSender } from './senders.js';
import { MUTED_NOTICE } from './replyGuard.js';
import type { Reply, Router } from './router.js';
import type { EmailSender } from '../notify/email.js';
import type { FileStore } from '../documents/fileStore.js';
import type { PdfRenderer } from '../documents/pdf.js';

export interface EngineDeps {
  pool: pg.Pool;
  whatsapp: WhatsAppClient;
  router: Router;
  /** PDFs: needed for the 'documents' queue and for sending stored files */
  documents?: { renderer: PdfRenderer; fileStore: FileStore };
  /** support alerts by email (SES); WhatsApp alerts need nothing extra */
  notify?: { email?: EmailSender };
}

export interface InboundPayload { message_id: string }
export interface OutboundPayload { outbound_id: string; tenant_id: string | null }

/** A failure that retrying won't fix. The job is completed, not retried. */
export class PermanentError extends Error {}

async function queueReplies(tx: Tx, to: string, tenantId: string | null, userId: string | null, replies: Reply[]): Promise<void> {
  for (const r of replies) {
    const out: OutboundMessage = { ...r, to } as OutboundMessage;
    const { rows } = await tx.query(
      `insert into messages (wa_message_id, tenant_id, user_id, direction, phone, msg_type, payload, status)
       values ($1, $2, $3, 'out', $4, $5, $6, 'pending') returning id`,
      ['pending:' + randomUUID(), tenantId, userId, to, r.kind, JSON.stringify(out)]);
    await enqueue(tx, to, { outbound_id: rows[0].id, tenant_id: tenantId } satisfies OutboundPayload, 'outbound');
  }
}

export async function processInbound(deps: EngineDeps, p: InboundPayload): Promise<'processed' | 'already_done'> {
  // Not yet attached to a shop, so it's visible without shop context. If it is attached,
  // an earlier attempt already committed: nothing to do.
  const found = await withoutTenant(deps.pool, (tx) =>
    tx.query("select payload from messages where id = $1 and direction = 'in' and tenant_id is null and status = 'queued'", [p.message_id]));
  if (!found.rowCount) return 'already_done';
  const message = found.rows[0].payload as InboundMessage;

  // Blocked by an admin, or muted by the loop breaker: keep the message, send nothing, do no work (no AI)
  const guard = await withoutTenant(deps.pool, async (tx) => (await tx.query('select app.reply_guard($1) as g', [message.from])).rows[0].g as string | null);
  if (guard) {
    await withoutTenant(deps.pool, (tx) => tx.query(
      "update messages set status = 'processed', processed_at = now(), error = $2 where id = $1 and tenant_id is null and status = 'queued'",
      [p.message_id, `no reply: number ${guard}`]));
    return 'processed';
  }

  const sender = await withoutTenant(deps.pool, (tx) => resolveSender(tx, message.from));

  // Slow reads (AI, media) happen here, outside any transaction, so no connection is held while waiting.
  const prepared = deps.router.prepare
    ? await deps.router.prepare({ sender, message, pool: deps.pool, messageId: p.message_id })
    : undefined;

  const run = async (tx: Tx, tenantId: string | null, userId: string | null) => {
    let replies = await deps.router({ sender, message, tx, messageId: p.message_id, prepared });
    // Loop breaker: more than 8 replies to this number in 3 minutes with nothing confirmed → stop for an hour.
    // A shop's own people get one line saying so; anyone else (another bot) gets nothing.
    if ((await tx.query('select app.reply_loop_check($1, $2) as muted', [message.from, replies.length])).rows[0].muted) {
      replies = sender.kind === 'unknown' ? [] : [{ kind: 'text', text: MUTED_NOTICE }];
    }
    const upd = await tx.query(
      `update messages set tenant_id = $2, user_id = $3, status = 'processed', processed_at = now()
        where id = $1 and tenant_id is null and status = 'queued'`, [p.message_id, tenantId, userId]);
    if (upd.rowCount !== 1) throw new Error('message changed while processing'); // rolls back; retried
    await queueReplies(tx, message.from, tenantId, userId, replies);
  };

  if (sender.kind === 'member') await withTenant(deps.pool, sender.tenantId, (tx) => run(tx, sender.tenantId, sender.userId));
  else await withoutTenant(deps.pool, (tx) => run(tx, null, null));
  return 'processed';
}

export async function processOutbound(deps: EngineDeps, p: OutboundPayload): Promise<'sent' | 'already_done'> {
  const within = <T>(work: (tx: Tx) => Promise<T>) =>
    p.tenant_id ? withTenant(deps.pool, p.tenant_id, work) : withoutTenant(deps.pool, work);

  const found = await within((tx) =>
    tx.query("select payload from messages where id = $1 and direction = 'out' and status = 'pending'", [p.outbound_id]));
  if (!found.rowCount) return 'already_done';

  let waMessageId: string;
  try {
    let msg = found.rows[0].payload as OutboundMessage;
    if (msg.kind === 'document' && !msg.mediaId && msg.fileId) {
      // Stored file → upload to Meta now (media ids expire after 30 days, so never stored)
      if (!deps.documents) throw new Error('documents not configured');
      const file = await within((tx) => tx.query('select path, mime from files where id = $1', [msg.kind === 'document' ? msg.fileId : null]));
      if (!file.rowCount) throw new PermanentError('file not found');
      const bytes = await deps.documents.fileStore.get(file.rows[0].path);
      msg = { ...msg, mediaId: await deps.whatsapp.uploadMedia(bytes, file.rows[0].mime, msg.filename) };
    }
    try {
      ({ waMessageId } = await deps.whatsapp.send(msg));
    } catch (e) {
      // Outside the 24-hour window Meta refuses free text (#131047): send the approved template instead
      if (msg.kind === 'text' && msg.fallbackTemplate && e instanceof WhatsAppSendError && /#131047\b|131047/.test(e.message)) {
        ({ waMessageId } = await deps.whatsapp.send({ kind: 'template', to: msg.to, ...msg.fallbackTemplate }));
      } else {
        throw e;
      }
    }
  } catch (e) {
    if (e instanceof WhatsAppSendError && !e.retryable) {
      await within((tx) => tx.query("update messages set status = 'failed', error = $2 where id = $1", [p.outbound_id, e.message]));
      throw new PermanentError(e.message);
    }
    throw e;
  }
  await within((tx) =>
    tx.query("update messages set wa_message_id = $2, status = 'sent', processed_at = now() where id = $1", [p.outbound_id, waMessageId]));
  return 'sent';
}

/** After the last retry: mark the message and tell the person, so they're never left waiting in silence. */
export async function onInboundParked(deps: EngineDeps, p: InboundPayload, error: string): Promise<void> {
  await withoutTenant(deps.pool, async (tx) => {
    const { rows } = await tx.query(
      "update messages set status = 'parked', error = $2 where id = $1 and tenant_id is null returning phone",
      [p.message_id, error.slice(0, 2000)]);
    if (rows[0]) {
      await queueReplies(tx, rows[0].phone, null, null, [{
        kind: 'text', text: "⚠️ Sorry, I couldn't process your last message. Nothing was saved. Please send it again in a minute."
      }]);
    }
  });
}
