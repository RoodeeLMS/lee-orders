// Order detail page: loads + decrypts one order file and renders the summary.
import { requireUnlock, getPassword, lock, decryptBlob } from './gate.js';

const baht = (n) => '฿' + Number(n || 0).toLocaleString('en-US');

function priceMap(menu) {
  const m = {};
  for (const item of menu) m[item.code] = item.price;
  return m;
}

function rowTotal(items, prices) {
  let t = 0;
  for (const k in items) t += (items[k] || 0) * (prices[k] || 0);
  return t;
}

function tally(orders, codes) {
  const counts = {};
  codes.forEach((c) => (counts[c] = 0));
  for (const o of orders) for (const k in o.items) counts[k] = (counts[k] || 0) + o.items[k];
  return counts;
}

function menuSummaryTable(data, prices) {
  const codes = data.displayColumns;
  const counts = tally(data.orders, codes);
  let grand = 0;
  const rows = codes.map((c) => {
    const menuItem = data.menu.find((m) => m.code === c) || { name: c, price: prices[c] || 0 };
    const qty = counts[c] || 0;
    const sub = qty * (prices[c] || 0);
    grand += sub;
    return `<tr${qty === 0 ? ' class="zero"' : ''}>
      <td>${menuItem.name}</td>
      <td class="num">${qty}</td>
      <td class="num">${baht(prices[c] || 0)}</td>
      <td class="num">${baht(sub)}</td></tr>`;
  }).join('');
  return { html: `
    <table class="tbl summary-tbl">
      <thead><tr><th>เมนู</th><th class="num">จำนวน</th><th class="num">ราคา/ที่</th><th class="num">รวม</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th>รวมทั้งสิ้น</th><th class="num">${Object.values(counts).reduce((a, b) => a + b, 0)}</th><th></th><th class="num">${baht(grand)}</th></tr></tfoot>
    </table>`, grand, counts };
}

function customerTable(data, prices) {
  const codes = data.displayColumns;
  const head = codes.map((c) => `<th class="num" title="${(data.menu.find((m) => m.code === c) || {}).name || c}">${c}</th>`).join('');
  let n = 0;
  const body = data.orders.map((o) => {
    n++;
    const cells = codes.map((c) => `<td class="num">${o.items[c] ? o.items[c] : '<span class="dot">·</span>'}</td>`).join('');
    const note = o.note ? `<div class="row-note">📝 ${o.note}</div>` : '';
    return `<tr>
      <td class="num idx">${n}</td>
      <td class="user">@${o.user}${note}</td>
      <td class="zip">${o.zip || '-'}</td>
      ${cells}
      <td class="num total">${baht(rowTotal(o.items, prices))}</td></tr>`;
  }).join('');
  const totals = tally(data.orders, codes);
  const totalRow = codes.map((c) => `<th class="num">${totals[c] || 0}</th>`).join('');
  const grand = data.orders.reduce((a, o) => a + rowTotal(o.items, prices), 0);
  return `
    <div class="table-scroll">
      <table class="tbl cust-tbl">
        <thead><tr><th class="num">#</th><th>ผู้สั่ง</th><th>ปณ.</th>${head}<th class="num">ยอด</th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><th></th><th>รวม</th><th></th>${totalRow}<th class="num">${baht(grand)}</th></tr></tfoot>
      </table>
    </div>`;
}

function captionSection(data, prices) {
  if (!data.captionOrders || !data.captionOrders.length) return '';
  const rows = data.captionOrders.map((o) => {
    const list = Object.entries(o.items).map(([k, v]) => `${k} ${v}`).join(', ');
    return `<tr><td class="user">@${o.user}</td><td class="zip">${o.zip || '-'}</td><td>${list}</td><td class="num total">${baht(rowTotal(o.items, prices))}</td></tr>`;
  }).join('');
  const capTotal = data.captionOrders.reduce((a, o) => a + rowTotal(o.items, prices), 0);
  return `
    <section class="block">
      <h3>📌 ออเดอร์ในแคปชัน (ไม่ใช่คอมเมนต์)</h3>
      <table class="tbl">
        <thead><tr><th>ผู้สั่ง</th><th>ปณ.</th><th>รายการ</th><th class="num">ยอด</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th colspan="3">รวมแคปชัน</th><th class="num">${baht(capTotal)}</th></tr></tfoot>
      </table>
    </section>`;
}

