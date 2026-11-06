/**
 * HTML → PDF with headless Chromium. One browser per process, one page per document.
 * The page is locked down: JavaScript off and every network request refused, because item and
 * customer names come from messages and must never be able to make Chromium fetch anything.
 */
import puppeteer, { type Browser } from 'puppeteer-core';

export interface PdfRenderer {
  render(html: string): Promise<Buffer>;
  close(): Promise<void>;
}

export function chromiumRenderer(opts: { executablePath?: string; maxConcurrent?: number; timeoutMs?: number } = {}): PdfRenderer {
  let browser: Promise<Browser> | null = null;
  let active = 0;
  const waiting: Array<() => void> = [];
  const max = opts.maxConcurrent ?? 2;

  const getBrowser = () => {
    browser ??= puppeteer.launch({
      executablePath: opts.executablePath ?? process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none', '--disable-extensions']
    }).then((b) => { b.on('disconnected', () => { browser = null; }); return b; });
    return browser;
  };

  return {
    async render(html) {
      if (active >= max) await new Promise<void>((r) => waiting.push(r));
      active++;
      const page = await (await getBrowser()).newPage();
      try {
        await page.setJavaScriptEnabled(false);
        await page.setRequestInterception(true);
        page.on('request', (req) => (req.url().startsWith('data:') ? req.continue() : req.abort()));
        await page.setContent(html, { waitUntil: 'load', timeout: opts.timeoutMs ?? 20_000 });
        const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, timeout: opts.timeoutMs ?? 20_000 });
        return Buffer.from(pdf);
      } finally {
        await page.close().catch(() => undefined);
        active--;
        waiting.shift()?.();
      }
    },
    async close() {
      if (browser) await (await browser).close().catch(() => undefined);
      browser = null;
    }
  };
}
