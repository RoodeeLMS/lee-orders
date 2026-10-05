'use strict';
// ครัวคุณหลี Orders - single-page app over /api (server.py). No build step, no dependencies.

const $app = document.getElementById('app');
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const baht = (n) => '฿' + fmt(n);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let ME = { user: '', name: '', groups: [] };
const isAdmin = () => ME.groups.includes('admins');

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
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('คัดลอกแล้ว ✓'); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove(); toast('คัดลอกแล้ว ✓');
  }
}
const when = (ts) => ts ? new Date(ts * 1000).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const statusPill = (s) => `<span class="pill ${esc(s)}">${{ open: 'เปิดรับออเดอร์', delivered: 'ส่งแล้ว', cancelled: 'ยกเลิกรอบ', closed: 'ปิดรอบ' }[s] || esc(s)}</span>`;

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
window.addEventListener('hashchange', route);

/* ---------------------------------------------------------------- rounds */
async function viewRounds() {
  const rounds = await api('/api/rounds');
  const open = rounds.filter((r) => r.status === 'open');
  const rest = rounds.filter((r) => r.status !== 'open');
  const card = (r) => {
    const s = r.summary;
    const flags = [];
    if (s.openQuestions && r.status === 'open') flags.push(`<span class="pill warn">❓ รอตอบ ${s.openQuestions}</span>`);
    if (s.openNotes) flags.push(`<span class="pill warn">📝 โน้ต ${s.openNotes}</span>`);
    return `<a class="card" href="#/r/${encodeURIComponent(r.id)}">
      <div class="row"><b>${esc(r.deliveryDateLabel || r.id)}</b><span class="spacer"></span>${statusPill(r.status)}</div>
      <div class="sub">${esc((r.title || '').replace(/^ครัวคุณหลี · /, ''))}</div>
      <div class="row" style="margin-top:4px"><span>${s.orders} ออเดอร์ · ${baht(s.food)}</span>
        <span class="pill">จ่ายแล้ว ${s.paid}/${s.orders}</span><span class="pill">ส่งแล้ว ${s.shipped}/${s.orders}</span>${flags.join('')}</div>
    </a>`;
  };
  $app.innerHTML = `
    <h1>รอบที่เปิดอยู่</h1>
    ${open.map(card).join('') || '<p class="empty">ไม่มีรอบที่เปิดอยู่</p>'}
    <h2>รอบก่อนหน้า</h2>
    ${rest.slice(0, 12).map(card).join('')}
    ${rest.length > 12 ? `<details><summary class="muted">ดูทั้งหมด (${rest.length})</summary>${rest.slice(12).map(card).join('')}</details>` : ''}`;
}

/* ----------------------------------------------------------------- round */
let R = null;           // the round currently shown
let FILTER = 'all';
const names = () => Object.fromEntries(R.menu.map((m) => [m.code, m.short || m.name]));
const priceOf = (c) => (R.menu.find((m) => m.code === c) || {}).price || 0;

function itemsText(o, sep = ' · ') {
  const n = names();
  return R.displayColumns.filter((c) => o.items[c]).map((c) => `${n[c] || c} ×${o.items[c]}`).join(sep);
}

// Mirrors buildMessage() in the GitHub Pages site (assets/js/order.js).
function customerMessage(o) {
  const n = names();
  const L = ['**' + (R.popupTitle || 'สรุปยอด'), '', 'จัดส่ง' + (R.deliveryDateFull || R.deliveryDateLabel || ''), ''];
  for (const c of R.displayColumns.filter((c) => o.items[c])) L.push(`${n[c] || c} ×${o.items[c]}   ${fmt(o.items[c] * priceOf(c))} บาท`);
  if (o.note) L.push(`หมายเหตุ: ${o.note}`);
  L.push(`ค่าส่ง ${fmt(o.fee)} บาท`, '', `รวมเป็นเงิน ${fmt(o.food + o.fee)} บาท`, '');
  const p = R.payment || {};
  L.push('Payment :');
  if (p.name) L.push(p.name);
  if (p.bank || p.account) L.push(`${p.bank || ''} ${p.account || ''}`.trim());
  L.push('', 'หลังจากโอนเงินแล้ว', 'รบกวนส่งหลักฐานการโอนเงินให้หลีด้วยนะคะ', '', 'ขอบคุณค่ะ 😊');
  return L.join('\n');
}

