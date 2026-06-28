// Cross-round analytics: revenue trend, item/category trends, and per-customer history.
// Loads + decrypts every round listed in the index and aggregates client-side.
import { requireUnlock, getPassword, lock, decryptBlob } from './gate.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const baht = (n) => '฿' + fmt(n);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Menus differ every round, so trends are rolled up to broad categories by keyword.
function categorize(name) {
  const s = String(name);
  if (/ลาบ/.test(s)) return 'ลาบ/ยำ';
  if (/ขนมจีน|น้ำยา/.test(s)) return 'ขนมจีน/น้ำยา';
  if (/แกง/.test(s)) return 'แกง';
  if (/เส้นหมี่|หมี่|ไวไว|เส้น/.test(s)) return 'เส้น';
  if (/ต้มยำ|ต้มข่า|ซุป|แจ่วฮ้อน|ซี่โครง|ต้ม/.test(s)) return 'ต้ม/ซุป';
  if (/ข้าวแมว|ข้าวคุณหลี|ข้าวผัด|^ข้าว|ข้าว(?!เหนียว)/.test(s)) return 'ข้าว/จานหลัก';
  if (/คอหมู|สะโพกไก่|อกไก่|เนื้อ|เบคอน|หมูปิ้ง|ไก่ปิ้ง|ย่าง|ปลาทู|แซลมอน|เป็ด/.test(s)) return 'ย่าง/โปรตีน';
  if (/น้ำมังคุด|น้ำมะพร้าว|น้ำแตงโม|มังคุด|มะพร้าว|แตงโม|สกัดเย็น|ออแกนิค/.test(s)) return 'เครื่องดื่ม';
  if (/โรตี|สังขยา|ขนมปัง|มะม่วงปลาย่าง|น้ำพริก|ข้าวเหนียว|หมูหยอง|ปลาสลิด/.test(s)) return 'ของหวาน/ของแนม';
  return 'อื่นๆ';
}

const priceMap = (menu) => { const m = {}; menu.forEach((x) => (m[x.code] = x.price)); return m; };
const nameMap = (menu) => { const m = {}; menu.forEach((x) => (m[x.code] = x.short || x.name)); return m; };
const fullName = (menu, code) => (menu.find((m) => m.code === code) || {}).name || code;
const rowTotal = (items, p) => { let t = 0; for (const k in items) t += items[k] * (p[k] || 0); return t; };

let ROUNDS = [];

async function loadRound(id, pw) {
  const res = await fetch(`data/orders/${id}.enc.json`, { cache: 'no-store' });
  if (!res.ok) return null;
  try { return JSON.parse(await decryptBlob(await res.text(), pw)); } catch { return null; }
}

function aggregate() {
  const rounds = ROUNDS.map((r) => {
    const p = priceMap(r.menu);
    const all = [...(r.orders || []), ...(r.captionOrders || [])];
    let rev = 0, items = 0;
    for (const o of all) for (const k in o.items) { rev += o.items[k] * (p[k] || 0); items += o.items[k]; }
    return { id: r.id, label: r.deliveryDateLabel || r.id, date: r.deliveryDate || r.id, rev, items, orders: (r.orders || []).length };
  });

  // category x round revenue matrix
  const cats = {};
  ROUNDS.forEach((r) => {
    const p = priceMap(r.menu);
    [...(r.orders || []), ...(r.captionOrders || [])].forEach((o) => {
      for (const k in o.items) {
        const mi = r.menu.find((m) => m.code === k) || {};
        const cat = mi.category || categorize(mi.name || k); // prefer explicit category; heuristic fallback
        const rev = o.items[k] * (p[k] || 0);
        cats[cat] = cats[cat] || { byRound: {}, total: 0, qty: 0 };
        cats[cat].byRound[r.id] = (cats[cat].byRound[r.id] || 0) + rev;
        cats[cat].total += rev; cats[cat].qty += o.items[k];
      }
    });
  });

  // top items per round
  const topItems = ROUNDS.map((r) => {
    const cnt = {};
    [...(r.orders || []), ...(r.captionOrders || [])].forEach((o) => { for (const k in o.items) cnt[k] = (cnt[k] || 0) + o.items[k]; });
    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, q]) => `${esc((r.menu.find((m) => m.code === k) || {}).short || k)} ×${q}`);
    return { label: r.deliveryDateLabel || r.id, top };
  });

  // per-customer history (real commenters)
  const cust = {};
  ROUNDS.forEach((r) => {
    const p = priceMap(r.menu), nm = nameMap(r.menu);
    (r.orders || []).forEach((o) => {
      const t = rowTotal(o.items, p);
      const itemsStr = Object.keys(o.items).map((k) => `${esc(nm[k] || k)}×${o.items[k]}`).join(', ');
      cust[o.user] = cust[o.user] || { rounds: new Set(), lines: [], total: 0, count: 0 };
      cust[o.user].rounds.add(r.id);
      cust[o.user].lines.push({ round: r.deliveryDateLabel || r.id, date: r.deliveryDate, items: itemsStr, total: t, note: o.note, remark: o.remark });
      cust[o.user].total += t; cust[o.user].count++;
    });
  });

  return { rounds, cats, topItems, cust };
}

