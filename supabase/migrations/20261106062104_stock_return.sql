-- Goods that went out without a bill (sample, on approval…) coming back: a draft kind of its own,
-- free of credits (it reverses an entry the shop already paid for).
alter table public.drafts drop constraint drafts_kind_check;
alter table public.drafts add constraint drafts_kind_check check (kind in (
  'invoice', 'quotation', 'quotation_convert', 'purchase', 'expense', 'stock_out', 'stock_return',
  'stock_count', 'add_item', 'item_import', 'awaiting_stock'));

insert into public.credit_prices (action_code, credits, per_units, label)
values ('stock_return', 0, 1, 'Goods back after a stock out (free)')
on conflict (action_code) do nothing;
