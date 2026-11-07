import { describe, expect, it } from 'vitest';
import { isValidSignature, signBody } from '../../src/webhook/signature.js';
import { parseWebhook } from '../../src/webhook/parse.js';
import { toCloudApiBody } from '../../src/whatsapp/client.js';
import { buttonReply, image, payload, status, text } from '../fixtures/meta.js';

describe('signature', () => {
  const body = Buffer.from('{"a":1}');
  it('accepts the exact HMAC of the raw body', () => {
    expect(isValidSignature(body, signBody(body, 's3cret'), 's3cret')).toBe(true);
  });
  it.each([
    ['missing header', undefined],
    ['wrong secret', signBody(body, 'other')],
    ['no prefix', signBody(body, 's3cret').slice(7)],
    ['truncated', signBody(body, 's3cret').slice(0, 20)]
  ])('rejects %s', (_, header) => expect(isValidSignature(body, header, 's3cret')).toBe(false));
  it('rejects a body changed after signing (even just whitespace)', () => {
    expect(isValidSignature(Buffer.from('{"a": 1}'), signBody(body, 's3cret'), 's3cret')).toBe(false);
  });
});

describe('parseWebhook', () => {
  it('reads text, button taps, images and the sender name', () => {
    const p = payload({
      contacts: [{ wa_id: '919876543210', profile: { name: 'Ravi' } }],
      messages: [
        text('919876543210', 'bill Ravi 10 airdopes at 1250', 'wamid.1'),
        buttonReply('919876543210', 'CONFIRM', '✅ Confirm', 'wamid.2'),
        image('919876543210', 'MEDIA1', 'bill from sharma', 'wamid.3')
      ]
    });
    const { messages } = parseWebhook(p);
    expect(messages.map((m) => [m.waMessageId, m.kind, m.text, m.buttonId])).toEqual([
      ['wamid.1', 'text', 'bill Ravi 10 airdopes at 1250', undefined],
      ['wamid.2', 'button', '✅ Confirm', 'CONFIRM'],
      ['wamid.3', 'image', 'bill from sharma', undefined]
    ]);
    expect(messages[0]!.profileName).toBe('Ravi');
    expect(messages[2]!.media).toMatchObject({ id: 'MEDIA1', mimeType: 'image/jpeg' });
    expect(messages[0]!.phoneNumberId).toBe('100000000000001');
  });

  it('reads template quick replies and quoted messages', () => {
    const { messages } = parseWebhook(payload({ messages: [
      { from: '919876543210', id: 'wamid.q', timestamp: '1', type: 'button', button: { payload: 'RECHARGE_999', text: 'Recharge' }, context: { id: 'wamid.orig' } }
    ] }));
    expect(messages[0]).toMatchObject({ kind: 'button', buttonId: 'RECHARGE_999', replyToWaId: 'wamid.orig' });
  });

  it('reads statuses, including errors, and an empty statuses array is fine', () => {
    const { statuses } = parseWebhook(payload({ statuses: [
      status('wamid.out1', 'delivered'),
      { ...status('wamid.out2', 'failed'), errors: [{ code: 131047, title: 'Re-engagement message' }] }
    ] }));
    expect(statuses.map((s) => [s.waMessageId, s.status, s.error])).toEqual([
      ['wamid.out1', 'delivered', undefined], ['wamid.out2', 'failed', '131047 Re-engagement message']
    ]);
    expect(parseWebhook(payload({})).statuses).toEqual([]);
  });

  it('skips junk without dropping the good messages next to it', () => {
    const { messages } = parseWebhook(payload({ messages: [
      null, 'x', { id: 'no-from' }, { from: 'not-a-number', id: 'w1', type: 'text' },
      text('919876543210', 'ok', 'wamid.good'),
      { from: '919876543210', id: 'wamid.voice', timestamp: '1', type: 'audio', audio: { id: 'A1' } },
      { from: '919876543210', id: 'wamid.new', timestamp: '1', type: 'some_future_type' }
    ] }));
    expect(messages.map((m) => [m.waMessageId, m.kind])).toEqual([
      ['wamid.good', 'text'], ['wamid.voice', 'audio'], ['wamid.new', 'unsupported']
    ]);
  });

  it('ignores bodies that are not WhatsApp business webhooks', () => {
    expect(parseWebhook({ object: 'page', entry: [] })).toEqual({ messages: [], statuses: [] });
    expect(parseWebhook(null)).toEqual({ messages: [], statuses: [] });
  });
});

describe('outbound body', () => {
  it('builds reply buttons within WhatsApp limits', () => {
    const body = toCloudApiBody({ kind: 'buttons', to: '919876543210', text: 'x'.repeat(2000),
      buttons: [1, 2, 3, 4].map((i) => ({ id: 'B' + i, title: 'A very long button title ' + i })) });
    const action = (body.interactive as { action: { buttons: Array<{ reply: { title: string } }> } }).action;
    expect(action.buttons).toHaveLength(3);
    expect(action.buttons.every((b) => b.reply.title.length <= 20)).toBe(true);
    expect(((body.interactive as { body: { text: string } }).body.text).length).toBe(1024);
  });

  it('sends a picture by its public link, with the caption cut to 1024', () => {
    const body = toCloudApiBody({ kind: 'image', to: '919876543210', link: 'https://app.example.test/p.jpg', caption: 'y'.repeat(1500) });
    expect(body.type).toBe('image');
    expect((body.image as { link: string; caption: string }).link).toBe('https://app.example.test/p.jpg');
    expect((body.image as { caption: string }).caption).toHaveLength(1024);
  });
});
