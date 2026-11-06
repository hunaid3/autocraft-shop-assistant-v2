import { describe, expect, it } from 'vitest';
import jsQRImport from 'jsqr';
import { PNG } from 'pngjs';
import { invoiceHtml, MAX_INVOICE_NUMBER_LENGTH, upiLink } from '../../src/documents/invoiceHtml.js';
import { sampleDoc } from '../fixtures/invoiceDoc.js';
import { formatDocNumber } from '../../src/domain/format.js';


// jsqr ships CommonJS; under NodeNext its default export may be nested
const jsQR = ((jsQRImport as unknown as { default?: unknown }).default ?? jsQRImport) as (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null;

function decodeQr(html: string): string | null {
  const m = /<img src="data:image\/png;base64,([^"]+)" alt="UPI QR">/.exec(html);
  if (!m) return null;
  const png = PNG.sync.read(Buffer.from(m[1]!, 'base64'));
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
}

describe('invoice template', () => {
  it('has the GST invoice essentials', async () => {
    const html = await invoiceHtml(sampleDoc());
    for (const s of ['TAX INVOICE', 'INV/2026-27/0001', '06 Nov 2026', 'GSTIN:</span> 36AABCU9603R1ZM', 'Telangana (36)', 'Reverse charge',
      '85183000', '12,500.00', 'CGST', 'SGST', '14,750.00', 'Rupees Fourteen Thousand Seven Hundred Fifty Only', 'Authorised signatory']) {
      expect(html, s).toContain(s);
    }
    expect(html).not.toContain('IGST');
  });

  it('inter-state shows IGST only', async () => {
    const html = await invoiceHtml(sampleDoc({ supply: 'inter', placeOfSupply: { code: '27', name: 'Maharashtra' },
      totals: { taxablePaise: 1250000, cgstPaise: 0, sgstPaise: 0, igstPaise: 225000, roundOffPaise: 0, totalPaise: 1475000 } }));
    expect(html).toContain('IGST');
    expect(html).toContain('Maharashtra (27)');
    expect(html).not.toContain('>CGST<');
  });

  it('a shop without GSTIN gets a bill of supply with no tax columns', async () => {
    const html = await invoiceHtml(sampleDoc({ title: 'BILL OF SUPPLY', shop: { ...sampleDoc().shop, gstin: null } }));
    expect(html).toContain('BILL OF SUPPLY');
    expect(html).toContain('Supplier not registered under GST; no tax charged.');
    expect(html).not.toMatch(/<th class="r">GST<\/th>|>CGST<|Reverse charge/);
  });

  it("the UPI QR decodes to a payment of exactly the bill's amount", async () => {
    const qr = decodeQr(await invoiceHtml(sampleDoc()));
    expect(qr).toBe('upi://pay?pa=murtaza%40okhdfcbank&pn=Murtaza%20Electronics&am=14750.00&cu=INR&tn=INV%2F2026-27%2F0001');
    expect(qr).toBe(upiLink('murtaza@okhdfcbank', 'Murtaza Electronics', 1475000, 'INV/2026-27/0001'));
  });

  it('no QR without a UPI id, and none on quotations', async () => {
    expect(decodeQr(await invoiceHtml(sampleDoc({ shop: { ...sampleDoc().shop, upiId: null } })))).toBeNull();
    expect(decodeQr(await invoiceHtml(sampleDoc({ title: 'QUOTATION', validUntil: '2026-11-21' })))).toBeNull();
  });

  it('names from messages are escaped, never run as HTML', async () => {
    const evil = '<img src=x onerror=alert(1)><script>fetch("http://x")</script>';
    const html = await invoiceHtml(sampleDoc({ billTo: { name: evil }, lines: [{ ...sampleDoc().lines[0]!, name: evil }] }));
    expect(html).not.toContain('<script>fetch');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('the default invoice number fits the 16-character legal limit', () => {
    expect(formatDocNumber('INV', '2026-27', 9999).length).toBeLessThanOrEqual(MAX_INVOICE_NUMBER_LENGTH);
  });

  it("carries the shop's branding only: no AutoCraft name or logo, and no logo at all unless the shop gave one", async () => {
    const plain = await invoiceHtml(sampleDoc());
    expect(plain).not.toMatch(/autocraft/i);
    expect(plain).not.toContain('class="logo"');
    const branded = await invoiceHtml(sampleDoc({ shop: { ...sampleDoc().shop, logoDataUri: 'data:image/png;base64,AAAA' } }));
    expect(branded).toContain('<img class="logo" src="data:image/png;base64,AAAA"');
    expect(branded).not.toMatch(/autocraft/i);
  });

  it('fonts are embedded (no network needed to render Hindi or ₹)', async () => {
    const html = await invoiceHtml(sampleDoc());
    expect(html).toContain("font-family:'Noto Sans Devanagari'");
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });
});