function renderTrend(rounds) {
  const max = Math.max(1, ...rounds.map((r) => r.rev));
  const rows = rounds.map((r) => `
    <tr><td>${esc(r.label)}</td><td class="num">${r.orders}</td><td class="num">${fmt(r.items)}</td>
    <td class="num">${baht(r.rev)}</td>
    <td class="barcell"><span class="bar" style="width:${Math.round((r.rev / max) * 100)}%"></span></td></tr>`).join('');
  const totalRev = rounds.reduce((a, r) => a + r.rev, 0);
  return `<section class="block"><h3>📈 เทรนด์รายรอบ (รายได้รวม)</h3>
    <div class="table-scroll"><table class="tbl"><thead><tr><th>รอบจัดส่ง</th><th class="num">ออเดอร์</th><th class="num">รายการ</th><th class="num">รายได้</th><th>·</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><th>รวมทุกรอบ</th><th></th><th></th><th class="num">${baht(totalRev)}</th><th></th></tr></tfoot></table></div></section>`;
}

function renderCategories(cats, rounds) {
  const order = Object.entries(cats).sort((a, b) => b[1].total - a[1].total);
  const head = rounds.map((r) => `<th class="num" title="${esc(r.label)}">${esc(r.label.replace(/ที่ /, '').replace(' 2569', ''))}</th>`).join('');
  const body = order.map(([cat, d]) => {
    const cells = rounds.map((r) => `<td class="num">${d.byRound[r.id] ? baht(d.byRound[r.id]) : '<span class="dot">·</span>'}</td>`).join('');
    return `<tr><td>${esc(cat)}</td>${cells}<td class="num total">${baht(d.total)}</td></tr>`;
  }).join('');
  return `<section class="block"><h3>🍽️ เทรนด์ตามหมวดอาหาร (รายได้ต่อรอบ)</h3>
    <div class="table-scroll"><table class="tbl"><thead><tr><th>หมวด</th>${head}<th class="num">รวม</th></tr></thead><tbody>${body}</tbody></table></div>
    <p class="muted small">* หมวดจัดอัตโนมัติจากชื่อเมนู (เมนูแต่ละรอบต่างกัน)</p></section>`;
}

