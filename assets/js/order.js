// Order detail page: loads + decrypts one order file, renders the summary,
// and shows a per-customer popup (screenshot-ready message for Khun Lee to send).
import { requireUnlock, getPassword, lock, decryptBlob } from './gate.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const baht = (n) => '฿' + fmt(n);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let DATA = null;
let PRICES = {};

function priceMap(menu) { const m = {}; for (const it of menu) m[it.code] = it.price; return m; }
function shortName(code) { const m = DATA.menu.find((x) => x.code === code); return m ? (m.short || m.name) : code; }
function rowTotal(items) { let t = 0; for (const k in items) t += (items[k] || 0) * (PRICES[k] || 0); return t; }
function tally(orders, codes) { const c = {}; codes.forEach((k) => (c[k] = 0)); for (const o of orders) for (const k in o.items) c[k] = (c[k] || 0) + o.items[k]; return c; }

/* ---------- main summary tables ---------- */
function menuSummaryTable() {
  const codes = DATA.displayColumns;
  const counts = tally(DATA.orders, codes);
  let grand = 0;
  const rows = codes.map((c) => {
    const item = DATA.menu.find((m) => m.code === c) || { name: c, price: PRICES[c] || 0 };
    const qty = counts[c] || 0, sub = qty * (PRICES[c] || 0); grand += sub;
    return `<tr${qty === 0 ? ' class="zero"' : ''}><td>${esc(item.name)}</td><td class="num">${qty}</td><td class="num">${baht(PRICES[c] || 0)}</td><td class="num">${baht(sub)}</td></tr>`;
  }).join('');
  const totalItems = Object.values(counts).reduce((a, b) => a + b, 0);
  return { html: `<table class="tbl summary-tbl"><thead><tr><th>เมนู</th><th class="num">จำนวน</th><th class="num">ราคา/ที่</th><th class="num">รวม</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th>รวมทั้งสิ้น</th><th class="num">${totalItems}</th><th></th><th class="num">${baht(grand)}</th></tr></tfoot></table>`, grand, totalItems };
}

let SORT = 'zip';