function deliveryText(o) {
  const a = o.address;
  const L = [`@${o.user}  ${itemsText(o)}`, `ยอดสินค้า ${fmt(o.food)} + ค่าส่ง ${fmt(o.fee)} = รวม ${fmt(o.food + o.fee)} บาท`, ''];
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

async function viewRound(id, tab) {
  R = await api('/api/round/' + encodeURIComponent(id));
  const s = R.summary;
  const tabs = [['orders', 'ออเดอร์'], ['questions', `คำถาม${s.openQuestions ? `<span class="badge">${s.openQuestions}</span>` : ''}`],
    ['prep', 'เตรียมของ'], ['ship', 'ส่งของ'], ['notes', `โน้ต${s.openNotes ? `<span class="badge">${s.openNotes}</span>` : ''}`]];
  $app.innerHTML = `
    <div class="row"><h1>${esc(R.deliveryDateLabel || R.id)}</h1><span class="spacer"></span>${statusPill(R.status)}</div>
    <div class="sub">${esc((R.title || '').replace(/^ครัวคุณหลี · /, ''))}</div>
    <div class="stats">
      <div class="stat"><b>${s.orders}</b><span>ออเดอร์${s.cancelled ? ` (+${s.cancelled} ยกเลิก)` : ''}</span></div>
      <div class="stat"><b>${baht(s.food)}</b><span>ยอดอาหาร</span></div>
      <div class="stat"><b>${baht(s.food + s.fees)}</b><span>รวมค่าส่ง</span></div>
      <div class="stat"><b>${s.paid}/${s.orders}</b><span>จ่ายแล้ว ${baht(s.paidAmt)}</span></div>
      <div class="stat"><b>${s.shipped}/${s.orders}</b><span>ส่งแล้ว</span></div>
    </div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/r/${encodeURIComponent(R.id)}/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</nav>
    <section id="tab"></section>`;
  ({ orders: tabOrders, questions: tabQuestions, prep: tabPrep, ship: tabShip, notes: tabNotes }[tab] || tabOrders)();
}

function tabOrders() {
  const el = document.getElementById('tab');
  const draw = () => {
    const q = (document.getElementById('q') || {}).value || '';
    let list = R.orders;
    if (FILTER === 'unpaid') list = list.filter((o) => !o.cancelled && !o.paid);
    if (FILTER === 'unshipped') list = list.filter((o) => !o.cancelled && !o.shipped);
    if (FILTER === 'cancelled') list = list.filter((o) => o.cancelled);
    if (q) list = list.filter((o) => o.user.toLowerCase().includes(q.toLowerCase()) || (o.zip || '').includes(q));
    document.getElementById('list').innerHTML = list.map(orderCard).join('') || '<p class="empty">ไม่มีรายการ</p>';
  };
  el.innerHTML = `
    <div class="filters noprint">
      ${[['all', 'ทั้งหมด'], ['unpaid', 'ยังไม่จ่าย'], ['unshipped', 'ยังไม่ส่ง'], ['cancelled', 'ยกเลิก']]
        .map(([k, l]) => `<button data-f="${k}" class="${FILTER === k ? 'on' : ''}">${l}</button>`).join('')}
    </div>
    <input type="search" id="q" placeholder="ค้นหาชื่อ IG หรือ ปณ." class="noprint">
    <div id="list"></div>`;
  el.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { FILTER = b.dataset.f; tabOrders(); });
  document.getElementById('q').oninput = draw;
  el.onclick = onOrderClick;
  draw();
}

