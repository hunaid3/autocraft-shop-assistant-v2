/* AutoCraft shop dashboard. Talks only to /api on this same site (proxied to the engine). */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const BOT = '917013539950';
  const KEY = 'autocraft.session';
  const store = {
    get() { try { return localStorage.getItem(KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(KEY, v); } catch { /* private mode: lasts this tab */ } },
    clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
  };
  let session = store.get();
  let PERIOD = 'month';
  let STOCK_FILTER = 'all';
  let me = null;
  let SUM = null;
  const LISTS = {};
  const loaded = new Set();

  // ── Formatting (₹ in the Indian way: 1,23,456) ───────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function inr(rupees) {
    let n = Number(rupees) || 0; const neg = n < 0; n = Math.abs(n);
    const f = n.toFixed(n % 1 ? 2 : 0).split('.'); const i = f[0]; let last3 = i.slice(-3); const rest = i.slice(0, -3);
    if (rest) last3 = ',' + last3;
    return (neg ? '−' : '') + '₹' + rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + last3 + (f[1] ? '.' + f[1] : '');
  }
  const rs = (paise) => inr(Math.round(Number(paise || 0)) / 100);
  function short(paise) {
    const n = Number(paise || 0) / 100; const a = Math.abs(n); const s = n < 0 ? '−' : '';
    if (a >= 1e7) return s + '₹' + (a / 1e7).toFixed(a >= 1e8 ? 0 : 2).replace(/\.?0+$/, '') + ' Cr';
    if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(a >= 1e6 ? 1 : 2).replace(/\.?0+$/, '') + ' L';
    return inr(Math.round(n));
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fdate(d, year) {
    if (!d) return '';
    const s = String(d).slice(0, 10);
    return Number(s.slice(8, 10)) + ' ' + MON[Number(s.slice(5, 7)) - 1] + (year ? ' ' + s.slice(0, 4) : '');
  }
  const qty = (n) => String(Math.round(Number(n) * 1000) / 1000);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const PERIOD_LABEL = { today: 'today', yesterday: 'yesterday', this_week: 'this week', month: 'this month', last_month: 'last month', fy: 'this financial year' };

  // ── API ──────────────────────────────────────────────────────────────────
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      ...opts,
      headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(session ? { authorization: 'Bearer ' + session } : {}) }
    });
    if (res.status === 401) { signOut('Your sign-in has ended. Send dashboard on WhatsApp for a new link.'); throw new Error('signed out'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Something went wrong (${res.status}). Please try again.`);
    return res;
  }
  const json = async (path, opts) => (await api(path, opts)).json();
  function showError(e) {
    if (e && e.message === 'signed out') return;
    const el = $('err'); el.textContent = (e && e.message) || 'Could not load data.'; el.classList.add('on');
  }

  function signOut(message) {
    session = null; store.clear();
    $('app').hidden = true; $('periods').hidden = true; $('logout').hidden = true; $('creditChip').hidden = true; $('loading').hidden = true;
    $('signin').hidden = false; $('biz').textContent = 'AutoCraft Shop Dashboard'; $('updated').textContent = 'Signed out';
    $('signinError').textContent = message || '';
  }

  async function redeemLinkInUrl() {
    const m = /[#&]login=([A-Za-z0-9_-]{20,100})/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname); // the link works once; keep it out of history
    const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: m[1] }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { signOut((body.error || 'This link has expired. Send dashboard on WhatsApp for a new one.').replace(/\*/g, '')); return; }
    session = body.session; store.set(session);
  }

  // ── Summary: tiles, chart, top items ─────────────────────────────────────
  async function load(p) {
    PERIOD = p;
    document.querySelectorAll('#periods button').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
    $('updated').textContent = 'Loading…';
    loaded.clear();
    try {
      SUM = await json('/summary?period=' + p);
      renderSummary();
      await loadTab(currentTab());
      // counts on the tabs
      for (const t of ['invoices', 'quotations', 'purchases', 'expenses', 'stock', 'unbilled']) if (!loaded.has(t)) loadList(t).catch(() => {});
      for (const t of ['customers', 'suppliers']) if (!loaded.has(t)) loadParties(t).catch(() => {});
    } catch (e) { showError(e); }
  }

  function renderSummary() {
    const s = SUM;
    $('loading').hidden = true; $('app').hidden = false;
    const now = new Date();
    $('updated').textContent = `Showing ${PERIOD_LABEL[PERIOD]} (${fdate(s.from)}${s.from !== s.to ? ' – ' + fdate(s.to) : ''}) · updated ${now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;
    const attention = s.stock.low + s.stock.out + s.stock.not_recorded + s.unbilled.open;
    const topCat = (s.expense_by_category || [])[0];
    const c = s.credits;
    const expiring = c.expiring_30d ? `${c.expiring_30d} expire by ${fdate(c.next_expiry, true)}` : (c.next_expiry ? `valid till ${fdate(c.next_expiry, true)}+` : 'none yet');
    const cards = [
      { l: 'Sales', v: short(s.sales.total), n: plural(s.sales.count, 'invoice', 'invoices') + ' · GST ' + short(s.sales.gst) },
      { l: 'Purchases', v: short(s.purchases.total), n: plural(s.purchases.count, 'bill', 'bills') },
      { l: 'Expenses', v: short(s.expenses.total), n: topCat ? `${topCat.category} highest` : 'none recorded' },
      { l: 'Est. profit', v: short(s.profit_estimate.net), n: s.profit_estimate.items_without_cost ? 'some items have no buy price' : 'sales − cost − expenses', neg: s.profit_estimate.net < 0 },
      { l: 'Stock value', v: short(s.stock.value), n: plural(s.stock.items, 'item', 'items') + ' · at cost' },
      { l: 'Open quotes', v: String(s.quotes.open), n: short(s.quotes.total) + ' quoted' },
      { l: 'Needs attention', v: String(attention), n: `${s.stock.low} low · ${s.stock.out} out · ${s.stock.not_recorded} not recorded · ${s.unbilled.open} without bill`, alert: attention > 0 },
      { l: 'Credits', v: String(c.balance), n: expiring, alert: c.balance < 20 || c.expiring_30d > 0, html: `<div class="n"><a href="https://wa.me/${BOT}?text=recharge" target="_blank" rel="noopener">Recharge on WhatsApp</a></div>` }
    ];
    $('kpis').innerHTML = cards.map((k) => `<div class="kpi${k.alert ? ' alert' : ''}"><div class="l">${esc(k.l)}</div><div class="v${k.neg ? ' neg' : ''}">${esc(k.v)}</div><div class="n">${esc(k.n)}</div>${k.html || ''}</div>`).join('');
    const chip = $('creditChip'); chip.hidden = false; chip.textContent = `${c.balance} credits`; chip.classList.toggle('low', c.balance < 20);
    drawChart(s.trend30);
    $('topLbl').textContent = '· ' + PERIOD_LABEL[PERIOD];
    $('top').innerHTML = s.top_items.length
      ? '<ul>' + s.top_items.map((t) => `<li><span>${esc(t.name)}<div class="q">${qty(t.qty)} sold</div></span><b>${rs(t.taxable)}</b></li>`).join('') + '</ul>'
      : '<div class="muted small">No billed sales in this period.</div>';
  }

  function drawChart(rows) {
    const el = $('chart');
    if (!rows || !rows.length) { el.innerHTML = ''; return; }
    const W = 640, H = 150, padB = 4, max = Math.max(1, ...rows.map((r) => r.total));
    const bw = (W - 4) / rows.length;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Daily billed sales, last 30 days"><g class="bars">`;
    rows.forEach((r, i) => {
      const h = r.total ? Math.max(3, (H - padB - 8) * r.total / max) : 2; const x = 4 + i * bw + 2; const y = H - padB - h;
      svg += `<rect class="b${r.total ? '' : ' zero'}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(bw - 4, 1).toFixed(1)}" height="${h.toFixed(1)}" rx="2" data-i="${i}"><title>${fdate(r.day)}: ${rs(r.total)}</title></rect>`;
    });
    svg += `</g></svg><div class="axis"><span>${fdate(rows[0].day)}</span><span>${fdate(rows[Math.floor(rows.length / 2)].day)}</span><span>${fdate(rows[rows.length - 1].day)}</span></div>`;
    el.innerHTML = svg;
    const total = rows.reduce((a, r) => a + r.total, 0);
    $('tip').textContent = '30-day total ' + rs(total) + ' · tap a bar for the day';
    el.querySelectorAll('rect.b').forEach((b) => b.addEventListener('click', () => { const r = rows[Number(b.dataset.i)]; $('tip').textContent = fdate(r.day) + ': ' + rs(r.total); }));
  }

  // ── Tables ───────────────────────────────────────────────────────────────
  function table(cols, rows, empty) {
    if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
    return '<table class="stack"><thead><tr>' + cols.map((c) => `<th class="${c.r ? 'r' : ''}">${esc(c.h)}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map((row) => '<tr>' + cols.map((c, i) => `<td class="${c.r ? 'r' : ''}${i === 0 ? ' title' : ''}" data-l="${esc(c.h)}"><span>${c.f(row)}</span></td>`).join('') + '</tr>').join('') +
      '</tbody></table>';
  }
  const dash = '<span class="muted">—</span>';
  const pdfBtn = (kind, r) => (r.has_pdf ? `<button class="pdf" data-pdf="${kind}" data-id="${esc(r.id)}" data-no="${esc(r.number)}">PDF</button>` : '<span class="tag">PDF pending</span>');

  async function loadList(name) {
    const r = await json(`/${name}?period=${PERIOD}`);
    LISTS[name] = r.rows; loaded.add(name);
    const cnt = $('c-' + name); if (cnt) cnt.textContent = r.rows.length;
    if (RENDER[name]) RENDER[name](r);
  }

  const STATUS = { ok: 'In stock', low: 'Low', out: 'Out of stock', not_recorded: 'Not recorded' };
  const REASON = { cash_sale_no_bill: 'Sold without bill', sample_demo: 'Sample', on_approval: 'On approval', internal_use: 'Shop use', damaged_lost: 'Damaged / lost', branch_transfer: 'Branch transfer', other: 'Other' };
  const SOURCE = { typed: 'typed', bill_image: 'bill photo', bill_pdf: 'bill PDF', import: 'upload' };
  const range = (r) => (r.from ? `${fdate(r.from, true)}${r.from !== r.to ? ' – ' + fdate(r.to, true) : ''}` : '');

  const RENDER = {
    stock() {
      const q = ($('q').value || '').toLowerCase();
      const all = LISTS.stock || [];
      const rows = all.filter((r) => (!q || r.name.toLowerCase().includes(q) || (r.sku || '').toLowerCase().includes(q)) && (STOCK_FILTER !== 'attention' || r.status !== 'ok'));
      $('stockTbl').innerHTML = table([
        { h: 'Item', f: (r) => esc(r.name) + (r.sku ? ` <span class="muted small">${esc(r.sku)}</span>` : '') },
        { h: 'In stock', r: 1, f: (r) => `<span class="${r.qty < 0 ? 'neg' : ''}">${qty(r.qty)}</span> <span class="muted small">${esc(r.unit)}</span>` },
        { h: 'Sell price', r: 1, f: (r) => (Number(r.sale_price_paise) ? rs(r.sale_price_paise) : dash) },
        { h: 'GST', r: 1, f: (r) => r.gst_rate + '%' },
        { h: 'Value', r: 1, f: (r) => rs(r.value_paise) },
        { h: 'Status', f: (r) => `<span class="tag ${r.status}">${STATUS[r.status]}</span>` },
        { h: 'Last movement', f: (r) => (r.last_movement ? fdate(r.last_movement) : dash) }
      ], rows, all.length ? 'No items match.' : 'No items yet. They appear here as soon as you bill, buy or count them on WhatsApp, or send your item list as an Excel file.');
    },
    invoices(r) {
      $('invLbl').textContent = range(r);
      $('invTbl').innerHTML = table([
        { h: 'Invoice', f: (x) => esc(x.number) },
        { h: 'Date', f: (x) => fdate(x.date) },
        { h: 'Customer', f: (x) => esc(x.customer) || dash },
        { h: 'GST', r: 1, f: (x) => rs(x.gst_paise) },
        { h: 'Total', r: 1, f: (x) => '<b>' + rs(x.total_paise) + '</b>' },
        { h: 'Status', f: (x) => `<span class="tag ${esc(x.status)}">${esc(x.status)}</span>` },
        { h: 'PDF', r: 1, f: (x) => pdfBtn('invoice', x) }
      ], r.rows, 'No invoices ' + PERIOD_LABEL[PERIOD] + '. Send "bill Ravi 2 airdopes at 1250" on WhatsApp to make one.');
    },
    quotations(r) {
      $('quoLbl').textContent = range(r);
      $('quoTbl').innerHTML = table([
        { h: 'Quote', f: (x) => esc(x.number) },
        { h: 'Date', f: (x) => fdate(x.date) },
        { h: 'Customer', f: (x) => esc(x.customer) || dash },
        { h: 'Valid till', f: (x) => fdate(x.valid_until) },
        { h: 'Total', r: 1, f: (x) => '<b>' + rs(x.total_paise) + '</b>' },
        { h: 'Status', f: (x) => `<span class="tag ${esc(x.status)}">${esc(String(x.status).replace(/_/g, ' '))}</span>` },
        { h: 'PDF', r: 1, f: (x) => pdfBtn('quotation', x) }
      ], r.rows, 'No quotations ' + PERIOD_LABEL[PERIOD] + '. Send "quote Ravi 10 airdopes at 1200" on WhatsApp.');
    },
    purchases(r) {
      $('purLbl').textContent = range(r);
      $('purTbl').innerHTML = table([
        { h: 'Supplier', f: (x) => esc(x.supplier) || dash },
        { h: 'Date', f: (x) => fdate(x.date) },
        { h: 'Bill no.', f: (x) => esc(x.bill_no) || dash },
        { h: 'Items', r: 1, f: (x) => x.lines },
        { h: 'GST', r: 1, f: (x) => rs(x.gst_paise) },
        { h: 'Total', r: 1, f: (x) => '<b>' + rs(x.total_paise) + '</b>' },
        { h: 'Entered as', f: (x) => esc(SOURCE[x.source] || x.source) }
      ], r.rows, 'No purchases ' + PERIOD_LABEL[PERIOD] + '. Send a photo of a supplier bill on WhatsApp.');
    },
    expenses(r) {
      $('expLbl').textContent = range(r);
      const cats = (SUM && SUM.expense_by_category) || []; const tot = cats.reduce((a, c) => a + c.total, 0);
      $('expCats').innerHTML = cats.length ? '<div class="card first">' + cats.map((c) => {
        const pct = tot ? c.total / tot * 100 : 0;
        return `<div style="margin:8px 0"><div style="display:flex;justify-content:space-between"><span>${esc(c.category)}</span><b>${rs(c.total)}</b></div>` +
          `<div style="height:6px;background:var(--chip);border-radius:3px;margin-top:4px"><div style="height:6px;width:${pct.toFixed(1)}%;background:var(--ink);border-radius:3px"></div></div></div>`;
      }).join('') + '</div>' : '';
      $('expTbl').innerHTML = table([
        { h: 'For', f: (x) => esc(x.category) + (x.note ? `<div class="muted small">${esc(x.note)}</div>` : '') },
        { h: 'Date', f: (x) => fdate(x.date) },
        { h: 'Paid to', f: (x) => esc(x.paid_to) || dash },
        { h: 'Mode', f: (x) => esc(x.mode) },
        { h: 'Amount', r: 1, f: (x) => '<b>' + rs(x.amount_paise) + '</b>' }
      ], r.rows, 'No expenses ' + PERIOD_LABEL[PERIOD] + '. Send "paid 3500 shop rent cash" on WhatsApp.');
    },
    unbilled(r) {
      $('uoTbl').innerHTML = table([
        { h: 'Item', f: (x) => esc(x.item) },
        { h: 'Date', f: (x) => fdate(x.date) },
        { h: 'Qty', r: 1, f: (x) => qty(x.qty) },
        { h: 'Reason', f: (x) => esc(REASON[x.reason] || x.reason) + (x.party_name ? `<div class="muted small">${esc(x.party_name)}</div>` : '') },
        { h: 'Est. value', r: 1, f: (x) => (Number(x.est_value_paise) ? rs(x.est_value_paise) : dash) },
        { h: 'Status', f: (x) => `<span class="tag ${x.status === 'open' ? 'open' : 'ok'}">${esc(String(x.status).replace(/_/g, ' '))}</span>` }
      ], r.rows, 'Nothing pending: every item that left has a bill.');
    }
  };

  // ── Customers and suppliers ──────────────────────────────────────────────
  const PARTY = {};
  const phoneOf = (p) => (p ? (String(p).startsWith('91') && String(p).length === 12 ? '+91 ' + String(p).slice(2, 7) + ' ' + String(p).slice(7) : '+' + p) : '');
  function renderParties(kind) {
    const q = ($(kind === 'customers' ? 'qc' : 'qs').value || '').toLowerCase();
    const all = PARTY[kind] || [];
    const rows = all.filter((r) => !q || [r.name, r.gstin, r.phone].some((v) => String(v || '').toLowerCase().includes(q)));
    const cust = kind === 'customers';
    $(cust ? 'cusTbl' : 'supTbl').innerHTML = table([
      { h: 'Name', f: (r) => esc(r.name) + (r.address ? `<div class="muted small">${esc(r.address)}</div>` : '') },
      { h: 'GSTIN', f: (r) => (r.gstin ? esc(r.gstin) : '<span class="muted">Unregistered</span>') },
      { h: 'Phone', f: (r) => (r.phone ? `<a href="https://wa.me/${esc(r.phone)}" target="_blank" rel="noopener">${esc(phoneOf(r.phone))}</a>` : dash) },
      { h: 'State', f: (r) => esc(r.state_name) || dash },
      { h: cust ? 'Bills' : 'Purchases', r: 1, f: (r) => r.docs },
      { h: cust ? 'Billed' : 'Bought', r: 1, f: (r) => rs(r.total_paise) },
      { h: 'Last', f: (r) => (r.last_date ? fdate(r.last_date, true) : dash) }
    ], rows, all.length ? 'No one matches.' : cust ? 'No customers yet. Bill a customer by name on WhatsApp and they appear here.' : 'No suppliers yet. Enter a purchase with the supplier name and they appear here.');
  }
  async function loadParties(kind) {
    PARTY[kind] = (await json('/' + kind)).rows;
    $('c-' + kind).textContent = PARTY[kind].length;
    renderParties(kind); loaded.add(kind);
  }

  // ── Credits tab ──────────────────────────────────────────────────────────
  const KIND = { debit: 'Used', signup_bonus: 'Welcome credits', top_up: 'Recharge', refund: 'Refund', expiry: 'Expired', admin_adjust: 'From AutoCraft', referral: 'Referral' };
  // Phones: share the picture with the caption (WhatsApp keeps it under the poster). Elsewhere: the text with the link.
  async function shareReferral(ref) {
    try {
      const blob = await (await fetch(ref.poster)).blob();
      const file = new File([blob], 'AutoCraft-poster.jpg', { type: 'image/jpeg' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.clipboard.writeText(ref.share_text); } catch { /* not allowed: fine */ }
        await navigator.share({ files: [file], text: ref.share_text });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // they closed the share sheet
    }
    window.open('https://wa.me/?text=' + encodeURIComponent(ref.share_text), '_blank', 'noopener');
  }
  async function loadCredits() {
    const [lots, led, rinv, ref] = await Promise.all([json('/credits/lots'), json('/credits'), json('/recharge_invoices'), json('/referral')]);
    const c = SUM ? SUM.credits : { balance: 0 };
    $('creditBox').innerHTML = `<div class="credit-head"><div><div class="muted small">Balance</div><div class="big">${c.balance} credits</div>` +
      `<div class="muted small">1 credit = ₹1 · each recharge lasts 24 months · older credits are used first</div></div>` +
      `<a class="btn" href="https://wa.me/${BOT}?text=recharge" target="_blank" rel="noopener">Recharge on WhatsApp</a></div>` +
      `<div class="referral"><div><div class="muted small">Your referral code</div><div class="big">${esc(ref.code)}</div>` +
      `<div class="muted small">A new shop that joins with it gets ${ref.credits_each} extra credits, and so do you. ` +
      (ref.has_paid ? 'Yours are added as soon as they join.' : 'Yours are added with your first recharge.') + '</div>' +
      `<div class="small">Joined with your code: <b>${ref.joined}</b>${ref.earned ? ` · ${ref.earned} credits earned` : ''}${ref.pending ? ` · <b>${ref.pending} waiting</b>` : ''}</div></div>` +
      `<div class="share"><img src="${esc(ref.poster)}" alt="AutoCraft poster" width="72" height="90">` +
      `<div><button type="button" class="btn" id="shareRef">Share poster on WhatsApp</button>` +
      `<div class="muted small">The poster goes with your link; one tap opens WhatsApp with your code filled in.</div>` +
      `<a class="small" href="${esc(ref.poster)}" download="AutoCraft-poster.jpg">Download poster</a></div></div></div>` +
      '<div class="note">Bill 3 · bill photo read 3 · quote 1 · typed entry 1 · stock out 1 · staff 25 · item list upload 10 (up to 10 items) or 25 (more than 10) · questions and reports free.</div>';
    $('shareRef').addEventListener('click', () => shareReferral(ref));
    const soon = Date.now() + 30 * 86400000;
    $('lotTbl').innerHTML = table([
      { h: 'From', f: (x) => esc(KIND[x.source] || x.source) },
      { h: 'Received', f: (x) => fdate(x.created_at, true) },
      { h: 'Left', r: 1, f: (x) => `${x.credits_remaining} <span class="muted small">of ${x.credits_granted}</span>` },
      { h: 'Valid till', f: (x) => fdate(x.expires_at, true) + (Date.parse(x.expires_at) < soon ? ' <span class="tag expiring">soon</span>' : '') }
    ], lots.rows, 'No credits right now. Recharge on WhatsApp to continue billing.');
    $('rinvTbl').innerHTML = table([
      { h: 'Invoice', f: (x) => esc(x.number) },
      { h: 'Date', f: (x) => fdate(x.date, true) },
      { h: 'Credits', r: 1, f: (x) => x.credits },
      { h: 'GST', r: 1, f: (x) => rs(x.gst_paise) },
      { h: 'Paid', r: 1, f: (x) => '<b>' + rs(x.total_paise) + '</b>' },
      { h: 'PDF', r: 1, f: (x) => (x.has_pdf ? `<button class="pdf" data-pdf="recharge" data-id="${esc(x.id)}">PDF</button>` : '<span class="tag">PDF pending</span>') }
    ], rinv.rows, 'GST invoices for your recharges appear here.');
    $('ledTbl').innerHTML = table([
      { h: 'Date', f: (x) => fdate(x.created_at, true) },
      { h: 'What', f: (x) => esc(x.kind === 'debit' && x.action_code ? 'Used: ' + x.action_code.replace(/_/g, ' ') : (KIND[x.kind] || x.kind)) + (x.note && x.note !== KIND[x.kind] ? `<div class="muted small">${esc(x.note)}</div>` : '') },
      { h: 'Change', r: 1, f: (x) => `<span class="${x.delta < 0 ? 'neg' : 'pos'}">${x.delta > 0 ? '+' : ''}${x.delta}</span>` },
      { h: 'Balance', r: 1, f: (x) => x.balance_after }
    ], led.rows, 'No credit movements yet.');
    loaded.add('credits');
  }

  // ── Settings tab ─────────────────────────────────────────────────────────
  let SETTINGS = null;
  const F = () => $('settingsForm').elements;
  async function loadSettings() {
    SETTINGS = await json('/settings');
    const s = SETTINGS; const f = F();
    $('gstSel').innerHTML = s.gst_rates.map((r) => `<option value="${r}">${r}%</option>`).join('');
    for (const k of ['name', 'legal_name', 'address', 'email', 'upi_id', 'bank_account_name', 'bank_name', 'bank_account_no', 'bank_ifsc', 'invoice_prefix', 'quotation_prefix', 'quotation_validity_days', 'low_stock_default']) f[k].value = s[k] ?? '';
    f.phone.value = s.phone ? (s.phone.startsWith('91') && s.phone.length === 12 ? s.phone.slice(2) : '+' + s.phone) : '';
    f.quotation_title.value = s.quotation_title; f.default_gst_rate.value = String(s.default_gst_rate);
    f.prices_include_gst.value = String(s.prices_include_gst); f.stock_shortfall.value = s.stock_shortfall;
    f.invoice_terms.value = (s.invoice_terms || []).join('\n');
    $('gstinRO').textContent = s.gstin ? `${s.gstin} · ${s.state_name}` : `None · ${s.state_name} (bills of supply, no GST)`;
    f.invoice_prefix.disabled = s.prefix_locked;
    $('prefixNote').textContent = s.prefix_locked
      ? `Locked for ${s.fy}: this year's bills already use ${s.invoice_prefix}. You can change it from 1 April.`
      : 'Numbers look like ' + (s.invoice_prefix || 'INV') + '/' + s.fy + '/0001. Changeable until the first bill of the year.';
    for (const k of ['sales', 'cgst', 'sgst', 'igst', 'roundOff', 'cashParty']) f['t_' + k].value = s.tally_ledgers?.[k] ?? '';
    await showLogo(s.has_logo);
    loaded.add('settings');
  }
  async function showLogo(has) {
    const box = $('logoBox'); $('logoRemove').hidden = !has;
    if (!has) { box.innerHTML = '<span class="muted small">No logo</span>'; return; }
    try {
      const url = URL.createObjectURL(await (await api('/settings/logo')).blob());
      box.innerHTML = ''; const img = new Image(); img.alt = 'Shop logo'; img.src = url; box.append(img);
    } catch { box.innerHTML = '<span class="muted small">Logo saved</span>'; }
  }
  function formValues() {
    const f = F(); const out = {};
    for (const k of ['name', 'legal_name', 'address', 'phone', 'email', 'upi_id', 'bank_account_name', 'bank_name', 'bank_account_no', 'bank_ifsc', 'quotation_prefix', 'quotation_title', 'stock_shortfall']) out[k] = f[k].value.trim();
    if (!f.invoice_prefix.disabled) out.invoice_prefix = f.invoice_prefix.value.trim();
    out.quotation_validity_days = Number(f.quotation_validity_days.value);
    out.low_stock_default = Number(f.low_stock_default.value || 0);
    out.default_gst_rate = Number(f.default_gst_rate.value);
    out.prices_include_gst = f.prices_include_gst.value === 'true';
    out.invoice_terms = f.invoice_terms.value.split('\n').map((x) => x.trim()).filter(Boolean);
    out.tally_ledgers = Object.fromEntries(['sales', 'cgst', 'sgst', 'igst', 'roundOff', 'cashParty'].map((k) => [k, f['t_' + k].value.trim()]));
    // send only what changed, so an untouched field is never rewritten
    const s = SETTINGS; const phoneNow = s.phone ? (s.phone.startsWith('91') && s.phone.length === 12 ? s.phone.slice(2) : '+' + s.phone) : '';
    for (const k of Object.keys(out)) {
      const before = k === 'phone' ? phoneNow : k === 'invoice_terms' ? (s.invoice_terms || []) : k === 'tally_ledgers' ? s.tally_ledgers : s[k] ?? '';
      if (JSON.stringify(before) === JSON.stringify(out[k]) || (before === null && out[k] === '')) delete out[k];
    }
    return out;
  }
  async function saveSettings(e) {
    e.preventDefault();
    const msg = $('saveMsg'); const btn = e.submitter || $('settingsForm').querySelector('button[type=submit]');
    const body = formValues();
    if (!Object.keys(body).length) { msg.className = 'small'; msg.textContent = 'Nothing changed.'; return; }
    btn.disabled = true; msg.className = 'small'; msg.textContent = 'Saving…';
    try {
      await json('/settings', { method: 'PUT', body: JSON.stringify(body) });
      msg.className = 'small ok'; msg.textContent = '✓ Saved. New bills use these details.';
      await loadSettings(); refreshMe();
    } catch (err) { msg.className = 'small bad'; msg.textContent = err.message.replace(/\*/g, ''); }
    finally { btn.disabled = false; }
  }
  async function uploadLogo(file) {
    const msg = $('saveMsg');
    if (!/^image\/(png|jpeg)$/.test(file.type) || file.size > 2 * 1024 * 1024) { msg.className = 'small bad'; msg.textContent = 'Please choose a PNG or JPG under 2 MB.'; return; }
    const data = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = bad; r.readAsDataURL(file); });
    try {
      await json('/settings/logo', { method: 'POST', body: JSON.stringify({ data }) });
      msg.className = 'small ok'; msg.textContent = '✓ Logo saved.'; await showLogo(true);
    } catch (err) { msg.className = 'small bad'; msg.textContent = err.message; }
  }

  // ── Admin tab (AutoCraft team only) ──────────────────────────────────────
  async function loadAdmin() {
    const per = '?period=' + PERIOD;
    const [sum, shops, support, jobs, pays, use, nums, refs] = await Promise.all([json('/admin/summary' + per), json('/admin/shops'), json('/admin/support?status=open'),
      json('/admin/jobs'), json('/admin/payments' + per), json('/admin/usage' + per), json('/admin/numbers'), json('/admin/referrals')]);
    const mutedNow = nums.rows.filter((r) => r.kind === 'muted' && Date.parse(r.until) > Date.now());
    const tile = (l, v, n, alert) => `<div class="kpi${alert ? ' alert' : ''}"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div><div class="n">${esc(n)}</div></div>`;
    const totalAi = use.rows.reduce((a, r) => a + Number(r.ai_cost_paise), 0);
    const STATUS_TAG = { active: 'ok', suspended: 'out', closed: 'cancelled' };
    $('adminBox').innerHTML =
      `<h3>AutoCraft overview <small>· ${esc(PERIOD_LABEL[PERIOD])} (${fdate(sum.from)}${sum.from !== sum.to ? ' – ' + fdate(sum.to) : ''})</small></h3>` +
      '<section class="kpis">' +
        tile('Shops', String(sum.shops), `${sum.active_shops} active · ${sum.suspended_shops} paused`) +
        tile('New shops', String(sum.new_in_period), `${sum.new_7d} in 7 days · ${sum.new_30d} in 30 days`) +
        tile('Active (7 days)', String(sum.active_7d), 'shops that messaged') +
        tile('Recharges', short(sum.revenue_paise), `${plural(sum.paid_count, 'payment', 'payments')} · GST ${short(sum.gst_paise)}`) +
        tile('Credits', `${sum.credits_sold} sold`, `${sum.credits_used} used`) +
        tile('Bills made', String(sum.bills), 'all shops') +
        tile('AI cost (est.)', rs(totalAi), 'OpenAI, this period') +
        tile('Needs you', String(support.rows.length + jobs.rows.length), `${support.rows.length} support · ${jobs.rows.length} failed jobs`, support.rows.length + jobs.rows.length > 0) +
      '</section>' +
      `<h3>Support requests <small>· ${support.rows.length} open</small></h3>` + table([
        { h: 'Ref', f: (r) => `SR-${String(r.ref_no).padStart(4, '0')}<div class="muted small">${fdate(r.created_at, true)}</div>` },
        { h: 'From', f: (r) => `${esc(r.tenant_name || 'not registered')}<div class="muted small">+${esc(r.phone)} ${esc(r.role || '')}</div>` },
        { h: 'Problem', f: (r) => esc(r.problem) },
        { h: '', r: 1, f: (r) => `<a class="pdf" href="https://wa.me/${esc(r.phone)}" target="_blank" rel="noopener">WhatsApp</a> <button class="pdf" data-close="${esc(r.id)}">Mark done</button>` }
      ], support.rows, 'No open requests.') +
      `<div class="tools"><h3 class="grow">Shops <small>· ${shops.rows.length}</small></h3><button class="csv" data-aexport="shops.csv">Download CSV</button></div>` + table([
        { h: 'Shop', f: (s) => `${esc(s.name)}<div class="muted small">${esc(s.gstin || 'no GSTIN')} · ${esc(s.state_code)} · since ${fdate(s.created_at, true)}</div>` },
        { h: 'Status', f: (s) => `<span class="tag ${STATUS_TAG[s.status] || ''}">${s.status === 'suspended' ? 'paused' : esc(s.status)}</span>` },
        { h: 'Owner', f: (s) => `${esc(s.owner_name || '')}<div class="muted small">${s.owner_phone ? '+' + esc(s.owner_phone) : ''}</div>` },
        { h: 'Staff', r: 1, f: (s) => s.staff },
        { h: 'Credits', r: 1, f: (s) => s.credits },
        { h: 'Bills', r: 1, f: (s) => s.invoices },
        { h: 'Last message', f: (s) => (s.last_message_at ? fdate(s.last_message_at, true) : dash) },
        { h: '', r: 1, f: (s) => `<button class="pdf" data-people="${esc(s.tenant_id)}" data-name="${esc(s.name)}">People</button> ` +
            `<button class="pdf" data-grant="${esc(s.tenant_id)}" data-name="${esc(s.name)}">Give credits</button> ` +
            (s.status === 'closed' ? '' : `<button class="pdf" data-status="${s.status === 'suspended' ? 'active' : 'suspended'}" data-shop="${esc(s.tenant_id)}" data-name="${esc(s.name)}">${s.status === 'suspended' ? 'Reactivate' : 'Pause'}</button>`) }
      ], shops.rows, 'No shops yet.') +
      '<div id="adminPeople"></div>' +
      `<div class="tools"><h3 class="grow">Payments <small>· ${pays.rows.length} ${esc(PERIOD_LABEL[PERIOD])}</small></h3><button class="csv" data-aexport="payments.csv">Download CSV</button></div>` + table([
        { h: 'Date', f: (p) => fdate(p.created_at, true) },
        { h: 'Shop', f: (p) => esc(p.shop) },
        { h: 'Pack', f: (p) => `${esc(p.pack)} · ${p.credits} credits` },
        { h: 'Amount', r: 1, f: (p) => '<b>' + rs(p.amount_paise) + '</b>' },
        { h: 'Status', f: (p) => `<span class="tag ${p.status === 'paid' ? 'paid' : p.status === 'created' ? 'open' : 'expired'}">${p.status === 'created' ? 'link sent' : esc(p.status)}</span>` },
        { h: 'Razorpay ID', f: (p) => (p.provider_payment_id ? `<span class="small">${esc(p.provider_payment_id)}</span>` : dash) },
        { h: 'GST invoice', r: 1, f: (p) => (p.invoice_number ? (p.has_pdf ? `<button class="pdf" data-apdf="${esc(p.tenant_id)}/${esc(p.invoice_id)}">${esc(p.invoice_number)}</button>` : esc(p.invoice_number)) : dash) }
      ], pays.rows, 'No payments in this period.') +
      `<div class="tools"><h3 class="grow">Usage and cost <small>· ${esc(PERIOD_LABEL[PERIOD])}</small></h3><button class="csv" data-aexport="usage.csv">Download CSV</button></div>` + table([
        { h: 'Shop', f: (u) => esc(u.shop) },
        { h: 'Messages in / out', r: 1, f: (u) => `${u.msgs_in} / ${u.msgs_out}` + (Number(u.templates_out) ? `<div class="muted small">${u.templates_out} paid templates</div>` : '') },
        { h: 'AI reads', r: 1, f: (u) => `${u.ai_text} text · ${u.ai_bill} bills` },
        { h: 'Tokens', r: 1, f: (u) => `${Number(u.prompt_tokens).toLocaleString('en-IN')} + ${Number(u.completion_tokens).toLocaleString('en-IN')}` },
        { h: 'Est. AI cost', r: 1, f: (u) => rs(u.ai_cost_paise) },
        { h: 'Credits used', r: 1, f: (u) => u.credits_used }
      ], use.rows, 'No shops yet.') +
      `<div class="note">AI cost uses $${use.prices.usd_per_m_input} / $${use.prices.usd_per_m_output} per million tokens (input / output) at ₹${use.prices.inr_per_usd} per dollar. Replies inside the 24-hour chat window are free on WhatsApp; paid templates are counted separately.</div>` +
      `<h3>Referrals <small>· ${refs.rows.length}</small></h3>` + table([
        { h: 'When', f: (r) => fdate(r.created_at, true) },
        { h: 'Code', f: (r) => esc(r.code) },
        { h: 'Referred by', f: (r) => esc(r.referrer || 'closed shop') + ` <span class="tag ${r.referrer_status === 'granted' ? 'ok' : 'open'}">${r.referrer_status === 'granted' ? 'added' : 'waiting'}</span>` },
        { h: 'New shop', f: (r) => esc(r.referred || 'closed shop') + ` <span class="tag ${r.joiner_status === 'granted' ? 'ok' : 'open'}">${r.joiner_status === 'granted' ? 'added' : 'waiting'}</span>` },
        { h: 'Credits each', r: 1, f: (r) => r.credits }
      ], refs.rows, 'No referrals yet.') +
      `<h3>Blocked and paused numbers <small>· ${nums.rows.filter((r) => r.kind === 'blocked').length} blocked · ${mutedNow.length} paused now</small></h3>` +
      '<div class="tools"><input type="search" id="blockPhone" placeholder="Number to block, e.g. 919876543210" aria-label="Number to block" inputmode="tel">' +
      '<button class="csv" data-block="1">Block number</button></div>' + table([
        { h: 'Number', f: (r) => `+${esc(r.phone)}` + (r.shop ? `<div class="muted small">${esc(r.shop)}</div>` : '') },
        { h: 'Status', f: (r) => (r.kind === 'blocked' ? '<span class="tag cancelled">blocked</span>'
          : Date.parse(r.until) > Date.now() ? `<span class="tag out">paused till ${new Date(r.until).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</span>` : '<span class="tag">was paused</span>') },
        { h: 'Why', f: (r) => esc(r.reason || '') + (r.kind === 'muted' ? `<div class="muted small">${r.replies} replies in 3 min · ${plural(r.times, 'time', 'times')}</div>` : '') },
        { h: 'Since', f: (r) => fdate(r.created_at, true) },
        { h: '', r: 1, f: (r) => (r.kind === 'blocked' || Date.parse(r.until) > Date.now() ? `<button class="pdf" data-unblock="${esc(r.phone)}">${r.kind === 'blocked' ? 'Unblock' : 'Resume replies'}</button>` : '') }
      ], nums.rows, 'None. Numbers you block, and numbers the loop breaker pauses (more than 8 replies in 3 minutes with nothing confirmed), show here.') +
      '<div class="note">A blocked number never gets a reply. Numbers that are not shops get the welcome card at most once a day, and bank alerts, OTPs and adverts get no reply. Their messages are still kept.</div>' +
      `<h3>Failed jobs <small>· ${jobs.rows.length}</small></h3>` + table([
        { h: 'Job', f: (j) => `#${j.id} ${esc(j.queue)}` },
        { h: 'When', f: (j) => fdate(j.created_at, true) },
        { h: 'Error', f: (j) => esc(j.last_error || '') }
      ], jobs.rows, 'None.');
    loaded.add('admin');
  }
  async function showPeople(tenantId, name) {
    const r = await json(`/admin/shops/${tenantId}/people`);
    $('adminPeople').innerHTML = `<div class="card"><h2>People at ${esc(name)}</h2>` + table([
      { h: 'Name', f: (p) => esc(p.name) || dash },
      { h: 'Phone', f: (p) => `<a href="https://wa.me/${esc(p.phone)}" target="_blank" rel="noopener">+${esc(p.phone)}</a>` },
      { h: 'Role', f: (p) => (p.role === 'owner' ? 'Owner' : p.status === 'invited' ? 'Staff (invited)' : 'Staff') },
      { h: '', r: 1, f: (p) => (p.role === 'staff' ? `<button class="pdf" data-rmstaff="${esc(p.membership_id)}" data-name="${esc(p.name || p.phone)}" data-shop="${esc(tenantId)}" data-shopname="${esc(name)}">Remove</button>` : '') }
    ], r.rows, 'Nobody active.') + '</div>';
    $('adminPeople').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ── PDFs and CSV ─────────────────────────────────────────────────────────
  async function openPdf(btn) {
    const w = window.open('', '_blank'); // open now so pop-up blockers allow it
    btn.disabled = true; btn.textContent = 'Opening…';
    try {
      const url = URL.createObjectURL(await (await api(`/pdf/${btn.dataset.pdf}/${btn.dataset.id}`)).blob());
      if (w) w.location.href = url; else location.href = url;
    } catch (e) { if (w) w.close(); showError(e); }
    finally { btn.disabled = false; btn.textContent = 'PDF'; }
  }
  async function openUrl(btn, path) {
    const w = window.open('', '_blank');
    const label = btn.textContent; btn.disabled = true; btn.textContent = 'Opening…';
    try {
      const url = URL.createObjectURL(await (await api(path)).blob());
      if (w) w.location.href = url; else location.href = url;
    } catch (e) { if (w) w.close(); showError(e); }
    finally { btn.disabled = false; btn.textContent = label; }
  }
  async function download(name, btn, path) {
    btn.disabled = true;
    try {
      const res = await api(`/${path || 'export/' + name + '.csv'}?period=${PERIOD}`);
      const file = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || `${name}.csv`;
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: file });
      document.body.append(a); a.click(); a.remove();
    } catch (e) { showError(e); } finally { btn.disabled = false; }
  }

  // ── Tabs and wiring ──────────────────────────────────────────────────────
  const currentTab = () => document.querySelector('#tabs button.on')?.dataset.t || 'stock';
  async function loadTab(t) {
    if (loaded.has(t)) { if (t === 'stock') RENDER.stock(); return; }
    if (t === 'credits') return loadCredits();
    if (t === 'settings') return loadSettings();
    if (t === 'admin') return loadAdmin();
    if (t === 'customers' || t === 'suppliers') return loadParties(t);
    return loadList(t);
  }
  async function refreshMe() {
    me = await json('/me');
    $('biz').textContent = me.name;
    document.title = me.name + ' · Dashboard';
    $('adminTab').hidden = !me.admin;
  }

  $('periods').addEventListener('click', (e) => { const b = e.target.closest('button[data-p]'); if (b) load(b.dataset.p); });
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-t]'); if (!b) return;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('on', p.id === 'p-' + b.dataset.t));
    loadTab(b.dataset.t).catch(showError);
  });
  $('q').addEventListener('input', () => RENDER.stock());
  $('qc').addEventListener('input', () => renderParties('customers'));
  $('qs').addEventListener('input', () => renderParties('suppliers'));
  document.querySelectorAll('.filter').forEach((f) => f.addEventListener('click', () => {
    STOCK_FILTER = f.dataset.f;
    document.querySelectorAll('.filter').forEach((x) => x.classList.toggle('on', x === f));
    RENDER.stock();
  }));
  $('app').addEventListener('click', async (e) => {
    // buttons without a type attribute are type=submit, so skip only the settings form's own buttons
    const t = e.target.closest('button'); if (!t || t.closest('#settingsForm')) return;
    if (t.dataset.pdf) return openPdf(t);
    if (t.dataset.csv) return download(t.dataset.csv, t);
    if (t.dataset.pcsv) return download(t.dataset.pcsv, t);
    if (t.dataset.export) return download(t.dataset.export, t, 'export/' + t.dataset.export);
    if (t.dataset.close) { await json(`/admin/support/${t.dataset.close}/close`, { method: 'POST', body: '{}' }).catch(showError); loaded.delete('admin'); return loadAdmin(); }
    if (t.dataset.aexport) return download('admin', t, 'admin/export/' + t.dataset.aexport);
    if (t.dataset.apdf) return openUrl(t, '/admin/pdf/recharge/' + t.dataset.apdf);
    if (t.dataset.people) return showPeople(t.dataset.people, t.dataset.name).catch(showError);
    if (t.dataset.status) {
      const pausing = t.dataset.status === 'suspended';
      const reason = prompt(pausing ? `Pause ${t.dataset.name}? They won't be able to bill or sign in until you reactivate. Reason (kept in the log):` : `Reactivate ${t.dataset.name}? Note (optional):`, '');
      if (reason === null) return;
      try { await json(`/admin/shops/${t.dataset.shop}/status`, { method: 'POST', body: JSON.stringify({ status: t.dataset.status, reason }) }); }
      catch (err) { showError(err); }
      return loadAdmin();
    }
    if (t.dataset.block) {
      const phone = $('blockPhone').value.trim();
      if (!phone) return;
      const reason = prompt(`Block ${phone}? It will never get a reply. Reason (kept in the log):`, 'Spam / automated messages');
      if (reason === null) return;
      try { await json('/admin/numbers/block', { method: 'POST', body: JSON.stringify({ phone, reason }) }); } catch (err) { showError(err); }
      return loadAdmin();
    }
    if (t.dataset.unblock) {
      try { await json(`/admin/numbers/${t.dataset.unblock}/unblock`, { method: 'POST', body: '{}' }); } catch (err) { showError(err); }
      return loadAdmin();
    }
    if (t.dataset.rmstaff) {
      const reason = prompt(`Remove ${t.dataset.name} from ${t.dataset.shopname}? Reason (kept in the log):`, '');
      if (reason === null) return;
      try {
        const r = await json(`/admin/staff/${t.dataset.rmstaff}/remove`, { method: 'POST', body: JSON.stringify({ reason }) });
        if (r.refunded) alert(`Removed. The invite was not yet accepted, so ${r.refunded} credits went back to the shop.`);
      } catch (err) { showError(err); }
      await loadAdmin();
      return showPeople(t.dataset.shop, t.dataset.shopname).catch(showError);
    }
    if (t.dataset.grant) {
      const credits = Number(prompt(`Credits to give ${t.dataset.name} (1 to 10000):`, '50'));
      if (!Number.isInteger(credits) || credits < 1) return;
      const note = prompt('Note for the record (optional):', 'Goodwill') || '';
      try {
        const r = await json('/admin/credits', { method: 'POST', body: JSON.stringify({ tenant_id: t.dataset.grant, credits, note }) });
        alert(`Done. ${t.dataset.name} now has ${r.balance} credits.`);
      } catch (err) { showError(err); }
      return loadAdmin();
    }
  });
  $('settingsForm').addEventListener('submit', saveSettings);
  $('logoPick').addEventListener('click', () => $('logoFile').click());
  $('logoFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) uploadLogo(f); e.target.value = ''; });
  $('logoRemove').addEventListener('click', async () => {
    try { await json('/settings/logo', { method: 'DELETE' }); await showLogo(false); $('saveMsg').className = 'small ok'; $('saveMsg').textContent = '✓ Logo removed.'; }
    catch (err) { showError(err); }
  });
  $('logout').addEventListener('click', async () => { await api('/logout', { method: 'POST', body: '{}' }).catch(() => {}); signOut(); });

  (async () => {
    await redeemLinkInUrl();
    if (!session) { if ($('signin').hidden) signOut(''); return; }
    $('loading').hidden = false; $('signin').hidden = true;
    try {
      await refreshMe();
      $('periods').hidden = false; $('logout').hidden = false;
      await load(PERIOD);
    } catch (e) { if (e.message !== 'signed out') { $('loading').hidden = true; showError(e); } }
  })();
})();
