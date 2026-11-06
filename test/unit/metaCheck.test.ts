import { describe, expect, it } from 'vitest';
import { checkMeta } from '../../src/whatsapp/metaCheck.js';

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
