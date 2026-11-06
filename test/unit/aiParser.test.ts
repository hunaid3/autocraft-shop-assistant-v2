import { describe, expect, it } from 'vitest';
import { AiUnavailableError, JSON_SCHEMA, OpenAiParser, systemPrompt } from '../../src/engine/aiParser.js';

const ctx = { today: '2026-11-06', catalog: ['boAt Airdopes 141', 'USB-C Cable', 'cable'] };

const blank = {
  type: 'unknown', party_name: null, party_gstin: null, party_phone: null, lines: [], bill_no: null,
  expense_amount_rupees: null, expense_category: null, expense_mode: null, expense_paid_to: null,
  report: null, report_item: null, period: null, clarification: null
};
const line = (o: object) => ({ name: '', qty: '1', unit: null, rate_rupees: null, discount_rupees: null, gst_rate: null, ...o });

/** A fake OpenAI that returns `content` and records what it was sent. */
function fakeOpenAi(content: unknown, status = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    if (status !== 200) return new Response('{"error":{"message":"overloaded"}}', { status });
    return new Response(JSON.stringify({
      choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
      usage: { prompt_tokens: 1400, completion_tokens: 60 }
    }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('OpenAiParser', () => {
  it('turns a Hinglish bill into an invoice intent in paise', async () => {
    const { f, calls } = fakeOpenAi({ ...blank, type: 'invoice', party_name: 'Ravi', lines: [line({ name: 'boAt Airdopes 141', qty: '10', rate_rupees: 1250 }), line({ name: 'USB-C Cable', qty: '2', rate_rupees: 199.5 })] });
    const usage: unknown[] = [];
    const p = new OpenAiParser({ apiKey: 'sk-test', fetchImpl: f, onUsage: (u) => usage.push(u) });
    expect(await p.parse('ravi ko 10 airdops 1250 wale aur 2 cable 199.5 ka bill bana do', ctx)).toEqual({
      type: 'invoice', party: { name: 'Ravi', gstin: undefined, phone: undefined },
      lines: [
        { name: 'boAt Airdopes 141', qty: '10', unit: undefined, ratePaise: 125000, discountPaise: undefined, gstRate: undefined },
        { name: 'USB-C Cable', qty: '2', unit: undefined, ratePaise: 19950, discountPaise: undefined, gstRate: undefined }
      ]
    });
    expect(usage).toEqual([{ promptTokens: 1400, completionTokens: 60, model: 'gpt-6-luna' }]);

    const req = calls[0]!;
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-test');
    expect(req.body).toMatchObject({ model: 'gpt-6-luna', reasoning_effort: 'none', temperature: 0 });
    expect(req.body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'shop_intent', strict: true } });
    const [sys, user] = req.body.messages as Array<{ role: string; content: string }>;
    expect(sys!.content).toContain('Today is 2026-11-06');
    expect(sys!.content).toContain('Shop items: boAt Airdopes 141; USB-C Cable; cable');
    expect(sys!.content).toContain('Never invent numbers');
    expect(user).toEqual({ role: 'user', content: 'ravi ko 10 airdops 1250 wale aur 2 cable 199.5 ka bill bana do' });
  });

  it('expense, purchase, query and confirm', async () => {
    const cases: Array<[object, object]> = [
      [{ ...blank, type: 'expense', expense_amount_rupees: 3500, expense_category: 'Shop Rent', expense_mode: 'upi' },
        { type: 'expense', amountPaise: 350000, category: 'Shop Rent', mode: 'upi', paidTo: undefined }],
      [{ ...blank, type: 'purchase', party_name: 'Sharma Traders', bill_no: '4471', lines: [line({ name: 'boAt Airdopes 141', qty: '50', rate_rupees: 850 })] },
        { type: 'purchase', billNo: '4471', party: { name: 'Sharma Traders' } }],
      [{ ...blank, type: 'query', report: 'sales_period', period: 'this_month' }, { type: 'query', report: 'sales_period', period: 'this_month' }],
      [{ ...blank, type: 'query', report: 'sales_period' }, { type: 'query', report: 'sales_period', period: 'today' }],
      [{ ...blank, type: 'confirm' }, { type: 'confirm' }]
    ];
    for (const [out, want] of cases) {
      const p = new OpenAiParser({ apiKey: 'k', fetchImpl: fakeOpenAi(out).f });
      expect(await p.parse('…', ctx)).toMatchObject(want);
    }
  });

  it('a missing detail becomes a question, not a guess', async () => {
    const p = new OpenAiParser({ apiKey: 'k', fetchImpl: fakeOpenAi({ ...blank, clarification: 'Which customer is this bill for?' }).f });
    expect(await p.parse('bill karo', ctx)).toEqual({ type: 'unknown', hint: 'Which customer is this bill for?' });
  });

  it('negative or impossible numbers are dropped, and a non-numeric qty falls back to the simple reader', async () => {
    const neg = new OpenAiParser({ apiKey: 'k', fetchImpl: fakeOpenAi({ ...blank, type: 'invoice', lines: [line({ name: 'X', qty: '1', rate_rupees: -5 })] }).f });
    expect(await neg.parse('…', ctx)).toMatchObject({ lines: [{ ratePaise: undefined }] });
    const words = new OpenAiParser({ apiKey: 'k', fetchImpl: fakeOpenAi({ ...blank, type: 'invoice', lines: [line({ name: 'X', qty: 'ten' })] }).f });
    expect(await words.parse('bill 10 cables at 199', ctx)).toMatchObject({ type: 'invoice', lines: [{ name: 'cables', qty: '10', ratePaise: 19900 }] });
  });

  it('OpenAI down: uses the simple reader when it understood', async () => {
    const p = new OpenAiParser({ apiKey: 'k', fetchImpl: fakeOpenAi(null, 503).f });
    expect(await p.parse('bill Ravi 10 airdopes at 1250', ctx)).toMatchObject({ type: 'invoice', party: { name: 'Ravi' } });
  });

  it('OpenAI down and the message needs AI: the job is retried later', async () => {
    const p = new OpenAiParser({ apiKey: 'k', fetchImpl: fakeOpenAi(null, 503).f });
    await expect(p.parse('ravi ko das airdops de do', ctx)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('a timeout counts as down', async () => {
    const slow = (async (_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('timeout', 'TimeoutError'))))) as unknown as typeof fetch;
    const p = new OpenAiParser({ apiKey: 'k', fetchImpl: slow, timeoutMs: 50 });
    await expect(p.parse('kuch bhi', ctx)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('malformed model output never reaches the engine', async () => {
    for (const bad of ['not json', { type: 'invoice' }, { ...blank, type: 'delete_everything' }]) {
      const p = new OpenAiParser({ apiKey: 'k', fetchImpl: fakeOpenAi(bad).f });
      await expect(p.parse('ravi ko das airdops de do', ctx)).rejects.toBeInstanceOf(AiUnavailableError);
      expect(await p.parse('paid 100 tea cash', ctx)).toMatchObject({ type: 'expense', amountPaise: 10000 });
    }
  });

  it('long messages and catalogues are capped', async () => {
    const big = { today: '2026-11-06', catalog: Array.from({ length: 1000 }, (_, i) => `Item ${i}`) };
    expect(systemPrompt(big, 400)).toContain('Item 399');
    expect(systemPrompt(big, 400)).not.toContain('Item 400');
    const { f, calls } = fakeOpenAi({ ...blank, type: 'help' });
    await new OpenAiParser({ apiKey: 'k', fetchImpl: f }).parse('x'.repeat(5000), ctx);
    expect(((calls[0]!.body.messages as Array<{ content: string }>)[1]!.content).length).toBe(2000);
  });
});

describe('JSON schema meets OpenAI strict mode', () => {
  // strict mode: every object lists all its properties as required, and allows no others
  function check(node: unknown, path = '$'): string[] {
    if (typeof node !== 'object' || node === null) return [];
    const o = node as Record<string, unknown>;
    const errs: string[] = [];
    if (o.type === 'object') {
      const keys = Object.keys((o.properties as object) ?? {});
      const req = (o.required as string[]) ?? [];
      if (o.additionalProperties !== false) errs.push(`${path}: additionalProperties must be false`);
      if (keys.sort().join() !== [...req].sort().join()) errs.push(`${path}: required must list every property`);
    }
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v)) v.forEach((x, i) => errs.push(...check(x, `${path}.${k}[${i}]`)));
      else errs.push(...check(v, `${path}.${k}`));
    }
    return errs;
  }
  it('every object is closed and fully required', () => expect(check(JSON_SCHEMA)).toEqual([]));
});