async function loadOrder(id, pw) {
  const file = `data/orders/${id}.enc.json`;
  const res = await fetch(file, { cache: 'no-store' });
  if (!res.ok) throw new Error('ไม่พบไฟล์ออเดอร์: ' + id);
  const blob = await res.text();
  return JSON.parse(await decryptBlob(blob, pw));
}

async function main() {
  await requireUnlock();
  const pw = getPassword();
  const id = new URLSearchParams(location.search).get('id');
  const app = document.getElementById('app');

  if (!id) { app.innerHTML = '<p class="empty">ไม่ได้ระบุออเดอร์ · <a href="index.html">กลับหน้าแรก</a></p>'; return; }

  let data;
  try { data = await loadOrder(id, pw); }
  catch (e) { app.innerHTML = `<p class="empty">${e.message} · <a href="index.html">กลับหน้าแรก</a></p>`; return; }

  const prices = priceMap(data.menu);
  const summary = menuSummaryTable(data, prices);
  const totalItems = Object.values(summary.counts).reduce((a, b) => a + b, 0);
  const capTotal = (data.captionOrders || []).reduce((a, o) => a + rowTotal(o.items, prices), 0);

  app.innerHTML = `
    <header class="site-header">
      <div>
        <a class="back" href="index.html">‹ กลับ</a>
        <h1>${data.vendor || data.title}</h1>
        <p class="muted">🗓️ จัดส่ง ${data.deliveryDateLabel || data.deliveryDate || '-'}
          ${data.source && data.source.url ? ` · <a href="${data.source.url}" target="_blank" rel="noopener">ที่มา (IG @${data.source.account})</a>` : ''}</p>
      </div>
      <button class="lock-btn" id="lockBtn" title="ออกจากระบบ">🔓 ล็อก</button>
    </header>
    <main class="container">
      <div class="stats">
        <div class="stat"><div class="stat-num">${baht(summary.grand)}</div><div class="stat-label">ยอดรวม (คอมเมนต์)</div></div>
        <div class="stat"><div class="stat-num">${totalItems}</div><div class="stat-label">จำนวนรายการ</div></div>
        <div class="stat"><div class="stat-num">${data.countedComments ?? data.orders.length}</div><div class="stat-label">คอมเมนต์ที่นับ</div></div>
        <div class="stat alt"><div class="stat-num">${baht(summary.grand + capTotal)}</div><div class="stat-label">รวม + แคปชัน</div></div>
      </div>

      <section class="block">
        <h3>✅ สรุปยอดแต่ละเมนู</h3>
        ${summary.html}
        <p class="muted small">* ยอดยังไม่รวมค่าจัดส่ง (กทม./ปริมณฑล Lalamove · ไกล Makesend 100฿ · ต่างจังหวัด Nim 250฿)</p>
      </section>

      <section class="block">
        <h3>👥 รายละเอียดรายคน (${data.orders.length})</h3>
        ${customerTable(data, prices)}
      </section>

      ${captionSection(data, prices)}

      ${data.notes && data.notes.length ? `
      <section class="block">
        <h3>📝 หมายเหตุ</h3>
        <ul class="notes">${data.notes.map((n) => `<li>${n}</li>`).join('')}</ul>
      </section>` : ''}
    </main>
    <footer class="site-footer">RoodeeLMS · ข้อมูลถูกเข้ารหัสไว้ในเครื่อง · เปิดดูเฉพาะผู้มีรหัสผ่าน</footer>`;

  document.getElementById('lockBtn').addEventListener('click', lock);
}

main();
