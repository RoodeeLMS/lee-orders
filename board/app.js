'use strict';
// ครัวคุณหลี Orders - single-page app over /api (server.py). No build step, no dependencies.
// Phone first (Khun Lee); two-column grids from iPad width up (Nick).

const $app = document.getElementById('app');
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const baht = (n) => '฿' + fmt(n);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let ME = { user: '', name: '', groups: [] };
const isAdmin = () => ME.groups.includes('admins');
// "pausikanya (ไม่ได้ระบุ ปณ. — ใช้ 10330)" -> handle "pausikanya", hint "ไม่ได้ระบุ ปณ. — ใช้ 10330"
const handleOf = (u) => String(u || '').replace(/\s*\(.*\)\s*$/, '').trim();
const hintOf = (u) => { const m = String(u || '').match(/\((.*)\)\s*$/); return m ? m[1] : ''; };
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opt);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('HTTP ' + r.status));
  return r.json();
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 1800);
}
async function copy(text, what = 'คัดลอกแล้ว ✓') {
  try { await navigator.clipboard.writeText(text); toast(what); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast(what);
  }
}
const when = (ts) => ts ? new Date(ts * 1000).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const whenIso = (iso) => iso ? new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const STATUS_LABEL = { open: 'เปิดรับออเดอร์', closed: 'ปิดรับแล้ว', delivered: 'ส่งแล้ว', cancelled: 'ยกเลิกรอบ' };
const statusPill = (s) => `<span class="pill ${esc(s)}">${STATUS_LABEL[s] || esc(s)}</span>`;
const pending = (s) => s === 'open' || s === 'closed';   // not delivered yet
// "ครัวคุณหลี · รอบจัดส่งพฤหัสบดี 8/10/2569 (Cold Pasta + …) — x" -> "Cold Pasta + … — x"
const shortTitle = (t) => String(t || '').replace(/^ครัวคุณหลี · /, '').replace(/^รอบ(จัด)?ส่ง\S*\s*\d+\/\d+\/\d+\s*/, '')
  .replace(/^\((.*?)\)/, '$1');

/* ---------------------------------------------------------------- router */
async function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  const parts = h.split('/').filter(Boolean).map(decodeURIComponent);
  document.querySelectorAll('header nav a').forEach((a) => a.classList.toggle('on',
    (a.dataset.nav === 'rounds' && (parts[0] === undefined || parts[0] === 'r')) ||
    (a.dataset.nav === 'customers' && (parts[0] === 'customers' || parts[0] === 'c')) ||
    (a.dataset.nav === 'notes' && parts[0] === 'notes')));
  try {
    if (!parts.length) return await viewRounds();
    if (parts[0] === 'r') return await viewRound(parts[1], parts[2] || 'orders');
    if (parts[0] === 'customers') return await viewCustomers();
    if (parts[0] === 'c') return await viewCustomer(parts[1]);
    if (parts[0] === 'notes') return await viewNotes();
    $app.innerHTML = '<p class="empty">ไม่พบหน้านี้</p>';
  } catch (e) {
    $app.innerHTML = `<p class="empty">โหลดไม่สำเร็จ: ${esc(e.message)}</p>`;
  }
}
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

/* ---------------------------------------------------------------- rounds */
async function viewRounds() {
  const rounds = await api('/api/rounds');
  const open = rounds.filter((r) => pending(r.status));
  const rest = rounds.filter((r) => !pending(r.status));
  const card = (r) => {
    const s = r.summary;
    let line;
    if (r.status === 'cancelled') line = `<span class="sub">ยกเลิกทั้งรอบ</span>`;
    else {
      const chips = [];
      if (pending(r.status)) {
        chips.push(s.due ? `<span class="pill warn">ค้างจ่าย ${baht(s.dueAmt)} · ${s.due} ราย</span>` : `<span class="pill good">จ่ายครบ ✓</span>`);
        chips.push(`<span class="pill">ส่งแล้ว ${s.shipped}/${s.orders}</span>`);
        if (s.openQuestions) chips.push(`<span class="pill warn">❓ รอตอบ ${s.openQuestions}</span>`);
      }
      if (s.openNotes) chips.push(`<span class="pill warn">📝 ${s.openNotes}</span>`);
      line = `<div class="row" style="margin-top:4px"><b>${s.orders} ออเดอร์ · ${baht(s.food)}</b>${chips.join('')}</div>`;
    }
    return `<a class="card" href="#/r/${encodeURIComponent(r.id)}">
      <div class="head"><b style="font-size:17px">${esc((r.deliveryDateLabel || r.id).split(' → ')[0])}</b>${statusPill(r.status)}</div>
      <div class="sub">${esc(shortTitle(r.title))}</div>${line}</a>`;
  };
  $app.innerHTML = `
    <h1>รอบที่ยังไม่ส่ง</h1>
    <div class="grid">${open.map(card).join('') || '<p class="empty">ไม่มีรอบที่ค้างอยู่</p>'}</div>
    <h2>รอบก่อนหน้า</h2>
    <div class="grid">${rest.slice(0, 10).map(card).join('')}</div>
    ${rest.length > 10 ? `<details><summary class="sub" style="padding:10px 0">ดูทั้งหมดอีก ${rest.length - 10} รอบ</summary><div class="grid">${rest.slice(10).map(card).join('')}</div></details>` : ''}`;
}

