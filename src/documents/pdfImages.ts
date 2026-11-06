/**
 * A PDF bill → page images for the AI reader, with poppler's pdftoppm (first 3 pages, 150 dpi).
 * Runs as a separate process with a time limit; the PDF never reaches a browser or a shell.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function pdfToPngs(pdf: Buffer, opts: { maxPages?: number; dpi?: number; timeoutMs?: number } = {}): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), 'bill-'));
  try {
    const input = join(dir, 'in.pdf');
    await writeFile(input, pdf);
    await new Promise<void>((resolve, reject) => {
      execFile('pdftoppm', ['-png', '-r', String(opts.dpi ?? 150), '-f', '1', '-l', String(opts.maxPages ?? 3), input, join(dir, 'p')],
        { timeout: opts.timeoutMs ?? 20_000 }, (err) => (err ? reject(new Error(`pdf could not be read: ${err.message.split('\n')[0]}`)) : resolve()));
    });
    const pages = (await readdir(dir)).filter((f) => f.startsWith('p') && f.endsWith('.png')).sort();
    return Promise.all(pages.map((f) => readFile(join(dir, f))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
