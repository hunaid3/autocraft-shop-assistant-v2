-- GST rule 46(b): an invoice serial number may not exceed 16 characters.
-- Numbers look like PREFIX/2026-27/0001 = prefix + 13 characters, so the prefix is at most 3.
-- (Quotations aren't tax invoices; their prefix keeps the wider limit.)
alter table public.tenant_settings drop constraint tenant_settings_invoice_prefix_check;
alter table public.tenant_settings add constraint tenant_settings_invoice_prefix_check
  check (invoice_prefix ~ '^[A-Z0-9]{1,3}$');

-- Belt and braces on the invoice itself (also catches serials past 9999 in one year).
alter table public.invoices add constraint invoices_number_max_16 check (length(number) <= 16);