/* ----------------------------------------------------------------- round */
let R = null;           // the round currently shown
const VIEW = { filter: 'all', sort: store.get('lee.sort', 'order'), hideShipped: false };
const names = () => Object.fromEntries(R.menu.map((m) => [m.code, m.short || m.name]));
const priceOf = (c) => (R.menu.find((m) => m.code === c) || {}).price || 0;
const dateFull = () => (R.deliveryDateFull || R.deliveryDateLabel || '').split(' (')[0];

function itemsText(o, sep = ' · ') {
  const n = names();
  const cols = R.displayColumns.concat(Object.keys(o.items).filter((c) => !R.displayColumns.includes(c)));
  return cols.filter((c) => o.items[c]).map((c) => `${n[c] || c} ×${o.items[c]}`).join(sep);
}

// Mirrors buildMessage() in the GitHub Pages site (assets/js/order.js).
function customerMessage(o) {
  const n = names();
  const L = ['**' + (R.popupTitle || 'สรุปยอด'), '', 'จัดส่ง' + (R.deliveryDateFull || R.deliveryDateLabel || ''), ''];
  for (const c of Object.keys(o.items).filter((c) => o.items[c])) L.push(`${n[c] || c} ×${o.items[c]}   ${fmt(o.items[c] * priceOf(c))} บาท`);
  if (o.note) L.push(`หมายเหตุ: ${o.note}`);
  L.push(`ค่าส่ง ${fmt(o.fee)} บาท`, '', `รวมเป็นเงิน ${fmt(o.food + o.fee)} บาท`, '');
  const p = R.payment || {};
  L.push('Payment :');
  if (p.name) L.push(p.name);
  if (p.bank || p.account) L.push(`${p.bank || ''} ${p.account || ''}`.trim());
  L.push('', 'หลังจากโอนเงินแล้ว', 'รบกวนส่งหลักฐานการโอนเงินให้หลีด้วยนะคะ', '', 'ขอบคุณค่ะ 😊');
  return L.join('\n');
}

// Short, polite payment reminder (Khun Lee sends it herself, so "หลี" is her own first person).
function reminderMessage(o) {
  const p = R.payment || {};
  return [`สวัสดีค่ะ 🙏 แจ้งยอดออเดอร์ครัวคุณหลี รอบ${dateFull()}`,
    `${itemsText(o)}`,
    `ยอดอาหาร ${fmt(o.food)} + ค่าส่ง ${fmt(o.fee)} = รวม ${fmt(o.food + o.fee)} บาท`,
    `โอนได้ที่ ${[p.bank, p.account, p.name].filter(Boolean).join(' ')}`,
    'โอนแล้วรบกวนส่งสลิปให้หลีด้วยนะคะ ขอบคุณค่ะ 😊'].join('\n');
}

function deliveryText(o) {
  const a = o.address;
  const L = [`@${handleOf(o.user)}  ${itemsText(o)}`, `ยอดสินค้า ${fmt(o.food)} + ค่าส่ง ${fmt(o.fee)} = รวม ${fmt(o.food + o.fee)} บาท`, ''];
  if (a) {
    if (a.name) L.push(a.name);
    if (a.phone) L.push(a.phone);
    if (a.address) L.push(a.address + (a.postal && !a.address.includes(a.postal) ? ' ' + a.postal : ''));
    if (a.maps) L.push(a.maps);
    if (a.ambiguous) L.push('⚠️ ลูกค้ามีหลายที่อยู่ — ตรวจ ปณ. ให้ตรงก่อนส่ง');
  } else L.push(`(ไม่พบที่อยู่ในสมุด · ปณ. ${o.zip || '-'})`);
  if (o.note) L.push('หมายเหตุ: ' + o.note);
  return L.join('\n');
}

function addrHtml(o) {
  const a = o.address;
  if (!a) return `<div class="addr"><span class="remark">ไม่พบที่อยู่ในสมุด (ปณ. ${esc(o.zip || '-')}) — ต้องตามเก็บที่อยู่</span></div>`;
  return `<div class="addr">
    <div class="nm">${esc(a.name || '')}</div>
    ${a.address ? `<div>${esc(a.address)}${a.postal && !a.address.includes(a.postal) ? ' ' + esc(a.postal) : ''}</div>` : ''}
    ${a.ambiguous ? `<div class="remark">⚠️ ลูกค้ามีหลายที่อยู่ — ตรวจ ปณ. ให้ตรงก่อนส่ง</div>` : ''}
  </div>`;
}
const callBtn = (o) => o.address && o.address.phone ? `<a class="btn" href="tel:${esc(o.address.phone.replace(/[^\d+]/g, ''))}">📞 โทร</a>` : '';
const mapBtn = (o) => o.address && o.address.maps ? `<a class="btn" href="${esc(o.address.maps)}" target="_blank" rel="noopener">📍 Maps</a>` : '';