// Format an ISO timestamp as Bangkok-local "วันที่ เดือน เวลา" (or a dash placeholder).
function fmtTime(iso) {
  if (!iso) return '<span class="dot">–</span>';
  const ms = Date.parse(iso);
  if (isNaN(ms)) return '<span class="dot">–</span>';
  return esc(new Date(ms).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
}

// Return [{o, i}] in the requested order. Orders without a time/zip sort last.
function sortedOrders(mode) {
  const arr = DATA.orders.map((o, i) => ({ o, i }));
  const ms = (x) => { const v = Date.parse(x.o.time); return isNaN(v) ? null : v; };
  if (mode === 'index') return arr; // original comment order
  if (mode === 'time-new' || mode === 'time-old') {
    const dir = mode === 'time-new' ? -1 : 1;
    return arr.sort((a, b) => {
      const ta = ms(a), tb = ms(b);
      if (ta === null && tb === null) return 0;
      if (ta === null) return 1;   // no-time rows always last
      if (tb === null) return -1;
      return (ta - tb) * dir;
    });
  }
  return arr.sort((a, b) => String(a.o.zip || '99999').localeCompare(String(b.o.zip || '99999'))); // zip; no-zip last
}

function customerTable() {
  const codes = DATA.displayColumns;
  const head = codes.map((c) => `<th class="num">${esc(c)}</th>`).join('');
  const hasTime = DATA.orders.some((o) => o.time);
  const ordered = sortedOrders(SORT);
  const body = ordered.map(({ o, i }, n) => {
    const cells = codes.map((c) => `<td class="num">${o.items[c] ? o.items[c] : '<span class="dot">·</span>'}</td>`).join('');
    const note = o.note ? `<div class="row-note">📝 ${esc(o.note)}</div>` : '';
    const remark = o.remark ? `<div class="row-remark">❓ ${esc(o.remark)} · รอคุณหลียืนยัน</div>` : '';
    const timeCell = hasTime ? `<td class="time">${fmtTime(o.time)}</td>` : '';
    return `<tr class="cust-row${o.remark ? ' has-remark' : ''}" data-kind="order" data-i="${i}"><td class="num idx">${n + 1}</td><td class="user">@${esc(o.user)}${note}${remark}</td><td class="zip">${esc(o.zip || '-')}</td>${cells}<td class="num total">${baht(rowTotal(o.items))}</td>${timeCell}<td class="slip">📋</td></tr>`;
  }).join('');
  const totals = tally(DATA.orders, codes);
  const totalRow = codes.map((c) => `<th class="num">${totals[c] || 0}</th>`).join('');
  const grand = DATA.orders.reduce((a, o) => a + rowTotal(o.items), 0);
  const timeHead = hasTime ? '<th>เวลาสั่ง</th>' : '';
  const timeFoot = hasTime ? '<th></th>' : '';
  return `<div class="table-scroll"><table class="tbl cust-tbl"><thead><tr><th class="num">#</th><th>ผู้สั่ง</th><th>ปณ.</th>${head}<th class="num">ยอด</th>${timeHead}<th></th></tr></thead><tbody>${body}</tbody><tfoot><tr><th></th><th>รวม</th><th></th>${totalRow}<th class="num">${baht(grand)}</th>${timeFoot}<th></th></tr></tfoot></table></div>`;
}

function captionSection() {
  if (!DATA.captionOrders || !DATA.captionOrders.length) return '';
  const rows = DATA.captionOrders.map((o, i) => {
    const list = Object.entries(o.items).map(([k, v]) => `${esc(k)} ${v}`).join(', ');
    return `<tr class="cust-row" data-kind="caption" data-i="${i}"><td class="user">@${esc(o.user)}</td><td class="zip">${esc(o.zip || '-')}</td><td>${list}</td><td class="num total">${baht(rowTotal(o.items))}</td><td class="slip">📋</td></tr>`;
  }).join('');
  const capTotal = DATA.captionOrders.reduce((a, o) => a + rowTotal(o.items), 0);
  return `<section class="block"><h3>📌 ออเดอร์ในแคปชัน (ไม่ใช่คอมเมนต์)</h3><table class="tbl"><thead><tr><th>ผู้สั่ง</th><th>ปณ.</th><th>รายการ</th><th class="num">ยอด</th><th></th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th colspan="3">รวมแคปชัน</th><th class="num">${baht(capTotal)}</th><th></th></tr></tfoot></table></section>`;
}

/* ---------- shipping (auto-default by postal code) ---------- */
// กทม.+ปริมณฑล (BKK + นนทบุรี/ปทุมธานี/สมุทรปราการ/นครปฐม/สมุทรสาคร) ship cheaper; ต่างจังหวัด is cold-courier.
// All values are overridable per round via DATA, and the amount stays editable in the popup.
function shippingZone(order) {
  const metro = DATA.shippingMetroPrefixes || ['10', '11', '12', '73', '74'];
  if (!order.zip) return { fee: DATA.shippingDefault ?? 100, label: 'ไม่ระบุ ปณ. — ตรวจสอบ', auto: false };
  if (metro.includes(order.zip.slice(0, 2)))
    return { fee: DATA.shippingBkk ?? DATA.shippingDefault ?? 100, label: 'กทม./ปริมณฑล', auto: true };
  return { fee: DATA.shippingUpcountry ?? 250, label: 'ต่างจังหวัด', auto: true };
}

/* ---------- per-customer popup ---------- */
function buildMessage(order, shipping) {
  const lines = [];
  lines.push('**' + (DATA.popupTitle || 'สรุปยอด'));
  lines.push('');
  lines.push('จัดส่ง' + (DATA.deliveryDateFull || DATA.deliveryDateLabel || ''));
  lines.push('');
  const codes = DATA.displayColumns.filter((c) => order.items[c]);
  for (const c of codes) {
    const qty = order.items[c];
    lines.push(`${shortName(c)} ×${qty}   ${fmt(qty * (PRICES[c] || 0))} บาท`);
  }
  if (order.note) lines.push(`หมายเหตุ: ${order.note}`);
  lines.push(`ค่าส่ง ${fmt(shipping)} บาท`);
  lines.push('');
  const grand = rowTotal(order.items) + Number(shipping || 0);
  lines.push(`รวมเป็นเงิน ${fmt(grand)} บาท`);
  lines.push('');
  const p = DATA.payment || {};
  lines.push('Payment :');
  if (p.name) lines.push(p.name);
  if (p.bank || p.account) lines.push(`${p.bank || ''} ${p.account || ''}`.trim());
  lines.push('');
  lines.push('หลังจากโอนเงินแล้ว');
  lines.push('รบกวนส่งหลักฐานการโอนเงินให้หลีด้วยนะคะ');
  lines.push('');
  lines.push('ขอบคุณค่ะ 😊');
  return { text: lines.join('\n'), grand };
}

function renderMsgCard(order, shipping) {
  const codes = DATA.displayColumns.filter((c) => order.items[c]);
  const itemRows = codes.map((c) => {
    const qty = order.items[c];
    return `<div class="m-row"><span>${esc(shortName(c))} <span class="m-qty">×${qty}</span></span><span class="m-amt">${fmt(qty * (PRICES[c] || 0))} บาท</span></div>`;
  }).join('');
  const noteRow = order.note ? `<div class="m-note">หมายเหตุ: ${esc(order.note)}</div>` : '';
  const grand = rowTotal(order.items) + Number(shipping || 0);
  const p = DATA.payment || {};
  return `
    <div class="m-title">**${esc(DATA.popupTitle || 'สรุปยอด')}</div>
    <div class="m-date">จัดส่ง${esc(DATA.deliveryDateFull || DATA.deliveryDateLabel || '')}</div>
    <div class="m-items">${itemRows}
      ${noteRow}
      <div class="m-row m-ship"><span>ค่าส่ง</span><span class="m-amt">${fmt(shipping)} บาท</span></div>
    </div>
    <div class="m-total"><span>รวมเป็นเงิน</span><span>${fmt(grand)} บาท</span></div>
    <div class="m-pay">
      <div>Payment :</div>
      <div>${esc(p.name || '')}</div>
      <div class="m-acct">${esc((p.bank || '') + ' ' + (p.account || ''))}</div>
    </div>
    <div class="m-foot">
      <div>หลังจากโอนเงินแล้ว</div>
      <div>รบกวนส่งหลักฐานการโอนเงินให้หลีด้วยนะคะ</div>
      <div class="m-thanks">ขอบคุณค่ะ 😊</div>
    </div>`;
}

function openPopup(order) {
  const zone = shippingZone(order);
  let shipping = zone.fee;

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-box" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div><strong>@${esc(order.user)}</strong> <span class="muted">· ปณ. ${esc(order.zip || '-')}</span></div>
        <button class="modal-x" title="ปิด">✕</button>
      </div>

      <div class="msg-card" id="shotCard">${renderMsgCard(order, shipping)}</div>

      <div class="modal-controls">
        <label class="ship-field">ค่าส่ง (บาท) <span class="ship-zone">· ${zone.auto ? 'auto: ' : ''}${esc(zone.label)}</span>
          <input type="number" id="shipInput" value="${shipping}" min="0" step="10" />
        </label>
        <button class="btn-copy" id="copyBtn">📋 คัดลอกข้อความ</button>
      </div>
      <p class="copy-msg" id="copyMsg"></p>

      <div class="verify-card">
        <div class="verify-label">🔎 คอมเมนต์ต้นฉบับ (สำหรับยืนยัน — ไม่ต้องส่งลูกค้า)</div>
        <div class="ig-comment">
          <div class="ig-ava">${esc((order.user || '?')[0].toUpperCase())}</div>
          <div class="ig-body"><div class="ig-user">${esc(order.user)}</div><div class="ig-text">${order.comment ? esc(order.comment) : '<span class="muted">— ไม่มีข้อความต้นฉบับ —</span>'}</div></div>
        </div>
        <div class="verify-parsed">ระบบอ่านได้: ${DATA.displayColumns.filter((c) => order.items[c]).map((c) => `${esc(shortName(c))} ×${order.items[c]}`).join(' · ')}</div>
        ${order.remark ? `<div class="verify-remark">❓ ข้อความที่ระบบไม่เข้าใจ: <b>${esc(order.remark)}</b><br>รอคุณหลีมาตอบ/ยืนยันว่าหมายถึงอะไร (ยังไม่ถูกนับเป็นเมนู)</div>` : ''}
        ${DATA.source && DATA.source.url ? `<a class="verify-link" href="${esc(DATA.source.url)}" target="_blank" rel="noopener">เปิดโพสต์ต้นฉบับบน Instagram ↗</a>` : ''}
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';

  const close = () => { modal.remove(); document.body.style.overflow = ''; };
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('.modal-x').addEventListener('click', close);
  document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } });

  const shipInput = modal.querySelector('#shipInput');
  shipInput.addEventListener('input', () => {
    shipping = Number(shipInput.value) || 0;
    modal.querySelector('#shotCard').innerHTML = renderMsgCard(order, shipping);
  });

  modal.querySelector('#copyBtn').addEventListener('click', async () => {
    const { text } = buildMessage(order, shipping);
    const msg = modal.querySelector('#copyMsg');
    try { await navigator.clipboard.writeText(text); msg.textContent = 'คัดลอกข้อความแล้ว ✓'; msg.className = 'copy-msg ok'; }
    catch { msg.textContent = 'คัดลอกไม่สำเร็จ — เลือกข้อความเองได้'; msg.className = 'copy-msg err'; }
  });
}