function orderCard(o) {
  const k = esc(o.key);
  const orig = o.editedFrom ? `<div class="orig">✏️ คุณหลีแก้จากเดิม: ${esc(o.editedFrom)}</div>`
    : o.normalizedFrom ? `<div class="orig">📄 ข้อความเดิมของลูกค้า: ${esc(o.normalizedFrom)}</div>` : '';
  return `<div class="card ord ${o.cancelled ? 'cancelled' : ''}" data-key="${k}">
    <div class="row"><span class="who-line">${o.caption ? '📌 ' : ''}@${esc(o.user)}</span>
      <span class="pill">${esc(o.zip || 'ไม่มี ปณ.')}</span><span class="spacer"></span><span class="amt">${baht(o.food + o.fee)}</span></div>
    <div class="items">${esc(itemsText(o))}</div>
    ${o.note ? `<div class="note-line">หมายเหตุ: ${esc(o.note)}</div>` : ''}
    ${o.remark ? `<div class="remark">❓ ${esc(o.remark)}</div>` : ''}
    ${o.cancelled ? `<div class="remark">${o.movedTo ? '📦 ' + esc(o.movedTo) : '❌ ยกเลิก / ไม่นับยอด'}</div>` : ''}
    ${o.cancelled ? '' : `<div class="toggles noprint">
      <button data-act="paid" class="${o.paid ? 'on' : ''}">${o.paid ? '✓ จ่ายแล้ว' : 'ยังไม่จ่าย'}</button>
      <button data-act="shipped" class="${o.shipped ? 'on' : ''}">${o.shipped ? '✓ ส่งแล้ว' : 'ยังไม่ส่ง'}</button>
    </div>`}
    <details class="noprint"><summary>ข้อความ · ที่อยู่ · ค่าส่ง · โน้ต</summary>
      ${orig}
      <div class="box">${esc(customerMessage(o))}</div>
      <button data-act="copymsg">📋 คัดลอกข้อความสรุปยอด</button>
      <div class="box">${esc(deliveryText(o))}</div>
      <button data-act="copydel">📋 คัดลอกสำหรับคนส่งของ</button>
      ${o.address && o.address.maps ? `<a class="btn" href="${esc(o.address.maps)}" target="_blank" rel="noopener">📍 เปิด Maps</a>` : ''}
      <div class="row" style="margin-top:10px"><label>ค่าส่ง (บาท) <span class="sub">· ${esc(o.zone)}${o.fee !== o.feeAuto ? ' · ปกติ ' + o.feeAuto : ''}</span></label>
        <input type="number" min="0" step="10" value="${o.fee}" data-fee><button data-act="fee">บันทึก</button></div>
      <textarea placeholder="ฝากโน้ต/คำสั่งเกี่ยวกับออเดอร์นี้ เช่น ลูกค้าขอเปลี่ยน…" data-notetext></textarea>
      <button data-act="note" class="primary">ส่งโน้ต</button>
    </details>
  </div>`;
}

async function onOrderClick(ev) {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const card = b.closest('[data-key]');
  const o = R.orders.find((x) => x.key === card.dataset.key);
  const act = b.dataset.act;
  try {
    if (act === 'paid' || act === 'shipped') {
      const v = !o[act];
      await api('/api/status', { round: R.id, key: o.key, [act]: v });
      o[act] = v; toast(v ? 'บันทึกแล้ว ✓' : 'ยกเลิกเครื่องหมายแล้ว');
      card.outerHTML = orderCard(o);
      return refreshStats();
    }
    if (act === 'copymsg') return copy(customerMessage(o));
    if (act === 'copydel') return copy(deliveryText(o));
    if (act === 'fee') {
      const v = card.querySelector('[data-fee]').value;
      await api('/api/status', { round: R.id, key: o.key, fee: v === '' ? null : Number(v) });
      o.fee = v === '' ? o.feeAuto : Number(v); toast('บันทึกค่าส่งแล้ว ✓');
      card.outerHTML = orderCard(o); return refreshStats();
    }
    if (act === 'note') {
      const t = card.querySelector('[data-notetext]').value.trim();
      if (!t) return toast('พิมพ์ข้อความก่อนนะคะ');
      await api('/api/note', { round: R.id, key: o.key, text: t });
      card.querySelector('[data-notetext]').value = ''; toast('ส่งโน้ตแล้ว ✓');
    }
  } catch (e) { toast('ไม่สำเร็จ: ' + e.message); }
}

function refreshStats() {
  const act = R.orders.filter((o) => !o.cancelled);
  const s = R.summary;
  s.paid = act.filter((o) => o.paid).length; s.shipped = act.filter((o) => o.shipped).length;
  s.paidAmt = act.filter((o) => o.paid).reduce((t, o) => t + o.food + o.fee, 0);
  s.fees = act.reduce((t, o) => t + o.fee, 0);
  const st = document.querySelectorAll('.stat b');
  st[2].textContent = baht(s.food + s.fees);
  st[3].textContent = `${s.paid}/${s.orders}`; st[3].nextElementSibling.textContent = `จ่ายแล้ว ${baht(s.paidAmt)}`;
  st[4].textContent = `${s.shipped}/${s.orders}`;
}

