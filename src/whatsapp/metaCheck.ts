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
