/**
 * What the webhook does with a verified body, inside one transaction:
 *   - each inbound message is stored once (unique Meta message id); only a newly stored message
 *     gets a job, so a delivery Meta repeats is ignored end to end
 *   - delivery statuses update the matching outbound message
 * No shop is known yet at this point; the worker resolves it.
 */
import type pg from 'pg';
import { withoutTenant } from '../db/tenantTx.js';
import { enqueue } from '../queue/queue.js';
import { NOT_PROCESSED, type InboundMessage, type StatusUpdate } from './parse.js';

export interface IngestResult {
  stored: number;
  duplicates: number;
  queued: number;
  ignored: number;
  statuses: number;
}

export interface IngestOptions {
  phoneNumberId: string;
  botPhone?: string;
}

export async function ingest(pool: pg.Pool, messages: InboundMessage[], statuses: StatusUpdate[], opts: IngestOptions): Promise<IngestResult> {
  const r: IngestResult = { stored: 0, duplicates: 0, queued: 0, ignored: 0, statuses: 0 };

  await withoutTenant(pool, async (tx) => {
    for (const m of messages) {
      // Only our number; never our own messages (self-reply loop guard).
      if (m.phoneNumberId !== opts.phoneNumberId || (opts.botPhone && m.from === opts.botPhone)) { r.ignored++; continue; }

      const ins = await tx.query(
        `insert into messages (wa_message_id, direction, phone, msg_type, payload, status)
         values ($1, 'in', $2, $3, $4, $5)
         on conflict (wa_message_id) do nothing
         returning id`,
        [m.waMessageId, m.from, m.kind, JSON.stringify(m), NOT_PROCESSED.has(m.kind) ? 'processed' : 'queued']);
      if (!ins.rowCount) { r.duplicates++; continue; }
      r.stored++;
      if (NOT_PROCESSED.has(m.kind)) continue;
      await enqueue(tx, m.from, { message_id: ins.rows[0].id });
      r.queued++;
    }

    for (const s of statuses) {
      // Statuses can arrive out of order (read before delivered); the function never moves backwards.
      const upd = await tx.query('select app.apply_message_status($1, $2, $3) as ok', [s.waMessageId, s.status, s.error ?? null]);
      if (upd.rows[0].ok) r.statuses++;
    }
  });
  return r;
}