function renderTopItems(topItems) {
  const rows = topItems.map((t) => `<tr><td>${esc(t.label)}</td><td>${t.top.join(' · ')}</td></tr>`).join('');
  return `<section class="block"><h3>🏆 เมนูขายดีแต่ละรอบ</h3><div class="table-scroll"><table class="tbl"><thead><tr><th>รอบ</th><th>ขายดีสุด (ตามจำนวน)</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderCustomers(cust) {
  const list = Object.entries(cust).sort((a, b) => b[1].total - a[1].total);
  const repeat = list.filter(([, d]) => d.rounds.size >= 2).length;
  const rowsHtml = (entries) => entries.map(([u, d]) => {
    const lines = d.lines.map((l) => `<div class="hist-line"><span class="hist-round">${esc(l.round)}</span> ${l.items}${l.note ? ` <span class="hist-note">📝${esc(l.note)}</span>` : ''}${l.remark ? ` <span class="hist-remark">❓${esc(l.remark)}</span>` : ''} <span class="hist-amt">${baht(l.total)}</span></div>`).join('');
    return `<details class="cust-item" data-user="${esc(u.toLowerCase())}"><summary><span class="cust-name">@${esc(u)}</span>${d.rounds.size >= 2 ? `<span class="badge badge-open">ลูกค้าประจำ ${d.rounds.size} รอบ</span>` : `<span class="muted small">${d.rounds.size} รอบ</span>`}<span class="cust-total">${baht(d.total)}</span></summary><div class="hist-lines">${lines}</div></details>`;
  }).join('');
  return `<section class="block"><h3>👤 ประวัติลูกค้า (${list.length} คน · ลูกค้าประจำ ${repeat} คน)</h3>
    <input type="text" id="custSearch" class="cust-search" placeholder="🔍 ค้นหาชื่อลูกค้า (เช่น juve2000)" />
    <div id="custList">${rowsHtml(list)}</div></section>`;
}

async function main() {
  const index = await requireUnlock();
  const pw = getPassword();
  const app = document.getElementById('app');
  app.innerHTML = `<header class="site-header"><div><a class="back" href="index.html">‹ กลับ</a><h1>📊 สถิติ & เทรนด์</h1><p class="muted">${esc(index.site || 'RoodeeLMS')} · กำลังโหลด…</p></div><button class="lock-btn" id="lockBtn" title="ออกจากระบบ">🔓 ล็อก</button></header><main class="container"><p class="empty">⏳ กำลังถอดรหัสข้อมูลทุกรอบ…</p></main>`;
  document.getElementById('lockBtn').addEventListener('click', lock);

  ROUNDS = [];
  for (const m of (index.orders || [])) { const d = await loadRound(m.id, pw); if (d) ROUNDS.push(d); }
  ROUNDS.sort((a, b) => String(a.deliveryDate || a.id).localeCompare(String(b.deliveryDate || b.id)));

  if (!ROUNDS.length) { app.querySelector('main').innerHTML = '<p class="empty">ยังไม่มีข้อมูลรอบ</p>'; return; }

  const { rounds, cats, topItems, cust } = aggregate();
  const totalOrders = rounds.reduce((a, r) => a + r.orders, 0);
  const grand = rounds.reduce((a, r) => a + r.rev, 0);

  app.innerHTML = `
    <header class="site-header"><div><a class="back" href="index.html">‹ กลับ</a><h1>📊 สถิติ & เทรนด์</h1>
      <p class="muted">${esc(index.site || 'RoodeeLMS')} · ${rounds.length} รอบ</p></div>
      <button class="lock-btn" id="lockBtn" title="ออกจากระบบ">🔓 ล็อก</button></header>
    <main class="container">
      <div class="stats">
        <div class="stat"><div class="stat-num">${rounds.length}</div><div class="stat-label">รอบทั้งหมด</div></div>
        <div class="stat"><div class="stat-num">${fmt(totalOrders)}</div><div class="stat-label">ออเดอร์รวม</div></div>
        <div class="stat"><div class="stat-num">${Object.keys(cust).length}</div><div class="stat-label">ลูกค้า (ไม่ซ้ำ)</div></div>
        <div class="stat alt"><div class="stat-num">${baht(grand)}</div><div class="stat-label">รายได้รวมทุกรอบ</div></div>
      </div>
      ${renderTrend(rounds)}
      ${renderCategories(cats, rounds)}
      ${renderTopItems(topItems)}
      ${renderCustomers(cust)}
    </main>
    <footer class="site-footer">RoodeeLMS · ข้อมูลถูกเข้ารหัสไว้ในเครื่อง · เปิดดูเฉพาะผู้มีรหัสผ่าน</footer>`;
  document.getElementById('lockBtn').addEventListener('click', lock);

  const search = document.getElementById('custSearch');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    document.querySelectorAll('#custList .cust-item').forEach((el) => {
      el.style.display = !q || el.dataset.user.includes(q) ? '' : 'none';
    });
  });
}

main();