async function viewRound(id, tab) {
  R = await api('/api/round/' + encodeURIComponent(id));
  const s = R.summary;
  const tabs = [['orders', '📋', 'ออเดอร์'], ['questions', '❓', 'คำถาม', s.openQuestions], ['prep', '🍳', 'เตรียม'],
    ['ship', '🚚', 'ส่งของ'], ['notes', '📝', 'โน้ต', s.openNotes]];
  $app.innerHTML = `
    <div class="rhead"><div style="flex:1 1 auto;min-width:0">
      <h1>${esc((R.deliveryDateLabel || R.id).split(' → ')[0])}</h1>
      <div class="sub">${esc(shortTitle(R.title))}</div>
    </div>${statusPill(R.status)}</div>
    <div class="stats">
      <div class="stat"><b>${baht(s.food + s.fees)}</b><span>รวมทั้งหมด</span></div>
      <div class="stat ${s.due ? 'due' : ''}"><b>${baht(s.dueAmt)}</b><span>ค้าง ${s.due} ราย</span></div>
      <div class="stat"><b>${s.paid}/${s.orders}</b><span>จ่ายแล้ว</span></div>
      <div class="stat"><b>${s.shipped}/${s.orders}</b><span>ส่งแล้ว</span></div>
    </div>
    <div class="sub">${s.orders} ออเดอร์${s.cancelled ? ` (+${s.cancelled} ยกเลิก)` : ''} · อาหาร ${baht(s.food)} · ค่าส่ง ${baht(s.fees)} · <span id="slipCount">สลิป ${s.slips}</span></div>
    ${R.parsedAt ? `<p class="fresh">ข้อมูลออเดอร์อัปเดต ${esc(whenIso(R.parsedAt))}</p>` : ''}
    <details class="rstat noprint"><summary>⚙️ สถานะรอบ: <b>${STATUS_LABEL[R.status] || esc(R.status)}</b>${R.statusSetBy ? ` <span class="sub">(ตั้งโดย ${esc(R.statusSetBy.by)} ${when(R.statusSetBy.at)})</span>` : ''} ▸</summary>
      <div class="chips" style="margin:8px 0">${Object.keys(STATUS_LABEL).map((k) => `<button data-rs="${k}" class="${R.status === k ? 'on' : ''}">${STATUS_LABEL[k]}</button>`).join('')}</div>
      <div class="sub">ปิดรับแล้ว = ไม่รับออเดอร์เพิ่ม · ส่งแล้ว = ย้ายไปรอบก่อนหน้า · แตะ 2 ครั้งเพื่อยืนยัน</div>
    </details>
    <nav class="tabs">${tabs.map(([k, ic, l, n]) => `<a href="#/r/${encodeURIComponent(R.id)}/${k}" class="${k === tab ? 'on' : ''}"><span class="ic">${ic}</span>${l}${n ? `<span class="badge">${n}</span>` : ''}</a>`).join('')}</nav>
    <section id="tab"></section>`;
  $app.querySelector('.rstat').onclick = async (ev) => {
    const b = ev.target.closest('[data-rs]');
    if (!b || b.dataset.rs === R.status) return;
    if (!b.dataset.armed) {                       // two taps, so a stray tap can't close a round
      $app.querySelectorAll('[data-rs]').forEach((x) => { delete x.dataset.armed; x.textContent = STATUS_LABEL[x.dataset.rs]; });
      b.dataset.armed = '1'; b.textContent = 'แตะอีกครั้ง: ' + STATUS_LABEL[b.dataset.rs];
      return;
    }
    try {
      await api('/api/round-status', { round: R.id, status: b.dataset.rs });
      toast('เปลี่ยนสถานะรอบแล้ว ✓'); viewRound(R.id, tab);
    } catch (e) { toast('ไม่สำเร็จ: ' + e.message); }
  };
  ({ orders: tabOrders, questions: tabQuestions, prep: tabPrep, ship: tabShip, notes: tabNotes }[tab] || tabOrders)();
}

function sorted(list) {
  const by = VIEW.sort;
  const l = list.slice();
  if (by === 'zip') l.sort((a, b) => (a.zip || '99999').localeCompare(b.zip || '99999'));
  if (by === 'name') l.sort((a, b) => handleOf(a.user).localeCompare(handleOf(b.user)));
  if (by === 'amount') l.sort((a, b) => (b.food + b.fee) - (a.food + a.fee));
  if (by === 'due') l.sort((a, b) => (a.paid - b.paid) || ((b.food + b.fee) - (a.food + a.fee)));
  return l;
}