/* ---------- bootstrap ---------- */
async function loadOrder(id, pw) {
  const res = await fetch(`data/orders/${id}.enc.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error('ไม่พบไฟล์ออเดอร์: ' + id);
  return JSON.parse(await decryptBlob(await res.text(), pw));
}

async function main() {
  await requireUnlock();
  const pw = getPassword();
  const id = new URLSearchParams(location.search).get('id');
  const app = document.getElementById('app');
  if (!id) { app.innerHTML = '<p class="empty">ไม่ได้ระบุออเดอร์ · <a href="index.html">กลับหน้าแรก</a></p>'; return; }

  try { DATA = await loadOrder(id, pw); }
  catch (e) { app.innerHTML = `<p class="empty">${esc(e.message)} · <a href="index.html">กลับหน้าแรก</a></p>`; return; }
  PRICES = priceMap(DATA.menu);

  const summary = menuSummaryTable();
  const capTotal = (DATA.captionOrders || []).reduce((a, o) => a + rowTotal(o.items), 0);

  app.innerHTML = `
    <header class="site-header">
      <div>
        <a class="back" href="index.html">‹ กลับ</a>
        <h1>${esc(DATA.vendor || DATA.title)}</h1>
        <p class="muted">🗓️ จัดส่ง ${esc(DATA.deliveryDateLabel || DATA.deliveryDate || '-')}${DATA.source && DATA.source.url ? ` · <a href="${esc(DATA.source.url)}" target="_blank" rel="noopener">ที่มา (IG @${esc(DATA.source.account)})</a>` : ''}${DATA.parsedAt ? ` · 🔄 อัปเดต ${fmtTime(DATA.parsedAt)}` : ''}</p>
      </div>
      <button class="lock-btn" id="lockBtn" title="ออกจากระบบ">🔓 ล็อก</button>
    </header>
    <main class="container">
      <div class="stats">
        <div class="stat"><div class="stat-num">${baht(summary.grand)}</div><div class="stat-label">ยอดรวม (คอมเมนต์)</div></div>
        <div class="stat"><div class="stat-num">${summary.totalItems}</div><div class="stat-label">จำนวนรายการ</div></div>
        <div class="stat"><div class="stat-num">${DATA.countedComments ?? DATA.orders.length}</div><div class="stat-label">คอมเมนต์ที่นับ</div></div>
        <div class="stat alt"><div class="stat-num">${baht(summary.grand + capTotal)}</div><div class="stat-label">รวม + แคปชัน</div></div>
      </div>
      <p class="hint">💡 แตะที่แถวลูกค้าเพื่อเปิด <strong>ใบสรุป (ป๊อปอัพ)</strong> สำหรับแคปหน้าจอส่งลูกค้า</p>
      ${(() => { const r = DATA.orders.filter((o) => o.remark); return r.length ? `<p class="remark-banner">❓ มี <strong>${r.length}</strong> ออเดอร์ที่มีข้อความระบบไม่เข้าใจ รอคุณหลีมาตอบ: ${r.map((o) => '@' + esc(o.user)).join(', ')}</p>` : ''; })()}
      <section class="block"><h3>✅ สรุปยอดแต่ละเมนู</h3>${summary.html}<p class="muted small">* ยอดยังไม่รวมค่าจัดส่ง</p></section>
      <section class="block">
        <h3>👥 รายละเอียดรายคน (${DATA.orders.length}) — แตะเพื่อดูใบสรุป</h3>
        <div class="sortbar">เรียงตาม:
          <select id="sortSel">
            <option value="zip">รหัสไปรษณีย์</option>
            <option value="time-new">เวลาสั่ง · ใหม่→เก่า</option>
            <option value="time-old">เวลาสั่ง · เก่า→ใหม่</option>
            <option value="index">ลำดับคอมเมนต์</option>
          </select>
        </div>
        <div id="custWrap">${customerTable()}</div>
      </section>
      ${captionSection()}
      ${DATA.notes && DATA.notes.length ? `<section class="block"><h3>📝 หมายเหตุ</h3><ul class="notes">${DATA.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>` : ''}
    </main>
    <footer class="site-footer">RoodeeLMS · ข้อมูลถูกเข้ารหัสไว้ในเครื่อง · เปิดดูเฉพาะผู้มีรหัสผ่าน</footer>`;

  document.getElementById('lockBtn').addEventListener('click', lock);
  bindRows();
  const sortSel = document.getElementById('sortSel');
  if (sortSel) {
    sortSel.value = SORT;
    sortSel.addEventListener('change', () => {
      SORT = sortSel.value;
      document.getElementById('custWrap').innerHTML = customerTable();
      bindRows();
    });
  }
}

// (Re)attach popup-open handlers to every customer/caption row.
function bindRows() {
  document.querySelectorAll('.cust-row').forEach((row) => {
    row.onclick = () => {
      const i = Number(row.dataset.i);
      const order = row.dataset.kind === 'caption' ? DATA.captionOrders[i] : DATA.orders[i];
      openPopup(order);
    };
  });
}

main();
