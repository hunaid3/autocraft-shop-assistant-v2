-- Private bucket for shop files: invoice/quotation PDFs, bill photos, item lists, logos.
-- One folder per shop (<tenant_id>/…), enforced by the files table. No storage policies are added,
-- so only the engine's server-side key can read or write; the dashboard will get short-lived
-- signed URLs. Skipped on plain Postgres (no storage schema).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('shop-files', 'shop-files', false, 20 * 1024 * 1024, array[
      'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
      'text/csv', 'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
    on conflict (id) do nothing;
  end if;
end $$;
