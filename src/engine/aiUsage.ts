/** Records each AI call's token counts against the shop, for the admin console's usage and cost view. Best effort. */
import type pg from 'pg';
import { withTenant } from '../db/tenantTx.js';
import type { AiUsage } from './aiParser.js';

export function aiUsageRecorder(pool: pg.Pool, log: (e: unknown) => void = () => {}) {
  return (u: AiUsage): void => {
    if (!u.tenantId) return;
    withTenant(pool, u.tenantId, (tx) => tx.query(
      'insert into ai_usage (tenant_id, kind, model, prompt_tokens, completion_tokens) values ($1, $2, $3, $4, $5)',
      [u.tenantId, u.kind, u.model, u.promptTokens, u.completionTokens])).catch(log);
  };
}
