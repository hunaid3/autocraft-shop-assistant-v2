import type { InvoiceDoc } from '../../src/documents/invoiceHtml.js';

export function sampleDoc(over: Partial<InvoiceDoc> = {}): InvoiceDoc {
  return {
    title: 'TAX INVOICE', number: 'INV/2026-27/0001', date: '2026-11-06',
    shop: { name: 'Murtaza Electronics', address: 'Abids, Hyderabad', gstin: '36AABCU9603R1ZM', stateCode: '36', stateName: 'Telangana', upiId: 'murtaza@okhdfcbank' },
    billTo: { name: 'Ravi Electronics', gstin: null },
    placeOfSupply: { code: '36', name: 'Telangana' }, supply: 'intra',
    lines: [{ name: 'boAt Airdopes 141', hsn: '85183000', qty: '10', unit: 'pcs', ratePaise: 125000, discountPaise: 0, taxablePaise: 1250000, gstRate: 18, gstPaise: 225000, totalPaise: 1475000 }],
    totals: { taxablePaise: 1250000, cgstPaise: 112500, sgstPaise: 112500, igstPaise: 0, roundOffPaise: 0, totalPaise: 1475000 },
    terms: ['Goods once sold will not be taken back.'],
    ...over
  };
}
