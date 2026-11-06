/** Real Chromium renders. Skipped where no Chrome is installed (CHROME_PATH or /usr/bin/google-chrome). */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { chromiumRenderer } from '../../src/documents/pdf.js';
import { invoiceHtml } from '../../src/documents/invoiceHtml.js';
import { sampleDoc } from '../fixtures/invoiceDoc.js';

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const hasChrome = existsSync(chrome);
const hasPdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const renderer = chromiumRenderer({ executablePath: chrome });
afterAll(async () => { await renderer.close(); });

describe.skipIf(!hasChrome)('PDF rendering', () => {
  it('renders a real PDF with the right text, Hindi included', async () => {
    const doc = sampleDoc({ lines: [{ ...sampleDoc().lines[0]!, name: 'चाय पत्ती 250g' }] });
    const pdf = await renderer.render(await invoiceHtml(doc));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(20_000);
    if (hasPdftotext) {
      const text = execFileSync('pdftotext', ['-layout', '-', '-'], { input: pdf }).toString();
      expect(text).toContain('TAX INVOICE');
      expect(text).toContain('INV/2026-27/0001');
      expect(text).toContain('14,750.00');
      expect(text).toContain('चाय पत्ती');
    }
  });

  it('Chromium makes no network requests, even when a name tries to', async () => {
    let hits = 0;
    const server = createServer((_q, r) => { hits++; r.end('x'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/leak`;
    const html = (await invoiceHtml(sampleDoc())).replace('</body>',
      `<img src="${url}/img"><link rel="stylesheet" href="${url}/css"><iframe src="${url}/frame"></iframe><script>fetch("${url}/js")</script></body>`);
    const pdf = await renderer.render(html);
    server.close();
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(hits).toBe(0);
  });

  it('renders several at once without mixing them up', async () => {
    const pdfs = await Promise.all(['0001', '0002', '0003', '0004'].map(async (n) =>
      renderer.render(await invoiceHtml(sampleDoc({ number: `INV/2026-27/${n}` })))));
    if (hasPdftotext) {
      pdfs.forEach((pdf, i) => expect(execFileSync('pdftotext', ['-', '-'], { input: pdf }).toString()).toContain(`INV/2026-27/000${i + 1}`));
    }
  });
});
