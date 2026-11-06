/**
 * Sending to WhatsApp. The engine only ever talks to the WhatsAppClient interface, so tests and
 * the simulator use RecordingClient and never reach Meta.
 */

export type OutboundMessage =
  | { kind: 'text'; to: string; text: string }
  | { kind: 'buttons'; to: string; text: string; buttons: Array<{ id: string; title: string }> }
  // A stored file (fileId) is uploaded to Meta at send time, which turns it into a mediaId.
  | { kind: 'document'; to: string; caption?: string; filename: string; mediaId?: string; fileId?: string };

export interface SendResult { waMessageId: string }

export interface WhatsAppClient {
  send(msg: OutboundMessage): Promise<SendResult>;
  /** Upload a file to Meta (kept 30 days) and get the media id to send it with. */
  uploadMedia(bytes: Buffer, mime: string, filename: string): Promise<string>;
  /** Fetch a file someone sent us (bill photo, PDF). Refuses anything over maxBytes. */
  downloadMedia(mediaId: string, maxBytes?: number): Promise<{ bytes: Buffer; mime: string }>;
}

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

export class MediaTooLargeError extends Error {}

export class WhatsAppSendError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) { super(message); }
}

/** WhatsApp limits: body 1024 chars with buttons (4096 without), max 3 buttons, title 20 chars. */
export function toCloudApiBody(msg: OutboundMessage): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: msg.to };
  switch (msg.kind) {
    case 'text':
      return { ...base, type: 'text', text: { preview_url: false, body: msg.text.slice(0, 4096) } };
    case 'buttons':
      return {
        ...base, type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: msg.text.slice(0, 1024) },
          action: { buttons: msg.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })) }
        }
      };
    case 'document':
      if (!msg.mediaId) throw new Error('document has no mediaId: upload it first');
      return { ...base, type: 'document', document: { id: msg.mediaId, filename: msg.filename, caption: msg.caption?.slice(0, 1024) } };
  }
}

export class CloudApiClient implements WhatsAppClient {
  constructor(private readonly opts: { accessToken: string; phoneNumberId: string; graphVersion: string; timeoutMs?: number }) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    const url = `https://graph.facebook.com/${this.opts.graphVersion}/${this.opts.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(toCloudApiBody(msg)),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000)
    });
    const body = (await res.json().catch(() => ({}))) as { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } };
    if (!res.ok || !body.messages?.[0]?.id) {
      // 429 and 5xx are worth retrying; 4xx (bad number, expired token, outside 24h window) are not.
      const retryable = res.status === 429 || res.status >= 500;
      throw new WhatsAppSendError(`WhatsApp send failed (${res.status}): ${body.error?.message ?? 'no message id'}`, res.status, retryable);
    }
    return { waMessageId: body.messages[0].id };
  }

  async uploadMedia(bytes: Buffer, mime: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    const res = await fetch(`https://graph.facebook.com/${this.opts.graphVersion}/${this.opts.phoneNumberId}/media`, {
      method: 'POST', headers: { authorization: `Bearer ${this.opts.accessToken}` }, body: form,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000)
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!res.ok || !body.id) {
      throw new WhatsAppSendError(`WhatsApp media upload failed (${res.status}): ${body.error?.message ?? 'no media id'}`, res.status, res.status === 429 || res.status >= 500);
    }
    return body.id;
  }

  async downloadMedia(mediaId: string, maxBytes = MAX_MEDIA_BYTES): Promise<{ bytes: Buffer; mime: string }> {
    const auth = { authorization: `Bearer ${this.opts.accessToken}` };
    const meta = await fetch(`https://graph.facebook.com/${this.opts.graphVersion}/${encodeURIComponent(mediaId)}`, {
      headers: auth, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000)
    });
    const info = (await meta.json().catch(() => ({}))) as { url?: string; mime_type?: string; file_size?: number; error?: { message?: string } };
    if (!meta.ok || !info.url) {
      throw new WhatsAppSendError(`WhatsApp media lookup failed (${meta.status}): ${info.error?.message ?? 'no url'}`, meta.status, meta.status === 429 || meta.status >= 500);
    }
    if (info.file_size && info.file_size > maxBytes) throw new MediaTooLargeError(`file is ${info.file_size} bytes`);
    const url = new URL(info.url);
    if (url.protocol !== 'https:' || !/(^|\.)(fbsbx\.com|facebook\.com|whatsapp\.net)$/.test(url.hostname)) {
      throw new WhatsAppSendError('media url is not a Meta host', 400, false);   // never fetch an arbitrary address
    }
    const res = await fetch(url, { headers: auth, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000) });
    if (!res.ok) throw new WhatsAppSendError(`WhatsApp media download failed (${res.status})`, res.status, res.status === 429 || res.status >= 500);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new MediaTooLargeError(`file is ${bytes.length} bytes`);
    return { bytes, mime: info.mime_type ?? res.headers.get('content-type') ?? 'application/octet-stream' };
  }
}

/** For tests and the simulator: records every send, optionally failing on demand. */
export class RecordingClient implements WhatsAppClient {
  readonly sent: OutboundMessage[] = [];
  readonly uploads: Array<{ bytes: Buffer; mime: string; filename: string; mediaId: string }> = [];
  private n = 0;
  failNext = 0;

  async uploadMedia(bytes: Buffer, mime: string, filename: string): Promise<string> {
    const mediaId = `media.${++this.n}`;
    this.uploads.push({ bytes, mime, filename, mediaId });
    return mediaId;
  }

  /** Files people "sent", by media id (tests put them here). */
  readonly incoming = new Map<string, { bytes: Buffer; mime: string }>();
  async downloadMedia(mediaId: string, maxBytes = MAX_MEDIA_BYTES): Promise<{ bytes: Buffer; mime: string }> {
    const f = this.incoming.get(mediaId);
    if (!f) throw new WhatsAppSendError('unknown media', 404, false);
    if (f.bytes.length > maxBytes) throw new MediaTooLargeError(`file is ${f.bytes.length} bytes`);
    return f;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new WhatsAppSendError('simulated failure', 503, true);
    }
    this.sent.push(msg);
    return { waMessageId: `wamid.out.${process.pid}.${++this.n}.${Date.now()}` };
  }
}