function tabQuestions() {
  const el = document.getElementById('tab');
  if (!R.questions.length) { el.innerHTML = '<p class="empty">ไม่มีคำถามค้างในรอบนี้ 🎉</p>'; return; }
  const open = R.questions.filter((q) => !q.answer), done = R.questions.filter((q) => q.answer);
  const card = (q) => `<div class="card q ${q.answer ? 'done' : ''}" data-qid="${esc(q.id)}">
    <div class="qtext">${esc(q.text)}</div>
    ${q.options && q.options.length ? `<div class="opts">${q.options.map((op) => `<button data-opt="${esc(op)}" class="${q.answer === op ? 'on' : ''}">${esc(op)}</button>`).join('')}</div>` : ''}
    ${q.answer ? `<div class="ans">คำตอบ: ${esc(q.answer)} <span class="sub">· ${esc(q.answeredBy || '')} ${when(q.answeredAt)}</span></div>` : ''}
    <div class="row" style="margin-top:6px"><input type="text" placeholder="พิมพ์คำตอบ" value="${esc(q.answer && !(q.options || []).includes(q.answer) ? q.answer : '')}" data-free>
      <button class="primary" data-send>ส่งคำตอบ</button></div>
  </div>`;
  el.innerHTML = `${open.length ? `<h2>รอคำตอบ (${open.length})</h2>${open.map(card).join('')}` : '<p class="empty">ตอบครบแล้ว 🎉</p>'}
    ${done.length ? `<h2>ตอบแล้ว</h2>${done.map(card).join('')}` : ''}`;
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
  const rows = R.displayColumns.filter((c) => R.prep[c]).map((c) => `<tr><td>${esc(n[c] || c)}</td><td class="n">${fmt(R.prep[c])}</td></tr>`).join('');
  const extra = Object.keys(R.prep).filter((c) => !R.displayColumns.includes(c) && R.prep[c])
    .map((c) => `<tr><td>${esc(n[c] || c)}</td><td class="n">${fmt(R.prep[c])}</td></tr>`).join('');
  const withNotes = R.orders.filter((o) => !o.cancelled && o.note);
  el.innerHTML = `
    <div class="row noprint"><span class="sub">รวมทุกออเดอร์ที่ไม่ยกเลิก (รวมออเดอร์ในแคปชั่น)</span><span class="spacer"></span><button onclick="print()">🖨️ พิมพ์</button></div>
    <h2>${esc(R.deliveryDateLabel || '')} — ต้องเตรียม</h2>
    <table class="prep">${rows}${extra}</table>
    ${withNotes.length ? `<h2>ออเดอร์ที่มีหมายเหตุ</h2>${withNotes.map((o) => `<div class="card"><b>@${esc(o.user)}</b> — ${esc(o.note)}<div class="sub">${esc(itemsText(o))}</div></div>`).join('')}` : ''}`;
}

function tabShip() {
  const el = document.getElementById('tab');
  const list = R.orders.filter((o) => !o.cancelled).sort((a, b) => (a.zip || '99999').localeCompare(b.zip || '99999'));
  const missing = list.filter((o) => !o.address).length;
  el.innerHTML = `
    <div class="row noprint">
      <a class="btn primary" href="/api/round/${encodeURIComponent(R.id)}/shipping.csv">⬇️ ดาวน์โหลด CSV</a>
      <button data-all>📋 คัดลอกทั้งหมด</button>
      <button onclick="print()">🖨️ พิมพ์</button>
    </div>
    ${missing ? `<p class="remark">⚠️ ไม่พบที่อยู่ในสมุด ${missing} ราย — ต้องตามเก็บที่อยู่</p>` : ''}
    ${list.map((o) => `<div class="card"><div class="box" style="margin:0">${esc(deliveryText(o))}</div></div>`).join('')}`;
  el.querySelector('[data-all]').onclick = () => copy(list.map(deliveryText).join('\n\n— — —\n\n'));
}

function noteCard(n) {
  return `<div class="card note ${n.done ? 'done' : ''}" data-id="${n.id}">
    <div class="meta">${esc(n.by)} · ${when(n.at)}${n.okey ? ` · ออเดอร์ @${esc(n.okey.replace(/^cap:/, ''))}` : ''}${n.round_id && !R ? ` · รอบ ${esc(n.round_id)}` : ''} ${n.done ? '· ✓ จัดการแล้ว' : '· ⏳ รอจัดการ'}</div>
    <div style="white-space:pre-wrap">${esc(n.text)}</div>
    ${n.reply ? `<div class="reply">↳ ${esc(n.reply)} <span class="sub">(${esc(n.done_by || '')} ${when(n.done_at)})</span></div>` : ''}
    ${isAdmin() && !n.done ? `<div class="row noprint" style="margin-top:6px"><input type="text" placeholder="ตอบกลับ (ไม่บังคับ)" data-reply><button data-done>✓ จัดการแล้ว</button></div>` : ''}
  </div>`;
}

