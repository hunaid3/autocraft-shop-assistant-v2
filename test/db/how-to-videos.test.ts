/**
 * How-to videos: the welcome card carries the onboarding video; the ready message offers the first-bill
 * video; *videos* lists the chapters; help topics add their chapter's link.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/webhook/server.js';
import { startWorker, type Worker } from '../../src/queue/worker.js';
import { RecordingClient, toCloudApiBody, type OutboundMessage } from '../../src/whatsapp/client.js';
import { shopRouter } from '../../src/engine/shopRouter.js';
import { SimpleParser } from '../../src/engine/parse.js';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, payload, signed, text } from '../fixtures/meta.js';
import { admin, engine, randomPhone } from './helpers.js';

const wa = new RecordingClient();
let app: FastifyInstance;
let worker: Worker;

beforeAll(async () => {
  app = buildServer({ pool: engine, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, phoneNumberId: PHONE_NUMBER_ID, logLevel: 'silent' });
  worker = startWorker({ pool: engine, whatsapp: wa, router: shopRouter(new SimpleParser()) },
    { workerId: 'videos', concurrency: 2, idleMs: 10, backoffSeconds: 0, log: { info() {}, warn() {}, error() {} } });
});
afterAll(async () => { await worker.stop(); await app.close(); await engine.end(); await admin.end(); });

async function send(from: string, m: unknown): Promise<OutboundMessage[]> {
  const before = wa.sent.length;
  await app.inject({ method: 'POST', url: '/webhook', ...signed(payload({ messages: [m] })) });
  await worker.drained();
  return wa.sent.slice(before).filter((r) => r.to === from);
}
const tap = (p: string, id: string) => send(p, { from: p, id: 'wamid.' + Math.random(), timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: id } } });
const pick = (p: string, id: string) => send(p, { from: p, id: 'wamid.' + Math.random(), timestamp: '1', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: id } } });

describe('how-to videos', () => {
  const P = randomPhone();

  it('the welcome card plays the onboarding video above the usual text and buttons', async () => {
    const [card] = await send(P, text(P, 'Hi'));
    expect(card).toMatchObject({ kind: 'buttons', header: { video: 'https://app.autocraft-solutions.com/media/how-to-start.mp4' } });
    expect((card as { text: string }).text).toContain('Welcome to *AutoCraft Shop Assistant*');
    const body = toCloudApiBody(card!) as { interactive: { header: unknown; action: { buttons: unknown[] } } };
    expect(body.interactive.header).toEqual({ type: 'video', video: { link: 'https://app.autocraft-solutions.com/media/how-to-start.mp4' } });
    expect(body.interactive.action.buttons).toHaveLength(2);
  });

  it('after sign-up, a one-tap card for the first-bill video', async () => {
    await tap(P, 'START'); await send(P, text(P, 'Video Test Mobiles')); await tap(P, 'SKIP'); await send(P, text(P, 'Telangana')); await tap(P, 'SKIP');
    const done = await send(P, text(P, 'yes'));
    const link = done.find((m) => m.kind === 'link') as Extract<OutboundMessage, { kind: 'link' }>;
    expect(link).toMatchObject({ button: '▶️ Watch now', url: 'https://youtu.be/BP9aeg2uR00' });
    expect(toCloudApiBody(link)).toMatchObject({ type: 'interactive', interactive: { type: 'cta_url', action: { name: 'cta_url', parameters: { display_text: '▶️ Watch now', url: 'https://youtu.be/BP9aeg2uR00' } } } });
  });

  it('*videos* lists the chapters that have a link; picking one sends it', async () => {
    const [menu] = await send(P, text(P, 'videos'));
    const rows = (menu as Extract<OutboundMessage, { kind: 'list' }>).rows;
    expect(rows.map((r) => r.id)).toEqual(['VIDEO:1', 'VIDEO:2', 'VIDEO:3', 'VIDEO:4', 'VIDEO:5', 'VIDEO:6', 'VIDEO:7', 'VIDEO:8', 'VIDEO:9']);
    const [v] = await pick(P, 'VIDEO:7');
    expect(v).toMatchObject({ kind: 'link', url: 'https://youtu.be/RuSfDWINA8o' });
    expect((v as { text: string }).text).toContain('Staff');
  });

  it('help topics bring their chapter, and the menu has a videos row', async () => {
    const help = await send(P, text(P, 'help'));
    expect((help[0] as Extract<OutboundMessage, { kind: 'list' }>).rows.map((r) => r.id)).toContain('HELP:videos');
    const staff = await tap(P, 'HELP:staff');
    expect(staff.map((m) => m.kind)).toEqual(['buttons', 'link']);
    expect(staff[1]).toMatchObject({ url: 'https://youtu.be/RuSfDWINA8o' });
  });

  it('a chapter without a link yet falls back to the list; no setting → no video, nothing breaks', async () => {
    const [v] = await pick(P, 'VIDEO:10');
    expect(v!.kind).toBe('list');
    const old = (await admin.query("select value from platform_settings where key = 'how_to_videos'")).rows[0].value;
    await admin.query("update platform_settings set value = '{}'::jsonb where key = 'how_to_videos'");
    try {
      const Q = randomPhone();
      const [card] = await send(Q, text(Q, 'Hi'));
      expect(card).not.toHaveProperty('header');
      expect((await send(P, text(P, 'videos')))[0]).toMatchObject({ kind: 'text' });
    } finally {
      await admin.query("update platform_settings set value = $1 where key = 'how_to_videos'", [JSON.stringify(old)]);
    }
  });
});
