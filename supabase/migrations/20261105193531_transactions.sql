-- ─────────────────────────────────────────────────────────────────────────────
-- Documents and stock: numbering, quotations, invoices, purchases, expenses,
-- stock that left without a bill, the stock ledger, bulk imports, files.
-- Money is bigint paise everywhere. Quantities are numeric(14,3).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Files (metadata; bytes live in Supabase Storage under <tenant_id>/...) ────

create table public.files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  kind text not null check (kind in ('invoice_pdf', 'quotation_pdf', 'bill_image', 'bill_pdf', 'item_list', 'import_rejects', 'logo', 'export')),
  bucket text not null default 'shop-files',
  path text not null,
  mime text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text,
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (bucket, path),
  -- Storage path must sit inside the shop's own folder.
  constraint files_path_in_tenant_folder check (path like tenant_id::text || '/%')
);

alter table public.tenants
  add constraint tenants_logo_fk foreign key (logo_file_id) references public.files (id);

-- ── Numbering ────────────────────────────────────────────────────────────────

create table public.doc_counters (
  tenant_id uuid not null references public.tenants (id),
  doc_type text not null check (doc_type in ('invoice', 'quotation', 'credit_note')),
  fy text not null check (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  next_serial int not null check (next_serial >= 1),
  primary key (tenant_id, doc_type, fy)
);

-- Takes the next serial for (shop, document type, FY). The counter row stays locked until the
-- calling transaction ends, so concurrent bills queue behind each other and a rolled-back bill
-- gives its number back: no gaps, no repeats. Runs as the caller, so RLS applies.
create or replace function app.next_doc_serial(p_tenant uuid, p_doc_type text, p_fy text) returns int
language sql volatile
as $$
  insert into public.doc_counters as c (tenant_id, doc_type, fy, next_serial)
  values (p_tenant, p_doc_type, p_fy, 2)
  on conflict (tenant_id, doc_type, fy) do update set next_serial = c.next_serial + 1
  returning next_serial - 1
$$;

-- ── Quotations ───────────────────────────────────────────────────────────────

create table public.quotations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  number text not null,
  fy text not null,
  serial int not null check (serial >= 1),
  revision int not null default 0 check (revision >= 0),
  revises_id uuid,
  doc_title text not null check (doc_title in ('quotation', 'estimate')),
  quote_date date not null,
  valid_until date not null,
  party_id uuid,
  bill_to jsonb not null default '{}'::jsonb,
  place_of_supply char(2) not null references public.gst_states (code),
  supply_type text not null check (supply_type in ('intra', 'inter')),
  taxable_paise bigint not null check (taxable_paise >= 0),
  cgst_paise bigint not null default 0 check (cgst_paise >= 0),
  sgst_paise bigint not null default 0 check (sgst_paise >= 0),
  igst_paise bigint not null default 0 check (igst_paise >= 0),
  round_off_paise bigint not null default 0 check (round_off_paise between -50 and 50),
  total_paise bigint not null check (total_paise >= 0),
  status text not null default 'open' check (status in ('open', 'accepted', 'converted', 'partly_converted', 'cancelled', 'superseded')),
  pdf_file_id uuid,
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, party_id) references public.parties (tenant_id, id),
  foreign key (tenant_id, revises_id) references public.quotations (tenant_id, id),
  foreign key (tenant_id, pdf_file_id) references public.files (tenant_id, id),
  constraint quotations_valid_after_date check (valid_until >= quote_date),
  constraint quotations_total check (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + round_off_paise),
  constraint quotations_split check ((supply_type = 'intra' and igst_paise = 0) or (supply_type = 'inter' and cgst_paise = 0 and sgst_paise = 0))
);
create index quotations_open_idx on public.quotations (tenant_id, status, valid_until);

create table public.quotation_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  quotation_id uuid not null,
  line_no int not null check (line_no >= 1),
  item_id uuid,
  item_name text not null,
  hsn text,
  qty numeric(14,3) not null check (qty > 0),
  unit text not null,
  rate_paise bigint not null check (rate_paise >= 0),
  discount_paise bigint not null default 0 check (discount_paise >= 0),
  taxable_paise bigint not null check (taxable_paise >= 0),
  gst_rate numeric(5,2) not null references public.gst_rates (rate),
  gst_paise bigint not null check (gst_paise >= 0),
  line_total_paise bigint not null,
  qty_converted numeric(14,3) not null default 0,
  unique (quotation_id, line_no),
  foreign key (tenant_id, quotation_id) references public.quotations (tenant_id, id),
  foreign key (tenant_id, item_id) references public.items (tenant_id, id),
  constraint quotation_lines_total check (line_total_paise = taxable_paise + gst_paise),
  constraint quotation_lines_converted check (qty_converted >= 0 and qty_converted <= qty)
);

