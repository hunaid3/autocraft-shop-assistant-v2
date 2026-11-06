/* Shop Khata: the AutoCraft shop dashboard. Talks only to /api on this same site (proxied to the engine). */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const KEY = 'autocraft.session';
  const store = {
    get() { try { return localStorage.getItem(KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(KEY, v); } catch { /* private mode: session lasts this tab */ } },
    clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
  };
  let session = store.get();
  let period = 'month';
  let list = 'invoices';
  let me = null;

  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rs = (paise) => '₹' + inr.format(Math.round(Number(paise || 0) / 100));
  const rs2 = (paise) => '₹' + inr2.format(Number(paise || 0) / 100);
  const day = (d) => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PERIOD_LABEL = { today: 'today', week: 'in the last 7 days', month: 'this month', last_month: 'last month', fy: 'this financial year' };

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      ...opts,
      headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(session ? { authorization: 'Bearer ' + session } : {}) }
    });
    if (res.status === 401) { signOut('Your sign-in has ended. Send *dashboard* on WhatsApp for a new link.'); throw new Error('signed out'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Something went wrong (${res.status}). Try again.`);
    return res;
  }
  const json = async (path, opts) => (await api(path, opts)).json();

  function signOut(message) {
    session = null; store.clear();
    $('ledger').hidden = true; $('logout').hidden = true; $('signin').hidden = false;
    $('signinError').textContent = message ? message.replace(/\*/g, '') : '';
    $('shopName').textContent = 'Your shop'; $('shopMeta').textContent = '';
  }

  async function redeemLinkInUrl() {
    const m = /[#&]login=([A-Za-z0-9_-]{20,100})/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname); // the link works once; don't keep it in history
    const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: m[1] }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { signOut(body.error || 'This link has expired. Send dashboard on WhatsApp for a new one.'); return; }
    session = body.session; store.set(session);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const row = (k, v, cls = '') => `<div class="${cls}"><dt>${k}</dt><span class="leader"></span><dd>${v}</dd></div>`;

  async function loadSummary() {
    const s = await json('/summary?period=' + period);
    $('totalCaption').textContent = 'Sales ' + PERIOD_LABEL[period];
    $('salesTotal').textContent = rs(s.sales.total);
    $('salesSub').textContent = s.sales.count
      ? `${s.sales.count} bill${s.sales.count === 1 ? '' : 's'} · ${rs(s.sales.taxable)} before GST + ${rs(s.sales.gst)} GST`
      : 'No bills yet in this period.';
    const net = s.profit_estimate.net;
    $('pl').innerHTML =
      row('Sales (before GST)', rs(s.sales.taxable)) +
      row('Cost of goods sold', '− ' + rs(s.sales.taxable - s.profit_estimate.gross)) +
      row('Gross profit', rs(s.profit_estimate.gross)) +
      row('Expenses', '− ' + rs(s.expenses.total)) +
      `<div class="sum"><dt>Estimated profit</dt><span class="leader"></span><dd class="${net < 0 ? 'neg' : 'pos'}">${net < 0 ? '− ' : ''}${rs(Math.abs(net))}</dd></div>` +
      row('Purchases (stock bought)', rs(s.purchases.total));
    $('plNote').textContent = 'Cost of goods uses each item\'s saved buying price.' +
      (s.profit_estimate.items_without_cost ? ` ${s.profit_estimate.items_without_cost} sold line(s) have no buying price yet, so profit looks higher than it is.` : '');
    $('now').innerHTML =
      row('Stock value (at cost)', rs(s.stock.value)) +
      row('Items', inr.format(s.stock.items)) +
      row('Running low', s.stock.low ? `<span class="neg">${s.stock.low}</span>` : '0') +
      row('Open quotes', `${s.quotes.open} · ${rs(s.quotes.total)}`) +
      row('Out without a bill', `${s.unbilled.open} · ${rs(s.unbilled.total)}`) +
      row('Credits', inr.format(s.credits.balance) + (s.credits.expiring_30d ? ` <span class="neg">(${s.credits.expiring_30d} expire within 30 days)</span>` : ''));
    $('top').innerHTML = s.top_items.length
      ? s.top_items.map((t) => `<li><span class="k">${esc(t.name)} <span class="muted">× ${inr.format(t.qty)}</span></span><span class="leader"></span><span class="v">${rs(t.taxable)}</span></li>`).join('')
      : '<li class="muted">Nothing sold in this period.</li>';
    drawChart(s.daily);
  }

  function drawChart(days) {
    const el = $('chart');
    if (!days.length) { el.innerHTML = ''; return; }
    const W = 600, H = 140, pad = 18, n = days.length;
    const max = Math.max(1, ...days.map((d) => d.total));
    const bw = (W - 8) / n;
    const bars = days.map((d, i) => {
      const h = Math.round((d.total / max) * (H - pad - 6));
      const x = 4 + i * bw;
      return `<rect class="${d.total ? '' : 'zero'}" x="${x + bw * 0.15}" y="${H - pad - Math.max(h, 1)}" width="${Math.max(bw * 0.7, 1)}" height="${Math.max(h, 1)}"><title>${day(d.day)}: ${rs(d.total)}</title></rect>`;
    }).join('');
    const first = day(days[0].day), last = day(days[n - 1].day);
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}<text x="4" y="${H - 2}">${first}</text><text x="${W - 4}" y="${H - 2}" text-anchor="end">${last}</text></svg>`;
    el.setAttribute('aria-label', `Sales per day from ${first} to ${last}; highest ${rs(max)}`);
  }

  // ── Lists ────────────────────────────────────────────────────────────────
  const COLS = {
    invoices: [['number', 'Bill no.'], ['date', 'Date', day], ['customer', 'Customer'], ['taxable_paise', 'Before GST', rs2, 'num'], ['gst_paise', 'GST', rs2, 'num'], ['total_paise', 'Total', rs2, 'num'], ['status', 'Status'], ['_pdf', '', null, 'actions']],
    quotations: [['number', 'Quote no.'], ['date', 'Date', day], ['customer', 'Customer'], ['valid_until', 'Valid till', day], ['total_paise', 'Total', rs2, 'num'], ['status', 'Status'], ['_pdf', '', null, 'actions']],
    purchases: [['date', 'Date', day], ['supplier', 'Supplier'], ['bill_no', 'Bill no.'], ['taxable_paise', 'Before GST', rs2, 'num'], ['gst_paise', 'GST', rs2, 'num'], ['total_paise', 'Total', rs2, 'num'], ['source', 'Entered as', (v) => ({ typed: 'typed', bill_image: 'bill photo', bill_pdf: 'bill PDF', import: 'upload' }[v] || v)]],
    expenses: [['date', 'Date', day], ['category', 'For'], ['amount_paise', 'Amount', rs2, 'num'], ['mode', 'Paid by'], ['paid_to', 'Paid to']],
    stock: [['name', 'Item'], ['qty', 'In stock', (v, r) => `${inr.format(v)} ${esc(r.unit)}${r.low ? ' <span class="neg">low</span>' : ''}`, 'num'], ['purchase_price_paise', 'Buy', rs2, 'num'], ['sale_price_paise', 'Sell', rs2, 'num'], ['gst_rate', 'GST %', (v) => v + '%', 'num'], ['value_paise', 'Value', rs2, 'num']],
    unbilled: [['date', 'Date', day], ['item', 'Item'], ['qty', 'Qty', (v) => inr.format(v), 'num'], ['reason', 'Why', (v) => ({ cash_sale_no_bill: 'sold without bill', sample_demo: 'sample', on_approval: 'on approval', internal_use: 'shop use', damaged_lost: 'damaged / lost', branch_transfer: 'branch transfer', other: 'other' }[v] || v)], ['party_name', 'With'], ['est_value_paise', 'Value', rs2, 'num'], ['status', 'Status']],
    credits: [['created_at', 'Date', day], ['kind', 'What', (v, r) => ({ debit: r.action_code ? 'used: ' + r.action_code.replace(/_/g, ' ') : 'used', signup_bonus: 'welcome credits', top_up: 'recharge', refund: 'refund', expiry: 'expired', admin_adjust: 'from AutoCraft', referral: 'referral' }[v] || v)], ['delta', 'Change', (v) => (v > 0 ? '+' : '') + v, 'num'], ['balance_after', 'Balance', (v) => v, 'num']]
  };
  // Hidden on phones to keep each row to two lines
  const LOW = new Set(['taxable_paise', 'gst_paise', 'gst_rate', 'reorder_level', 'mode', 'source', 'bill_no', 'valid_until', 'balance_after']);
  const DATED = new Set(['invoices', 'quotations', 'purchases', 'expenses']);

  function table(cols, rows, kind) {
    if (!rows.length) return `<p class="empty">${EMPTY[kind] || 'Nothing here yet.'}</p>`;
    const head = cols.map(([, label, , cls]) => `<th class="${cls || ''}">${esc(label)}</th>`).join('');
    const body = rows.map((r) => '<tr>' + cols.map(([key, label, fmt, cls]) => {
      if (key === '_pdf') return `<td class="actions">${r.has_pdf ? `<button class="link" data-pdf="${kind === 'invoices' ? 'invoice' : 'quotation'}" data-id="${esc(r.id)}">PDF</button>` : '<span class="tag">PDF pending</span>'}</td>`;
      const v = fmt ? fmt(r[key], r) : esc(r[key]);
      return `<td class="${cls || ''}${LOW.has(key) ? ' lo' : ''}" data-label="${esc(label)}">${v ?? ''}</td>`;
    }).join('') + '</tr>').join('');
    return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  const EMPTY = {
    invoices: 'No bills in this period. Send "bill Ravi 2 airdopes at 1250" on WhatsApp to make one.',
    quotations: 'No quotes in this period. Send "quote Ravi 10 airdopes at 1200" on WhatsApp.',
    purchases: 'No purchases in this period. Send a photo of a supplier bill on WhatsApp, or "bought 50 airdopes @ 850 from Sharma Traders".',
    expenses: 'No expenses in this period. Send "paid 3500 shop rent cash" on WhatsApp.',
    stock: 'No items yet. Add stock on WhatsApp: "add 50 cables @ 100 to stock".',
    unbilled: 'Nothing has gone out without a bill.',
    credits: 'No credit movements yet.'
  };

  async function loadList() {
    const box = $('list');
    $('export').hidden = list === 'admin';
    if (list === 'admin') return loadAdmin();
    box.setAttribute('aria-busy', 'true');
    const r = await json(`/${list}?period=${period}`);
    $('listCaption').textContent = DATED.has(list) ? `${day(r.from)} to ${day(r.to)} · ${r.rows.length} entr${r.rows.length === 1 ? 'y' : 'ies'}` : `${r.rows.length} entr${r.rows.length === 1 ? 'y' : 'ies'}`;
    box.innerHTML = table(COLS[list], r.rows, list);
    box.removeAttribute('aria-busy');
  }

  async function openPdf(kind, id) {
    const w = window.open('', '_blank'); // open now so pop-up blockers allow it
    try {
      const blob = await (await api(`/pdf/${kind}/${id}`)).blob();
      const url = URL.createObjectURL(blob);
      if (w) w.location.href = url; else location.href = url;
    } catch (e) { if (w) w.close(); alert(e.message); }
  }

  async function download() {
    const res = await api(`/export/${list}.csv?period=${period}`);
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || `${list}.csv`;
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: name });
    document.body.append(a); a.click(); a.remove();
  }

  // ── Admin (AutoCraft team only) ──────────────────────────────────────────
  async function loadAdmin() {
    const [shops, support, jobs] = await Promise.all([json('/admin/shops'), json('/admin/support?status=open'), json('/admin/jobs')]);
    $('listCaption').textContent = `${shops.rows.length} shops · ${support.rows.length} open support requests · ${jobs.rows.length} failed jobs`;
    const shopRows = shops.rows.map((s) => `<tr><td>${esc(s.name)}<br><span class="tag">${esc(s.gstin || 'no GSTIN')} · ${esc(s.state_code)}</span></td>
      <td>${esc(s.owner_name || '')}<br><span class="tag">+${esc(s.owner_phone || '')}</span></td><td class="num">${s.credits}</td><td class="num">${s.invoices}</td>
      <td>${s.last_message_at ? day(s.last_message_at) : '—'}</td><td class="actions"><button class="link" data-grant="${esc(s.tenant_id)}" data-name="${esc(s.name)}">Give credits</button></td></tr>`).join('');
    const supRows = support.rows.map((r) => `<tr><td>SR-${String(r.ref_no).padStart(4, '0')}<br><span class="tag">${day(r.created_at)}</span></td>
      <td>${esc(r.tenant_name || 'not registered')}<br><span class="tag">+${esc(r.phone)} ${esc(r.role || '')}</span></td><td>${esc(r.problem)}</td>
      <td class="actions"><a class="link" href="https://wa.me/${esc(r.phone)}" target="_blank" rel="noopener">WhatsApp</a><button class="link" data-close="${esc(r.id)}">Mark done</button></td></tr>`).join('');
    const jobRows = jobs.rows.map((j) => `<tr><td>#${j.id} ${esc(j.queue)}</td><td>${day(j.created_at)}</td><td>${esc(j.last_error || '')}</td></tr>`).join('');
    $('list').innerHTML =
      `<h2>Support requests</h2>${support.rows.length ? `<div class="scroll"><table><tbody>${supRows}</tbody></table></div>` : '<p class="empty">No open requests.</p>'}
       <h2 style="margin-top:28px">Shops</h2><div class="scroll"><table><thead><tr><th>Shop</th><th>Owner</th><th class="num">Credits</th><th class="num">Bills</th><th>Last message</th><th></th></tr></thead><tbody>${shopRows}</tbody></table></div>
       <h2 style="margin-top:28px">Failed jobs</h2>${jobs.rows.length ? `<div class="scroll"><table><tbody>${jobRows}</tbody></table></div>` : '<p class="empty">None.</p>'}`;
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  async function refresh() {
    try { await Promise.all([loadSummary(), loadList()]); }
    catch (e) { if (e.message !== 'signed out') $('listCaption').textContent = e.message; }
  }

  document.querySelector('.periods').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-period]'); if (!b) return;
    period = b.dataset.period;
    document.querySelectorAll('.periods button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    refresh();
  });
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-list]'); if (!b) return;
    list = b.dataset.list;
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    loadList().catch((err) => { $('listCaption').textContent = err.message; });
  });
  $('list').addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.pdf) return openPdf(t.dataset.pdf, t.dataset.id);
    if (t.dataset.close) { await json(`/admin/support/${t.dataset.close}/close`, { method: 'POST', body: '{}' }); return loadAdmin(); }
    if (t.dataset.grant) {
      const credits = Number(prompt(`Credits to give ${t.dataset.name} (1 to 10000):`, '50'));
      if (!Number.isInteger(credits) || credits < 1) return;
      const note = prompt('Note for the record (optional):', 'Goodwill') || '';
      const r = await json('/admin/credits', { method: 'POST', body: JSON.stringify({ tenant_id: t.dataset.grant, credits, note }) });
      alert(`Done. ${t.dataset.name} now has ${r.balance} credits.`);
      return loadAdmin();
    }
  });
  $('export').addEventListener('click', () => download().catch((e) => alert(e.message)));
  $('logout').addEventListener('click', async () => { await api('/logout', { method: 'POST', body: '{}' }).catch(() => {}); signOut(); });

  (async () => {
    await redeemLinkInUrl();
    if (!session) { $('signin').hidden = false; return; }
    try {
      me = await json('/me');
      $('shopName').textContent = me.name;
      $('shopMeta').textContent = [me.gstin ? 'GSTIN ' + me.gstin : 'No GSTIN', me.state_name].filter(Boolean).join(' · ');
      document.title = me.name + ' · Khata';
      $('adminTab').hidden = !me.admin;
      $('ledger').hidden = false; $('logout').hidden = false;
      await refresh();
    } catch (e) { if (e.message !== 'signed out') { $('signin').hidden = false; $('signinError').textContent = e.message; } }
  })();
})();
