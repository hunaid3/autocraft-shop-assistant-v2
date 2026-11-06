/**
 * Razorpay payment links. The engine creates a link when the owner picks a pack; Razorpay calls our
 * webhook when it is paid, and app.apply_payment adds the credits exactly once.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PaymentLink { id: string; url: string }
export interface CreateLink {
  amountPaise: number; referenceId: string; description: string; customerName: string; contact: string;
  expireBy: number; notes: Record<string, string>;
}
export interface PaymentGateway { createLink(l: CreateLink): Promise<PaymentLink> }

export class RazorpayError extends Error {}

export class RazorpayClient implements PaymentGateway {
  constructor(private readonly opts: { keyId: string; keySecret: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {}
  async createLink(l: CreateLink): Promise<PaymentLink> {
    const res = await (this.opts.fetchImpl ?? fetch)('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(`${this.opts.keyId}:${this.opts.keySecret}`).toString('base64'),
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        amount: l.amountPaise, currency: 'INR', accept_partial: false, expire_by: l.expireBy,
        reference_id: l.referenceId, description: l.description.slice(0, 2048),
        customer: { name: l.customerName.slice(0, 100), contact: '+' + l.contact },
        notify: { sms: false, email: false }, reminder_enable: false, notes: l.notes
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000)
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; short_url?: string; error?: { description?: string } };
    if (!res.ok || !body.id || !body.short_url) throw new RazorpayError(`Razorpay ${res.status}: ${body.error?.description ?? 'no link returned'}`);
    return { id: body.id, url: body.short_url };
  }
}

/** X-Razorpay-Signature = hex HMAC-SHA256 of the raw body with the webhook secret. */
export function isValidRazorpaySignature(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const want = createHmac('sha256', secret).update(raw).digest();
  const got = Buffer.from(signature, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Test double: links are recorded; tests "pay" them by posting a signed webhook. */
export class FakeGateway implements PaymentGateway {
  readonly links: Array<CreateLink & PaymentLink> = [];
  failNext = 0;
  async createLink(l: CreateLink): Promise<PaymentLink> {
    if (this.failNext > 0) { this.failNext--; throw new RazorpayError('Razorpay 503: simulated'); }
    const link = { id: `plink_${l.referenceId.slice(0, 14)}`, url: `https://rzp.io/rzp/${l.referenceId.slice(0, 8)}` };
    this.links.push({ ...l, ...link });
    return link;
  }
}