-- ── Invoices ─────────────────────────────────────────────────────────────────

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  number text not null,
  fy text not null,
  serial int not null check (serial >= 1),
  invoice_date date not null,
  party_id uuid,
  bill_to jsonb not null default '{}'::jsonb,
  customer_gstin app.gstin,
  place_of_supply char(2) not null references public.gst_states (code),
  supply_type text not null check (supply_type in ('intra', 'inter')),
  taxable_paise bigint not null check (taxable_paise >= 0),
  cgst_paise bigint not null default 0 check (cgst_paise >= 0),
  sgst_paise bigint not null default 0 check (sgst_paise >= 0),
  igst_paise bigint not null default 0 check (igst_paise >= 0),
  round_off_paise bigint not null default 0 check (round_off_paise between -50 and 50),
  total_paise bigint not null check (total_paise >= 0),
  amount_paid_paise bigint not null default 0 check (amount_paid_paise >= 0),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'partial', 'paid')),
  status text not null default 'issued' check (status in ('issued', 'cancelled')),
  cancel_reason text,
  quotation_id uuid,
  pdf_file_id uuid,
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  unique (tenant_id, fy, serial),
  foreign key (tenant_id, party_id) references public.parties (tenant_id, id),
  foreign key (tenant_id, quotation_id) references public.quotations (tenant_id, id),
  foreign key (tenant_id, pdf_file_id) references public.files (tenant_id, id),
  constraint invoices_fy check (fy = app.fy_of(invoice_date)),
  constraint invoices_total check (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + round_off_paise),
  constraint invoices_split check ((supply_type = 'intra' and igst_paise = 0) or (supply_type = 'inter' and cgst_paise = 0 and sgst_paise = 0)),
  constraint invoices_paid check (amount_paid_paise <= total_paise),
  constraint invoices_cancel_reason check (status <> 'cancelled' or cancel_reason is not null)
);
create index invoices_date_idx on public.invoices (tenant_id, invoice_date);

create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  invoice_id uuid not null,
  line_no int not null check (line_no >= 1),
  item_id uuid not null,
  item_name text not null,
  hsn text,
  qty numeric(14,3) not null check (qty > 0),
  unit text not null,
  rate_paise bigint not null check (rate_paise >= 0),
  discount_paise bigint not null default 0 check (discount_paise >= 0),
  taxable_paise bigint not null check (taxable_paise >= 0),
  gst_rate numeric(5,2) not null references public.gst_rates (rate),
  gst_paise bigint not null check (gst_paise >= 0),
  line_total_paise bigint not null,
  quotation_line_id uuid,
  unique (invoice_id, line_no),
  foreign key (tenant_id, invoice_id) references public.invoices (tenant_id, id),
  foreign key (tenant_id, item_id) references public.items (tenant_id, id),
  constraint invoice_lines_total check (line_total_paise = taxable_paise + gst_paise)
);
create index invoice_lines_item_idx on public.invoice_lines (tenant_id, item_id);

-- ── Purchases ────────────────────────────────────────────────────────────────

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  supplier_id uuid,
  supplier_name text,
  bill_no text,
  bill_date date,
  entry_date date not null,
  source text not null default 'typed' check (source in ('typed', 'bill_image', 'bill_pdf', 'import')),
  source_file_id uuid,
  taxable_paise bigint not null check (taxable_paise >= 0),
  gst_paise bigint not null check (gst_paise >= 0),
  total_paise bigint not null check (total_paise >= 0),
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, supplier_id) references public.parties (tenant_id, id),
  foreign key (tenant_id, source_file_id) references public.files (tenant_id, id),
  constraint purchases_total check (total_paise = taxable_paise + gst_paise)
);
-- The same supplier bill can't be entered twice.
create unique index purchases_supplier_bill_once on public.purchases (tenant_id, supplier_id, app.norm_key(bill_no))
  where supplier_id is not null and bill_no is not null;
create index purchases_date_idx on public.purchases (tenant_id, entry_date);

