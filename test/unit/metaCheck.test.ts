import { describe, expect, it } from 'vitest';
import { checkMeta, ensureSubscribed } from '../../src/whatsapp/metaCheck.js';

const fake = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('start-up Meta check', () => {
  it('reports what Meta says about the number', async () => {
    const r = await checkMeta({ accessToken: 'EAAtest', phoneNumberId: '123', graphVersion: 'v23.0',
      fetchImpl: fake(200, { id: '123', display_phone_number: '+91 70135 39950', verified_name: 'AutoCraft', platform_type: 'CLOUD_API' }) });
    expect(r).toEqual({ ok: true, detail: { display_phone_number: '+91 70135 39950', verified_name: 'AutoCraft', platform_type: 'CLOUD_API' } });
  });
  it('reports a refused token without the token', async () => {
    const r = await checkMeta({ accessToken: 'EAAsecretvalue', phoneNumberId: '123', graphVersion: 'v23.0',
      fetchImpl: fake(401, { error: { message: 'Invalid OAuth access token', code: 190, type: 'OAuthException' } }) });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('EAAsecretvalue');
    expect(r.detail).toMatchObject({ http: 401, code: 190 });
  });
});

describe('webhook subscription of the WhatsApp account', () => {
  const routes = (map: Record<string, unknown>, calls: string[]) => (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname.replace('/v23.0', '')}`;
    calls.push(key);
    return new Response(JSON.stringify(map[key] ?? {}), { status: 200 });
  }) as unknown as typeof fetch;

  it('finds the account from the token and subscribes our app when missing', async () => {
    const calls: string[] = [];
    const f = routes({
      'GET /debug_token': { data: { app_id: '154', granular_scopes: [{ scope: 'whatsapp_business_messaging', target_ids: ['W1'] }, { scope: 'whatsapp_business_management', target_ids: ['W1'] }] } },
      'GET /W1/subscribed_apps': { data: [{ whatsapp_business_api_data: { id: '999' } }] },
      'POST /W1/subscribed_apps': { success: true }
    }, calls);
    const r = await ensureSubscribed({ accessToken: 't', appId: '154', appSecret: 's', graphVersion: 'v23.0', fetchImpl: f });
    expect(r).toEqual([{ waba: 'W1', result: 'subscribed' }]);
    expect(calls).toEqual(['GET /debug_token', 'GET /W1/subscribed_apps', 'POST /W1/subscribed_apps']);
  });

  it('does nothing when already subscribed', async () => {
    const calls: string[] = [];
    const f = routes({ 'GET /W1/subscribed_apps': { data: [{ whatsapp_business_api_data: { id: '154' } }] } }, calls);
    expect(await ensureSubscribed({ accessToken: 't', appId: '154', appSecret: 's', graphVersion: 'v23.0', wabaIds: ['W1'], fetchImpl: f }))
      .toEqual([{ waba: 'W1', result: 'already' }]);
    expect(calls).not.toContain('POST /W1/subscribed_apps');
  });

  it('refuses a token from another app', async () => {
    const f = routes({ 'GET /debug_token': { data: { app_id: '878' } } }, []);
    expect((await ensureSubscribed({ accessToken: 't', appId: '154', appSecret: 's', graphVersion: 'v23.0', fetchImpl: f }))[0]!.result).toBe('failed');
  });
});
