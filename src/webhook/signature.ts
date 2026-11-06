/**
 * Meta signs every webhook with the app secret: X-Hub-Signature-256: sha256=<hex HMAC of the raw body>.
 * The check must run on the exact bytes received, before any JSON parsing.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function signBody(rawBody: Buffer | string, appSecret: string): string {
  return 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

export function isValidSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(signBody(rawBody, appSecret));
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