create table public.purchase_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  purchase_id uuid not null,
  line_no int not null check (line_no >= 1),
  item_id uuid not null,
  item_name text not null,
  qty numeric(14,3) not null check (qty > 0),
  unit text not null,
  rate_paise bigint not null check (rate_paise >= 0),
  discount_paise bigint not null default 0 check (discount_paise >= 0),
  taxable_paise bigint not null check (taxable_paise >= 0),
  gst_rate numeric(5,2) not null references public.gst_rates (rate),
  gst_paise bigint not null check (gst_paise >= 0),
  line_total_paise bigint not null,
  unique (purchase_id, line_no),
  foreign key (tenant_id, purchase_id) references public.purchases (tenant_id, id),
  foreign key (tenant_id, item_id) references public.items (tenant_id, id),
  constraint purchase_lines_total check (line_total_paise = taxable_paise + gst_paise)
);

-- ── Expenses ─────────────────────────────────────────────────────────────────

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  expense_date date not null,
  category text not null,
  amount_paise bigint not null check (amount_paise > 0),
  mode text not null default 'cash' check (mode in ('cash', 'upi', 'bank', 'card', 'cheque', 'other')),
  paid_to text,
  note text,
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index expenses_date_idx on public.expenses (tenant_id, expense_date);

-- ── Stock that left without a bill ───────────────────────────────────────────

create table public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  adj_date date not null,
  item_id uuid not null,
  qty numeric(14,3) not null check (qty > 0),
  reason text not null check (reason in ('cash_sale_no_bill', 'sample_demo', 'on_approval', 'internal_use', 'damaged_lost', 'branch_transfer', 'other')),
  reason_note text,
  party_id uuid,
  party_name text,
  est_value_paise bigint not null default 0 check (est_value_paise >= 0),
  status text not null default 'open' check (status in ('open', 'billed', 'returned', 'written_off')),
  linked_invoice_id uuid,
  resolved_at timestamptz,
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, item_id) references public.items (tenant_id, id),
  foreign key (tenant_id, party_id) references public.parties (tenant_id, id),
  foreign key (tenant_id, linked_invoice_id) references public.invoices (tenant_id, id),
  constraint stock_adjustments_billed check (status <> 'billed' or linked_invoice_id is not null)
);
create index stock_adjustments_open_idx on public.stock_adjustments (tenant_id) where status = 'open';

-- ── Stock ledger (append-only; stock on hand is always the sum) ───────────────

create table public.stock_ledger (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  item_id uuid not null,
  qty_in numeric(14,3) not null default 0 check (qty_in >= 0),
  qty_out numeric(14,3) not null default 0 check (qty_out >= 0),
  movement_type text not null check (movement_type in (
    'opening', 'import', 'purchase', 'purchase_return', 'sale', 'sale_cancel',
    'unbilled_out', 'unbilled_return', 'stock_count')),
  ref_type text check (ref_type in ('invoice', 'purchase', 'stock_adjustment', 'item_import', 'stock_count', 'item')),
  ref_id uuid,
  note text,
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, item_id) references public.items (tenant_id, id),
  -- exactly one side moves
  constraint stock_ledger_one_side check ((qty_in > 0) <> (qty_out > 0))
);
create index stock_ledger_item_idx on public.stock_ledger (tenant_id, item_id);
create index stock_ledger_ref_idx on public.stock_ledger (tenant_id, ref_type, ref_id);

-- security_invoker: the view obeys the caller's RLS, never the view owner's.
create view public.v_item_stock with (security_invoker = true) as
  select i.tenant_id, i.id as item_id, i.name, i.unit, i.reorder_level, i.active,
         coalesce(sum(l.qty_in - l.qty_out), 0)::numeric(14,3) as qty_on_hand,
         max(l.created_at) as last_movement_at
  from public.items i
  left join public.stock_ledger l on l.tenant_id = i.tenant_id and l.item_id = i.id
  group by i.tenant_id, i.id;

-- ── Bulk item imports ────────────────────────────────────────────────────────

create table public.item_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  file_id uuid not null,
  status text not null default 'mapping' check (status in ('mapping', 'confirmed', 'completed', 'failed', 'cancelled')),
  sheet_name text,
  header_row int,
  column_map jsonb not null default '{}'::jsonb,
  rows_total int not null default 0 check (rows_total >= 0),
  rows_accepted int not null default 0 check (rows_accepted >= 0),
  rows_rejected int not null default 0 check (rows_rejected >= 0),
  rejects_file_id uuid,
  credits_charged int not null default 0 check (credits_charged >= 0),
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, file_id) references public.files (tenant_id, id),
  foreign key (tenant_id, rejects_file_id) references public.files (tenant_id, id),
  constraint item_imports_counts check (rows_accepted + rows_rejected <= rows_total)
);
