/**
 * The current shop, as the engine needs it: profile, settings, item catalogue and stock.
 * Always loaded inside withTenant(), so RLS guarantees it is this shop and no other.
 */
import type { Tx } from '../db/tenantTx.js';
import type { MatchableItem } from '../domain/itemMatch.js';

export interface Shop {
  id: string;
  name: string;
  stateCode: string;
  gstin: string | null;
  settings: {
    defaultGstRate: number;
    pricesIncludeGst: boolean;
    stockShortfall: 'allow' | 'block';
    invoicePrefix: string;
    quotationPrefix: string;
    quotationTitle: 'quotation' | 'estimate';
    quotationValidityDays: number;
  };
}

export interface CatalogItem extends MatchableItem {
  id: string;
  name: string;
  aliases: string[];
  unit: string;
  hsn: string | null;
  gstRate: number;
  purchasePricePaise: number;
  salePricePaise: number;
  reorderLevel: number;
}

export async function loadShop(tx: Tx, tenantId: string): Promise<Shop> {
  const { rows } = await tx.query(
    `select t.id, t.name, t.state_code, t.gstin, s.default_gst_rate, s.prices_include_gst, s.stock_shortfall, s.invoice_prefix,
            s.quotation_prefix, s.quotation_title, s.quotation_validity_days
       from tenants t join tenant_settings s on s.tenant_id = t.id where t.id = $1`, [tenantId]);
  const r = rows[0];
  if (!r) throw new Error('shop not found in context');
  return {
    id: r.id, name: r.name, stateCode: r.state_code, gstin: r.gstin,
    settings: {
      defaultGstRate: Number(r.default_gst_rate), pricesIncludeGst: r.prices_include_gst,
      stockShortfall: r.stock_shortfall, invoicePrefix: r.invoice_prefix,
      quotationPrefix: r.quotation_prefix, quotationTitle: r.quotation_title, quotationValidityDays: Number(r.quotation_validity_days)
    }
  };
}

export async function loadCatalog(tx: Tx): Promise<CatalogItem[]> {
  const { rows } = await tx.query(
    `select i.id, i.name, i.unit, i.hsn, i.gst_rate, i.purchase_price_paise, i.sale_price_paise, i.reorder_level,
            coalesce(array_agg(a.alias) filter (where a.alias is not null), '{}') as aliases
       from items i left join item_aliases a on a.item_id = i.id and a.tenant_id = i.tenant_id
      where i.active group by i.id order by i.name`);
  return rows.map((r) => ({
    id: r.id, name: r.name, aliases: r.aliases, unit: r.unit, hsn: r.hsn, gstRate: Number(r.gst_rate),
    purchasePricePaise: Number(r.purchase_price_paise), salePricePaise: Number(r.sale_price_paise), reorderLevel: Number(r.reorder_level)
  }));
}

/** Stock on hand per item id (numbers, 3 dp). */
export async function stockMap(tx: Tx, itemIds?: string[]): Promise<Map<string, number>> {
  const { rows } = itemIds
    ? await tx.query('select item_id, qty_on_hand from v_item_stock where item_id = any($1)', [itemIds])
    : await tx.query('select item_id, qty_on_hand from v_item_stock');
  return new Map(rows.map((r) => [r.item_id as string, Number(r.qty_on_hand)]));
}

export async function creditBalance(tx: Tx): Promise<number> {
  const { rows } = await tx.query('select balance from credit_wallets');
  return rows[0]?.balance ?? 0;
}

export async function creditCost(tx: Tx, action: string, units = 1): Promise<number> {
  const { rows } = await tx.query('select app.credit_cost($1, $2) as c', [action, units]);
  return rows[0].c ?? 0;
}