async function bindNoteDone(el, reload) {
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
      <div class="row" style="margin-top:6px"><span class="spacer"></span><button class="primary" id="ns">ส่งโน้ต</button></div></div>
    ${R.notes.map(noteCard).join('') || '<p class="empty">ยังไม่มีโน้ตในรอบนี้</p>'}`;
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
    <input type="search" id="cq" placeholder="ค้นหาชื่อ IG / ชื่อ / ปณ." style="margin:10px 0">
    <div id="cl"></div>`;
  const draw = () => {
    const q = document.getElementById('cq').value.trim().toLowerCase();
    const rows = list.filter((c) => !q || c.handle.includes(q) || (c.name || '').toLowerCase().includes(q) || Object.keys(c.zips).some((z) => z.includes(q)));
    document.getElementById('cl').innerHTML = rows.slice(0, 200).map((c) => `<a class="card" href="#/c/${encodeURIComponent(c.handle)}">
      <div class="row"><b>@${esc(c.handle)}</b>${c.name ? `<span class="sub">${esc(c.name)}</span>` : ''}<span class="spacer"></span><span class="amt">${baht(c.food)}</span></div>
      <div class="sub">${c.orders} ออเดอร์ · ล่าสุด ${esc(c.lastLabel)} · ปณ. ${esc(c.lastZip || '-')}${c.known ? '' : ' · ⚠️ ไม่มีที่อยู่ในสมุด'}</div>
    </a>`).join('') + (rows.length > 200 ? `<p class="sub">แสดง 200 จาก ${rows.length} — พิมพ์ค้นหาเพื่อกรอง</p>` : '');
  };
  document.getElementById('cq').oninput = draw;
  draw();
}

async function viewCustomer(handle) {
  R = null;
  const c = await api('/api/customer/' + encodeURIComponent(handle));
  const total = c.history.filter((h) => !h.cancelled).reduce((t, h) => t + h.food, 0);
  $app.innerHTML = `<p><a href="#/customers">← ลูกค้าทั้งหมด</a></p>
    <h1>@${esc(c.handle)}</h1>
    <div class="sub">${c.history.filter((h) => !h.cancelled).length} ออเดอร์ · ${baht(total)} (ยอดอาหาร)</div>
    <h2>ที่อยู่ในสมุด</h2>
    ${c.addresses.map((a) => `<div class="card"><div class="row"><span class="pill">${esc(a.postal)}</span><b>${esc(a.name || '')}</b>${a.phone ? `<a href="tel:${esc(a.phone)}">${esc(a.phone)}</a>` : ''}</div>
      <div>${esc(a.address || '')}</div>${a.maps ? `<a href="${esc(a.maps)}" target="_blank" rel="noopener">📍 Maps</a>` : ''}</div>`).join('') || '<p class="empty">ไม่มีที่อยู่ในสมุด</p>'}
    <h2>ประวัติออเดอร์</h2>
    ${c.history.map((h) => `<a class="card ord ${h.cancelled ? 'cancelled' : ''}" href="#/r/${encodeURIComponent(h.round)}">
      <div class="row"><span class="who-line">${esc(h.label)}</span><span class="pill">${esc(h.zip || '-')}</span><span class="spacer"></span><span class="amt">${baht(h.food)}</span></div>
      <div class="items">${esc(h.items.map(([n, q]) => `${n} ×${q}`).join(' · '))}</div>
      ${h.note ? `<div class="note-line">หมายเหตุ: ${esc(h.note)}</div>` : ''}</a>`).join('')}`;
}

/* ----------------------------------------------------------------- notes */
async function viewNotes() {
  R = null;
  const notes = await api('/api/notes');
  const general = notes.filter((n) => !n.round_id);
  const openRound = notes.filter((n) => n.round_id && !n.done);
  $app.innerHTML = `<h1>ฝากข้อความถึงระบบ</h1>
    <div class="sub">คำสั่ง กฎ หรือเรื่องที่อยากให้แก้ — พิมพ์ได้เลย ระบบจะอ่านทุกครั้งที่อัปเดต และติ๊ก ✓ เมื่อจัดการแล้ว</div>
    <div class="card"><textarea id="gt" placeholder="เช่น จากนี้ไปรอบหมี่คลุก เส้นล้วน = 100 บาท / ลูกค้าคนนี้ใช้ที่อยู่ใหม่ / ปิดรับรอบ 8/10 แล้ว"></textarea>
      <div class="row" style="margin-top:6px"><span class="spacer"></span><button class="primary" id="gs">ส่งข้อความ</button></div></div>
    ${openRound.length ? `<h2>โน้ตในรอบต่างๆ ที่รอจัดการ</h2>${openRound.map(noteCard).join('')}` : ''}
    <h2>ข้อความทั่วไป</h2>
    ${general.map(noteCard).join('') || '<p class="empty">ยังไม่มีข้อความ</p>'}`;
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
