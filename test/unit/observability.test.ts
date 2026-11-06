import { describe, expect, it } from 'vitest';
import type { ErrorEvent } from '@sentry/node';
import { scrubEvent, scrubText } from '../../src/observability.js';

describe('scrubText', () => {
  it('removes phone numbers, emails, GSTINs and amounts', () => {
    expect(scrubText('send failed for 919876543210 (+919000000001)')).toBe('send failed for [phone] ([phone])');
    expect(scrubText('owner ravi.k@gmail.com')).toBe('owner [email]');
    expect(scrubText('GSTIN 36AABCU9603R1ZM rejected')).toBe('GSTIN [gstin] rejected');
    expect(scrubText('total ₹1,47,600 and Rs. 250.50 and INR 99')).toBe('total [amount] and [amount] and [amount]');
  });
  it('leaves ids and ordinary error text alone', () => {
    expect(scrubText('job 42 failed: router exploded')).toBe('job 42 failed: router exploded');
    expect(scrubText('tenant 3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90')).toBe('tenant 3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90');
  });
});

describe('scrubEvent', () => {
  it('keeps what an engineer needs and drops all shop data', () => {
    const event = {
      type: undefined,
      message: 'parked for 919876543210',
      request: { url: 'https://x/webhook', data: '{"text":"bill Ravi 10 airdopes"}', headers: { 'x-hub-signature-256': 'sha256=..' } },
      user: { id: 'u1', ip_address: '1.2.3.4' },
      breadcrumbs: [{ message: 'select * from items where name = $1', data: { params: ['Airdopes'] } }],
      exception: { values: [{ type: 'Error', value: 'WhatsApp send failed for 919876543210',
        stacktrace: { frames: [{ function: 'processOutbound', vars: { body: 'bill Ravi 10 airdopes at 1250' } }] } }] },
      extra: { job_id: '42', tenant_id: 'abc', message_text: 'bill Ravi', phone: '919876543210', attempt: '3' },
      contexts: { runtime: { name: 'node' }, payload: { text: 'secret' } }
    } as unknown as ErrorEvent;

    const out = scrubEvent(event);
    expect(out.request).toBeUndefined();
    expect(out.user).toBeUndefined();
    expect(out.breadcrumbs).toEqual([]);
    expect(out.message).toBe('parked for [phone]');
    expect(out.exception!.values![0]!.value).toBe('WhatsApp send failed for [phone]');
    expect(out.exception!.values![0]!.stacktrace!.frames![0]).toEqual({ function: 'processOutbound' });
    expect(out.extra).toEqual({ job_id: '42', tenant_id: 'abc', attempt: '3' });
    expect(out.contexts).toEqual({ runtime: { name: 'node' } });
    expect(JSON.stringify(out)).not.toMatch(/airdopes|Ravi|9876543210|1\.2\.3\.4/i);
  });
});