function tabOrders() {
  const el = document.getElementById('tab');
  const draw = () => {
    const q = (document.getElementById('q').value || '').toLowerCase().trim();
    let list = R.orders;
    if (VIEW.filter === 'due') list = list.filter((o) => !o.cancelled && !o.paid);
    if (VIEW.filter === 'unshipped') list = list.filter((o) => !o.cancelled && !o.shipped);
    if (VIEW.filter === 'cancelled') list = list.filter((o) => o.cancelled);
    if (VIEW.filter === 'all') list = list.filter((o) => !o.cancelled).concat(list.filter((o) => o.cancelled));
    if (q) list = list.filter((o) => o.user.toLowerCase().includes(q) || (o.zip || '').includes(q) ||
      ((o.address || {}).name || '').toLowerCase().includes(q));
    document.getElementById('list').innerHTML = sorted(list).map(orderCard).join('') || '<p class="empty">ไม่มีรายการ</p>';
  };
  const s = R.summary;
  el.innerHTML = `
    <div class="chips noprint" style="margin-bottom:8px">
      ${[['all', `ทั้งหมด ${s.orders}`], ['due', `ค้างจ่าย ${s.due}`], ['unshipped', `ยังไม่ส่ง ${s.orders - s.shipped}`], ['cancelled', `ยกเลิก ${s.cancelled}`]]
        .map(([k, l]) => `<button data-f="${k}" class="${VIEW.filter === k ? 'on' : ''}">${l}</button>`).join('')}
    </div>
    <div class="toolbar noprint">
      <input type="search" id="q" placeholder="🔍 ชื่อ IG / ชื่อลูกค้า / ปณ.">
      <select id="sort" style="flex:0 1 170px">
        ${[['order', 'เรียงตามคอมเมนต์'], ['zip', 'เรียงตาม ปณ.'], ['name', 'เรียงตามชื่อ'], ['amount', 'ยอดมาก → น้อย'], ['due', 'ค้างจ่ายก่อน']]
          .map(([k, l]) => `<option value="${k}" ${VIEW.sort === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div id="list" class="grid"></div>`;
  el.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { VIEW.filter = b.dataset.f; tabOrders(); });
  document.getElementById('q').oninput = draw;
  document.getElementById('sort').onchange = (e) => { VIEW.sort = e.target.value; store.set('lee.sort', VIEW.sort); draw(); };
  el.onclick = onOrderClick;
  draw();
}

function orderCard(o) {
  const k = esc(o.key);
  const hint = hintOf(o.user);
  const orig = o.editedFrom ? `<div class="orig">✏️ คุณหลีแก้จากเดิม: ${esc(o.editedFrom)}</div>`
    : o.normalizedFrom ? `<div class="orig">📄 ข้อความเดิมของลูกค้า: ${esc(o.normalizedFrom)}</div>` : '';
  return `<div class="card ord ${o.cancelled ? 'cancelled' : ''} ${o.paid ? 'paid' : ''} ${o.shipped ? 'shipped' : ''}" data-key="${k}">
    <div class="row"><span class="who-line">${o.caption ? '📌 ' : ''}@${esc(handleOf(o.user))}</span>
      <span class="pill">${esc(o.zip || 'ไม่มี ปณ.')}</span><span class="spacer"></span><span class="amt">${baht(o.food + o.fee)}</span></div>
    ${hint ? `<div class="lbl">${esc(hint)}</div>` : ''}
    <div class="items">${esc(itemsText(o))}</div>
    ${o.note ? `<div class="note-line">📌 ${esc(o.note)}</div>` : ''}
    ${o.remark ? `<div class="remark">❓ ${esc(o.remark)}</div>` : ''}
    ${o.cancelled ? `<div class="remark">${o.movedTo ? '📦 ' + esc(o.movedTo) : '❌ ยกเลิก / ไม่นับยอด'}</div>` : `
    <div class="checks noprint">
      <button data-act="paid" class="${o.paid ? 'on' : ''}">${o.paid ? '☑ จ่ายแล้ว' : '☐ จ่ายแล้ว'}</button>
      <button data-act="shipped" class="${o.shipped ? 'on' : ''}">${o.shipped ? '☑ ส่งแล้ว' : '☐ ส่งแล้ว'}</button>
    </div>
    <div class="sliprow noprint">
      ${o.slips.map((s) => `<img class="slipthumb" src="/api/slip/${s.id}" data-slip="${s.id}" loading="lazy" alt="สลิป">`).join('')}
      <button data-act="slip" class="${o.paid ? '' : 'slipbtn'}">📎 ${o.slips.length ? 'เพิ่มสลิป' : 'แนบสลิป'}</button>
    </div>
    <details class="noprint"><summary>▸ ส่งยอด · ที่อยู่ · ค่าส่ง · โน้ต</summary>
      <div class="actions">
        <button data-act="copymsg">📋 สรุปยอด</button>
        ${o.paid ? '' : '<button data-act="copyrem">💬 ทวงยอด</button>'}
        <button data-act="copydel">📋 คนส่ง</button>
        ${callBtn(o)}${mapBtn(o)}
      </div>
      ${addrHtml(o)}
      <details><summary class="sub">ดูข้อความสรุปยอดเต็ม</summary><div class="box">${esc(customerMessage(o))}</div></details>
      <div class="feeRow"><span>ค่าส่ง</span><input type="number" inputmode="numeric" min="0" step="10" value="${o.fee}" data-fee>
        <button data-act="fee">บันทึก</button><span class="sub">${esc(o.zone)}${o.fee !== o.feeAuto ? ' · ปกติ ' + o.feeAuto : ''}</span></div>
      <textarea placeholder="ฝากโน้ตเรื่องออเดอร์นี้ เช่น ลูกค้าขอเปลี่ยน…" data-notetext></textarea>
      <div class="row" style="margin-top:6px"><span class="spacer"></span><button data-act="note" class="primary">ส่งโน้ต</button></div>
      ${orig}
    </details>`}
  </div>`;
}

// Re-render one order card in place, keeping its detail panel open if it was.
function redraw(card, o, forceOpen) {
  const open = forceOpen || (card.querySelector('details') && card.querySelector('details').open);
  card.outerHTML = orderCard(o);
  if (open) document.querySelector(`[data-key="${CSS.escape(o.key)}"] details`).open = true;
  refreshStats();
}

/* ------------------------------------------------------------ payment slips */
const picker = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', hidden: true });
document.body.appendChild(picker);
// Must be called synchronously inside the tap handler, or iOS refuses to open the picker.
const pickFile = () => new Promise((res) => { picker.value = ''; picker.onchange = () => res(picker.files[0]); picker.oncancel = () => res(null); picker.click(); });

// Slips are screenshots of text: 1600 px on the long side keeps them sharp at a fraction of the size.
async function shrink(file) {
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    return (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85))) || file;
  } catch (e) { return file; }
}

async function uploadSlip(o, file) {
  toast('กำลังอัปโหลดสลิป…');
  const blob = await shrink(file);
  const r = await fetch(`/api/slip?round=${encodeURIComponent(R.id)}&key=${encodeURIComponent(o.key)}`,
    { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  o.slips.push({ id: j.id, by: ME.user, at: Date.now() / 1000 });
  o.paid = true;
  R.summary.slips = R.orders.filter((x) => !x.cancelled && x.slips.length).length;
  const sc = document.getElementById('slipCount');
  if (sc) sc.textContent = `สลิป ${R.summary.slips}`;
  toast('แนบสลิปแล้ว ✓ ติ๊กจ่ายแล้วให้');
}

function openSlip(o, id) {
  const ov = document.createElement('div');
  ov.className = 'viewer';
  ov.innerHTML = `<div class="vbar"><div><b>@${esc(handleOf(o.user))}</b><div class="sub">ยอดที่ต้องจ่าย ${baht(o.food + o.fee)}</div></div>
      <span class="spacer"></span><button data-x>✕ ปิด</button></div>
    <img src="/api/slip/${id}" alt="สลิป">
    <div class="vbar"><span class="spacer"></span><button data-del>🗑 ลบสลิปนี้</button></div>`;
  const close = () => { ov.remove(); document.removeEventListener('keydown', esc_); };
  const esc_ = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc_);
  ov.onclick = async (ev) => {
    if (ev.target === ov || ev.target.closest('[data-x]')) return close();
    const del = ev.target.closest('[data-del]');
    if (!del) return;
    if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'แตะอีกครั้งเพื่อลบ'; return; }
    try {
      await api(`/api/slip/${id}/delete`, {});
      o.slips = o.slips.filter((s) => s.id !== id);
      close(); toast('ลบสลิปแล้ว (ยังติ๊กจ่ายแล้วอยู่)');
      const card = document.querySelector(`[data-key="${CSS.escape(o.key)}"]`);
      if (card) redraw(card, o);
    } catch (e) { toast('ไม่สำเร็จ: ' + e.message); }
  };
  document.body.appendChild(ov);
}

async function onOrderClick(ev) {
  const th = ev.target.closest('[data-slip]');
  if (th) {
    const o = R.orders.find((x) => x.key === th.closest('[data-key]').dataset.key);
    return openSlip(o, Number(th.dataset.slip));
  }
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const card = b.closest('[data-key]');
  const o = R.orders.find((x) => x.key === card.dataset.key);
  const act = b.dataset.act;
  try {
    if (act === 'slip') {
      const file = await pickFile();
      if (!file) return;
      b.disabled = true;
      await uploadSlip(o, file);
      return redraw(document.querySelector(`[data-key="${CSS.escape(o.key)}"]`), o);
    }
    if (act === 'paid' || act === 'shipped') {
      const v = !o[act];
      b.disabled = true;
      await api('/api/status', { round: R.id, key: o.key, [act]: v });
      o[act] = v; toast(v ? (act === 'paid' ? 'บันทึก จ่ายแล้ว ✓' : 'บันทึก ส่งแล้ว ✓') : 'เอาเครื่องหมายออกแล้ว');
      return redraw(card, o);
    }
    if (act === 'copymsg') return copy(customerMessage(o), 'คัดลอกสรุปยอดแล้ว ✓');
    if (act === 'copyrem') return copy(reminderMessage(o), 'คัดลอกข้อความทวงยอดแล้ว ✓');
    if (act === 'copydel') return copy(deliveryText(o), 'คัดลอกสำหรับคนส่งแล้ว ✓');
    if (act === 'fee') {
      const v = card.querySelector('[data-fee]').value;
      await api('/api/status', { round: R.id, key: o.key, fee: v === '' ? null : Number(v) });
      o.fee = v === '' ? o.feeAuto : Number(v); toast('บันทึกค่าส่งแล้ว ✓');
      return redraw(card, o, true);
    }
    if (act === 'note') {
      const t = card.querySelector('[data-notetext]').value.trim();
      if (!t) return toast('พิมพ์ข้อความก่อนนะคะ');
      await api('/api/note', { round: R.id, key: o.key, text: t });
      card.querySelector('[data-notetext]').value = ''; toast('ส่งโน้ตแล้ว ✓');
    }
  } catch (e) { toast('ไม่สำเร็จ: ' + e.message); b.disabled = false; }
}

function refreshStats() {
  const act = R.orders.filter((o) => !o.cancelled);
  const s = R.summary;
  s.paid = act.filter((o) => o.paid).length; s.shipped = act.filter((o) => o.shipped).length;
  s.fees = act.reduce((t, o) => t + o.fee, 0);
  s.due = act.filter((o) => !o.paid).length; s.dueAmt = act.filter((o) => !o.paid).reduce((t, o) => t + o.food + o.fee, 0);
  const st = document.querySelectorAll('.stat');
  st[0].querySelector('b').textContent = baht(s.food + s.fees);
  st[1].querySelector('b').textContent = baht(s.dueAmt); st[1].querySelector('span').textContent = `ค้าง ${s.due} ราย`;
  st[1].classList.toggle('due', !!s.due);
  st[2].querySelector('b').textContent = `${s.paid}/${s.orders}`;
  st[3].querySelector('b').textContent = `${s.shipped}/${s.orders}`;
}

function tabQuestions() {
  const el = document.getElementById('tab');
  if (!R.questions.length) { el.innerHTML = '<p class="empty">ไม่มีคำถามค้างในรอบนี้ 🎉</p>'; return; }
  const open = R.questions.filter((q) => !q.answer), done = R.questions.filter((q) => q.answer);
  const ctx = (q) => {
    const o = q.user && R.orders.find((x) => handleOf(x.user).toLowerCase() === String(q.user).toLowerCase());
    return o ? `<div class="ctx">ออเดอร์ @${esc(handleOf(o.user))}: ${esc(itemsText(o))}</div>` : '';
  };
  const card = (q) => `<div class="card q ${q.answer ? 'done' : ''}" data-qid="${esc(q.id)}">
    <div class="qtext">${esc(q.text)}</div>${ctx(q)}
    ${q.options && q.options.length ? `<div class="opts">${q.options.map((op) => `<button data-opt="${esc(op)}" class="${q.answer === op ? 'on' : ''}">${esc(op)}</button>`).join('')}</div>` : ''}
    ${q.answer ? `<div class="ans">✓ ${esc(q.answer)} <span class="sub">· ${esc(q.answeredBy || '')} ${when(q.answeredAt)}</span></div>` : ''}
    <div class="row" style="margin-top:8px"><input type="text" placeholder="${q.options && q.options.length ? 'หรือพิมพ์คำตอบเอง' : 'พิมพ์คำตอบ'}" value="${esc(q.answer && !(q.options || []).includes(q.answer) ? q.answer : '')}" data-free style="flex:1 1 180px">
      <button class="primary" data-send>ส่ง</button></div>
  </div>`;
  el.innerHTML = `${open.length ? `<h2>รอคำตอบ (${open.length})</h2><div class="grid">${open.map(card).join('')}</div>` : '<p class="empty">ตอบครบแล้ว 🎉 ขอบคุณค่ะ</p>'}
    ${done.length ? `<h2>ตอบแล้ว</h2><div class="grid">${done.map(card).join('')}</div>` : ''}`;
  el.onclick = async (ev) => {
    const b = ev.target.closest('[data-opt],[data-send]');
    if (!b) return;
    const box = b.closest('[data-qid]');
    const answer = b.dataset.opt !== undefined ? b.dataset.opt : box.querySelector('[data-free]').value.trim();
    if (!answer) return toast('พิมพ์คำตอบก่อนนะคะ');
    try {
      await api('/api/answer', { round: R.id, qid: box.dataset.qid, answer });
      const q = R.questions.find((x) => x.id === box.dataset.qid);
      q.answer = answer; q.answeredBy = ME.user; q.answeredAt = Date.now() / 1000;
      toast('ส่งคำตอบแล้ว ✓ ระบบจะนำไปแก้ให้');
      tabQuestions();
    } catch (e) { toast('ไม่สำเร็จ: ' + e.message); }
  };
}

function tabPrep() {
  const el = document.getElementById('tab');
  const n = names();
  const codes = R.displayColumns.concat(Object.keys(R.prep).filter((c) => !R.displayColumns.includes(c)));
  const rows = codes.filter((c) => R.prep[c]).map((c) => `<tr><td>${esc(n[c] || c)}</td><td class="n">${fmt(R.prep[c])}</td></tr>`).join('');
  const withNotes = R.orders.filter((o) => !o.cancelled && o.note);
  el.innerHTML = `
    <div class="row noprint"><span class="sub">รวมทุกออเดอร์ที่ไม่ยกเลิก (รวมออเดอร์ในแคปชั่น)</span><span class="spacer"></span><button onclick="print()">🖨️ พิมพ์</button></div>
    <h2>${esc(dateFull())} — ต้องเตรียม</h2>
    <table class="prep">${rows}</table>
    ${withNotes.length ? `<h2>ออเดอร์ที่มีหมายเหตุ (${withNotes.length})</h2><div class="grid">${withNotes.map((o) => `<div class="card"><b>@${esc(handleOf(o.user))}</b> — ${esc(o.note)}<div class="sub">${esc(itemsText(o))}</div></div>`).join('')}</div>` : ''}`;
}

function tabShip() {
  const el = document.getElementById('tab');
  const all = R.orders.filter((o) => !o.cancelled).sort((a, b) => (a.zip || '99999').localeCompare(b.zip || '99999'));
  const list = VIEW.hideShipped ? all.filter((o) => !o.shipped) : all;
  const missing = all.filter((o) => !o.address).length;
  el.innerHTML = `
    <div class="toolbar noprint">
      <a class="btn primary" href="/api/round/${encodeURIComponent(R.id)}/shipping.csv">⬇️ CSV</a>
      <button data-all>📋 คัดลอกทั้งหมด</button>
      <button data-hide class="${VIEW.hideShipped ? 'on' : ''}">ซ่อนที่ส่งแล้ว</button>
      <button onclick="print()">🖨️ พิมพ์</button>
    </div>
    ${missing ? `<p class="remark">⚠️ ไม่พบที่อยู่ในสมุด ${missing} ราย — ต้องตามเก็บที่อยู่</p>` : ''}
    <div class="sub" style="margin-bottom:8px">เรียงตาม ปณ. · ${list.length} ราย</div>
    <div class="grid">${list.map((o) => `<div class="card ord ${o.shipped ? 'shipped' : ''}" data-key="${esc(o.key)}">
      <div class="row"><span class="who-line">@${esc(handleOf(o.user))}</span><span class="pill">${esc(o.zip || '-')}</span><span class="spacer"></span><span class="amt">${baht(o.food + o.fee)}</span></div>
      <div class="items">${esc(itemsText(o))}</div>
      ${o.note ? `<div class="note-line">📌 ${esc(o.note)}</div>` : ''}
      ${addrHtml(o)}
      <div class="actions noprint"><button data-act="copydel">📋 คัดลอก</button>${callBtn(o)}${mapBtn(o)}
        <button data-act="shipped" class="${o.shipped ? 'on' : ''}">${o.shipped ? '☑ ส่งแล้ว' : '☐ ส่งแล้ว'}</button></div>
    </div>`).join('')}</div>`;
  el.querySelector('[data-all]').onclick = () => copy(list.map(deliveryText).join('\n\n— — —\n\n'), `คัดลอก ${list.length} รายแล้ว ✓`);
  el.querySelector('[data-hide]').onclick = () => { VIEW.hideShipped = !VIEW.hideShipped; tabShip(); };
  el.onclick = async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const o = R.orders.find((x) => x.key === b.closest('[data-key]').dataset.key);
    if (b.dataset.act === 'copydel') return copy(deliveryText(o), 'คัดลอกสำหรับคนส่งแล้ว ✓');
    if (b.dataset.act === 'shipped') {
      try {
        await api('/api/status', { round: R.id, key: o.key, shipped: !o.shipped });
        o.shipped = !o.shipped; toast(o.shipped ? 'บันทึก ส่งแล้ว ✓' : 'เอาเครื่องหมายออกแล้ว');
        refreshStats(); tabShip();
      } catch (e) { toast('ไม่สำเร็จ: ' + e.message); }
    }
  };
}

function noteCard(n) {
  return `<div class="card note ${n.done ? 'done' : ''}" data-id="${n.id}">
    <div class="meta">${esc(n.by)} · ${when(n.at)}${n.okey ? ` · ออเดอร์ @${esc(handleOf(n.okey.replace(/^cap:/, '')))}` : ''}${n.round_id && !R ? ` · <a href="#/r/${encodeURIComponent(n.round_id)}/notes">รอบนี้ ›</a>` : ''} ${n.done ? '· ✓ จัดการแล้ว' : '· ⏳ รอจัดการ'}</div>
    <div style="white-space:pre-wrap;margin-top:4px">${esc(n.text)}</div>
    ${n.reply ? `<div class="reply">↳ ${esc(n.reply)} <span class="sub">(${esc(n.done_by || '')} ${when(n.done_at)})</span></div>` : ''}
    ${isAdmin() && !n.done ? `<div class="row noprint" style="margin-top:8px"><input type="text" placeholder="ตอบกลับ (ไม่บังคับ)" data-reply style="flex:1 1 160px"><button data-done>✓ จัดการแล้ว</button></div>` : ''}
  </div>`;
}

function bindNoteDone(el, reload) {
  el.onclick = async (ev) => {
    const b = ev.target.closest('[data-done]');
    if (!b) return;
    const card = b.closest('[data-id]');
    try {
      await api(`/api/note/${card.dataset.id}/done`, { reply: card.querySelector('[data-reply]').value.trim() });
      toast('บันทึกแล้ว ✓'); reload();
    } catch (e) { toast('ไม่สำเร็จ: ' + e.message); }
  };
}

function tabNotes() {
  const el = document.getElementById('tab');
  el.innerHTML = `
    <div class="card noprint"><textarea id="nt" placeholder="ฝากโน้ต/คำสั่งเกี่ยวกับรอบนี้ เช่น ปิดรับออเดอร์แล้ว, เพิ่มเมนู, เลื่อนวันส่ง…"></textarea>
      <div class="row" style="margin-top:8px"><span class="spacer"></span><button class="primary" id="ns">ส่งโน้ต</button></div></div>
    <div class="grid">${R.notes.map(noteCard).join('')}</div>${R.notes.length ? '' : '<p class="empty">ยังไม่มีโน้ตในรอบนี้</p>'}`;
  document.getElementById('ns').onclick = async () => {
    const t = document.getElementById('nt').value.trim();
    if (!t) return toast('พิมพ์ข้อความก่อนนะคะ');
    try { await api('/api/note', { round: R.id, text: t }); toast('ส่งโน้ตแล้ว ✓'); viewRound(R.id, 'notes'); }
    catch (e) { toast('ไม่สำเร็จ: ' + e.message); }
  };
  bindNoteDone(el, () => viewRound(R.id, 'notes'));
}

/* ------------------------------------------------------------- customers */
async function viewCustomers() {
  R = null;
  const list = await api('/api/customers');
  $app.innerHTML = `<h1>ลูกค้า</h1><div class="sub">${list.length} ราย · จากทุกรอบในระบบ (ไม่นับออเดอร์ที่ยกเลิก)</div>
    <div class="toolbar"><input type="search" id="cq" placeholder="🔍 ชื่อ IG / ชื่อ / ปณ."></div>
    <div id="cl" class="grid g3"></div><div id="cmore"></div>`;
  const draw = () => {
    const q = document.getElementById('cq').value.trim().toLowerCase();
    const rows = list.filter((c) => !q || c.handle.includes(q) || (c.name || '').toLowerCase().includes(q) || Object.keys(c.zips).some((z) => z.includes(q)));
    document.getElementById('cl').innerHTML = rows.slice(0, 120).map((c) => `<a class="card" href="#/c/${encodeURIComponent(c.handle)}">
      <div class="row"><b style="word-break:break-all">@${esc(c.handle)}</b><span class="spacer"></span><span class="amt">${baht(c.food)}</span></div>
      ${c.name ? `<div class="sub">${esc(c.name)}</div>` : ''}
      <div class="sub">${c.orders} ออเดอร์ · ล่าสุด ${esc((c.lastLabel || '').split(' → ')[0])} · ปณ. ${esc(c.lastZip || '-')}${c.known ? '' : ' · ⚠️ ไม่มีที่อยู่'}</div>
    </a>`).join('');
    document.getElementById('cmore').innerHTML = rows.length > 120 ? `<p class="sub">แสดง 120 จาก ${rows.length} — พิมพ์ค้นหาเพื่อกรอง</p>` : '';
  };
  document.getElementById('cq').oninput = draw;
  draw();
}

async function viewCustomer(handle) {
  R = null;
  const c = await api('/api/customer/' + encodeURIComponent(handle));
  const live = c.history.filter((h) => !h.cancelled);
  const total = live.reduce((t, h) => t + h.food, 0);
  $app.innerHTML = `<p style="margin:0 0 6px"><a href="#/customers">← ลูกค้าทั้งหมด</a></p>
    <h1 style="word-break:break-all">@${esc(c.handle)}</h1>
    <div class="sub">${live.length} ออเดอร์ · ${baht(total)} (ยอดอาหาร)</div>
    <h2>ที่อยู่ในสมุด</h2>
    <div class="grid">${c.addresses.map((a) => `<div class="card"><div class="row"><span class="pill">${esc(a.postal)}</span><b>${esc(a.name || '')}</b></div>
      <div style="margin:4px 0">${esc(a.address || '')}</div>
      <div class="actions">${a.phone ? `<a class="btn" href="tel:${esc(a.phone.replace(/[^\d+]/g, ''))}">📞 ${esc(a.phone)}</a>` : ''}${a.maps ? `<a class="btn" href="${esc(a.maps)}" target="_blank" rel="noopener">📍 Maps</a>` : ''}</div></div>`).join('')}</div>
    ${c.addresses.length ? '' : '<p class="empty">ไม่มีที่อยู่ในสมุด</p>'}
    <h2>ประวัติออเดอร์</h2>
    <div class="grid">${c.history.map((h) => `<a class="card ord ${h.cancelled ? 'cancelled' : ''}" href="#/r/${encodeURIComponent(h.round)}">
      <div class="row"><span class="who-line">${esc((h.label || '').split(' → ')[0])}</span><span class="pill">${esc(h.zip || '-')}</span><span class="spacer"></span><span class="amt">${baht(h.food)}</span></div>
      <div class="items">${esc(h.items.map(([n, q]) => `${n} ×${q}`).join(' · '))}</div>
      ${h.note ? `<div class="note-line">📌 ${esc(h.note)}</div>` : ''}</a>`).join('')}</div>`;
}

/* ----------------------------------------------------------------- notes */
async function viewNotes() {
  R = null;
  const notes = await api('/api/notes');
  const general = notes.filter((n) => !n.round_id);
  const openRound = notes.filter((n) => n.round_id && !n.done);
  $app.innerHTML = `<h1>ฝากข้อความถึงระบบ</h1>
    <div class="sub">คำสั่ง กฎ หรือเรื่องที่อยากให้แก้ — พิมพ์ได้เลย ระบบจะอ่านทุกครั้งที่อัปเดต และติ๊ก ✓ เมื่อจัดการแล้ว</div>
    <div class="card" style="margin-top:10px"><textarea id="gt" placeholder="เช่น จากนี้ไปรอบหมี่คลุก เส้นล้วน = 100 บาท / ลูกค้าคนนี้ใช้ที่อยู่ใหม่ / ปิดรับรอบ 8/10 แล้ว"></textarea>
      <div class="row" style="margin-top:8px"><span class="spacer"></span><button class="primary" id="gs">ส่งข้อความ</button></div></div>
    ${openRound.length ? `<h2>โน้ตในรอบต่างๆ ที่รอจัดการ</h2><div class="grid">${openRound.map(noteCard).join('')}</div>` : ''}
    <h2>ข้อความทั่วไป</h2>
    <div class="grid">${general.map(noteCard).join('')}</div>${general.length ? '' : '<p class="empty">ยังไม่มีข้อความ</p>'}`;
  document.getElementById('gs').onclick = async () => {
    const t = document.getElementById('gt').value.trim();
    if (!t) return toast('พิมพ์ข้อความก่อนนะคะ');
    try { await api('/api/note', { text: t }); toast('ส่งแล้ว ✓'); viewNotes(); }
    catch (e) { toast('ไม่สำเร็จ: ' + e.message); }
  };
  bindNoteDone($app, viewNotes);
}

/* ------------------------------------------------------------------ boot */
(async () => {
  try { ME = await api('/api/me'); } catch (e) { /* stays anonymous */ }
  document.getElementById('who').textContent = ME.name ? 'สวัสดี ' + ME.name : '';
  try {
    const open = (await api('/api/notes')).filter((n) => !n.done).length;
    const b = document.getElementById('noteBadge');
    if (open) { b.textContent = open; b.hidden = false; }
  } catch (e) { /* badge is optional */ }
  route();
})();
