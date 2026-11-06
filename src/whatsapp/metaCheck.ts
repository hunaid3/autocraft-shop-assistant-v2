/**
 * Start-up check of the WhatsApp connection: is the token accepted, which number is this, is it
 * registered on the Cloud API, and what does Meta say about its name and quality. Logs facts only,
 * never the token. A failure is logged, not fatal: the webhook keeps receiving and replies retry.
 */
export interface MetaCheck { ok: boolean; detail: Record<string, unknown> }

export async function checkMeta(opts: { accessToken: string; phoneNumberId: string; graphVersion: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<MetaCheck> {
  const f = opts.fetchImpl ?? fetch;
  const fields = 'display_phone_number,verified_name,name_status,quality_rating,messaging_limit_tier,platform_type,status,code_verification_status';
  try {
    const res = await f(`https://graph.facebook.com/${opts.graphVersion}/${encodeURIComponent(opts.phoneNumberId)}?fields=${fields}`, {
      headers: { authorization: `Bearer ${opts.accessToken}` }, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000)
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string; code?: number; type?: string } };
    if (!res.ok) return { ok: false, detail: { http: res.status, code: body.error?.code, type: body.error?.type, message: body.error?.message?.slice(0, 200) } };
    const detail: Record<string, unknown> = { ...body };
    delete detail.id;
    return { ok: true, detail };
  } catch (e) {
    return { ok: false, detail: { error: (e as Error).name } };
  }
}

/**
 * Makes sure each WhatsApp Business Account this token manages sends its webhooks to our app
 * (POST /{waba}/subscribed_apps). Without it Meta verifies the webhook but never delivers messages.
 * The accounts are found from the token itself (debug_token's granular scopes). Idempotent.
 */
export async function ensureSubscribed(opts: {
  accessToken: string; appId: string; appSecret: string; graphVersion: string; wabaIds?: string[]; fetchImpl?: typeof fetch;
}): Promise<Array<{ waba: string; result: 'already' | 'subscribed' | 'failed'; detail?: unknown }>> {
  const f = opts.fetchImpl ?? fetch;
  const g = `https://graph.facebook.com/${opts.graphVersion}`;
  const auth = { authorization: `Bearer ${opts.accessToken}` };
  let wabas = opts.wabaIds ?? [];
  if (!wabas.length) {
    const appToken = encodeURIComponent(`${opts.appId}|${opts.appSecret}`);
    const r = await f(`${g}/debug_token?input_token=${encodeURIComponent(opts.accessToken)}&access_token=${appToken}`, { signal: AbortSignal.timeout(10_000) });
    const body = (await r.json().catch(() => ({}))) as { data?: { app_id?: string; granular_scopes?: Array<{ scope: string; target_ids?: string[] }> } };
    if (body.data?.app_id && body.data.app_id !== opts.appId) return [{ waba: '-', result: 'failed', detail: 'token belongs to a different app' }];
    wabas = [...new Set((body.data?.granular_scopes ?? [])
      .filter((s) => s.scope === 'whatsapp_business_management' || s.scope === 'whatsapp_business_messaging')
      .flatMap((s) => s.target_ids ?? []))];
    if (!wabas.length) return [{ waba: '-', result: 'failed', detail: 'no WhatsApp account found in the token scopes' }];
  }
  const out: Array<{ waba: string; result: 'already' | 'subscribed' | 'failed'; detail?: unknown }> = [];
  for (const waba of wabas) {
    try {
      const cur = (await (await f(`${g}/${waba}/subscribed_apps`, { headers: auth, signal: AbortSignal.timeout(10_000) })).json()) as
        { data?: Array<{ whatsapp_business_api_data?: { id?: string } }>; error?: { message?: string } };
      if (cur.data?.some((a) => a.whatsapp_business_api_data?.id === opts.appId)) { out.push({ waba, result: 'already' }); continue; }
      const res = await f(`${g}/${waba}/subscribed_apps`, { method: 'POST', headers: auth, signal: AbortSignal.timeout(10_000) });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { message?: string; code?: number } };
      out.push(body.success ? { waba, result: 'subscribed' } : { waba, result: 'failed', detail: { http: res.status, code: body.error?.code, message: body.error?.message?.slice(0, 200) } });
    } catch (e) {
      out.push({ waba, result: 'failed', detail: (e as Error).name });
    }
  }
  return out;
}
