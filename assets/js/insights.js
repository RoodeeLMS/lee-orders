// Cross-round analytics: monthly summaries + revenue/item/category trends + per-customer history.
// Loads + decrypts every round listed in the index and aggregates client-side.
// Data is split by เดือน (from each round's deliveryDate); a month filter scopes every section.
import { requireUnlock, getPassword, lock, decryptBlob } from './gate.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const baht = (n) => '฿' + fmt(n);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const THAI_MONTH = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const THAI_MONTH_SHORT = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

// deliveryDate "2569-06-16" -> { key:"2569-06", label:"มิถุนายน 2569", short:"มิ.ย. 2569" }
function monthOf(round) {
  const d = String(round.deliveryDate || round.id);
  const m = d.match(/(25\d\d)-(\d{2})/);
  if (!m) return { key: 'อื่นๆ', label: 'อื่นๆ', short: 'อื่นๆ' };
  const yr = m[1], mo = parseInt(m[2], 10);
  return { key: `${yr}-${m[2]}`, label: `${THAI_MONTH[mo]} ${yr}`, short: `${THAI_MONTH_SHORT[mo]} ${yr}` };
}

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
const rowTotal = (items, p) => { let t = 0; for (const k in items) t += items[k] * (p[k] || 0); return t; };

let ROUNDS = [];
let MONTHS = [];   // [{key,label,short}] oldest->newest
let SEL = 'all';   // selected month key or 'all'

async function loadRound(id, pw) {
  const res = await fetch(`data/orders/${id}.enc.json`, { cache: 'no-store' });
  if (!res.ok) return null;
  try { return JSON.parse(await decryptBlob(await res.text(), pw)); } catch { return null; }
}

// Per-month rollup across ALL rounds (for the monthly-summary table + returning-customer counts).
function monthlyRollup() {
  const byKey = {};
  ROUNDS.forEach((r) => {
    const mk = monthOf(r);
    const p = priceMap(r.menu);
    const M = byKey[mk.key] || (byKey[mk.key] = { ...mk, rounds: 0, orders: 0, items: 0, rev: 0, cust: new Set() });
    M.rounds++;
    const all = [...(r.orders || []), ...(r.captionOrders || [])];
    for (const o of all) for (const k in o.items) { M.rev += o.items[k] * (p[k] || 0); M.items += o.items[k]; }
    M.orders += (r.orders || []).length;
    (r.orders || []).forEach((o) => M.cust.add(o.user));
  });
  const keys = Object.keys(byKey).sort();
  // returning customers = this month's customers who also ordered the previous (chronological) month
  return keys.map((k, i) => {
    const M = byKey[k];
    let returning = 0;
    if (i > 0) { const prev = byKey[keys[i - 1]].cust; M.cust.forEach((u) => { if (prev.has(u)) returning++; }); }
    return { ...M, custCount: M.cust.size, returning, hasPrev: i > 0 };
  });
}

function scopedRounds() {
  return SEL === 'all' ? ROUNDS : ROUNDS.filter((r) => monthOf(r).key === SEL);
}

function aggregate(rounds) {
  const rounds2 = rounds.map((r) => {
    const p = priceMap(r.menu);
    const all = [...(r.orders || []), ...(r.captionOrders || [])];
    let rev = 0, items = 0;
    for (const o of all) for (const k in o.items) { rev += o.items[k] * (p[k] || 0); items += o.items[k]; }
    return { id: r.id, label: r.deliveryDateLabel || r.id, rev, items, orders: (r.orders || []).length };
  });

  const cats = {};
  rounds.forEach((r) => {
    const p = priceMap(r.menu);
    [...(r.orders || []), ...(r.captionOrders || [])].forEach((o) => {
      for (const k in o.items) {
        const mi = r.menu.find((m) => m.code === k) || {};
        const cat = mi.category || categorize(mi.name || k);
        const rev = o.items[k] * (p[k] || 0);
        cats[cat] = cats[cat] || { byRound: {}, total: 0, qty: 0 };
        cats[cat].byRound[r.id] = (cats[cat].byRound[r.id] || 0) + rev;
        cats[cat].total += rev; cats[cat].qty += o.items[k];
      }
    });
  });

  const topItems = rounds.map((r) => {
    const cnt = {};
    [...(r.orders || []), ...(r.captionOrders || [])].forEach((o) => { for (const k in o.items) cnt[k] = (cnt[k] || 0) + o.items[k]; });
    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, q]) => `${esc((r.menu.find((m) => m.code === k) || {}).short || k)} ×${q}`);
    return { label: r.deliveryDateLabel || r.id, top };
  });

  const cust = {};
  rounds.forEach((r) => {
    const p = priceMap(r.menu), nm = nameMap(r.menu);
    (r.orders || []).forEach((o) => {
      const t = rowTotal(o.items, p);
      const itemsStr = Object.keys(o.items).map((k) => `${esc(nm[k] || k)}×${o.items[k]}`).join(', ');
      cust[o.user] = cust[o.user] || { rounds: new Set(), lines: [], total: 0, count: 0 };
      cust[o.user].rounds.add(r.id);
      cust[o.user].lines.push({ round: r.deliveryDateLabel || r.id, items: itemsStr, total: t, note: o.note, remark: o.remark });
      cust[o.user].total += t; cust[o.user].count++;
    });
  });

  return { rounds: rounds2, cats, topItems, cust };
}

function renderMonthSummary(monthly) {
  if (monthly.length < 1) return '';
  const rows = monthly.map((m) => {
    const active = SEL === m.key ? ' class="row-sel"' : '';
    return `<tr${active}><td><a href="#" class="mlink" data-mk="${esc(m.key)}">${esc(m.label)}</a></td>
      <td class="num">${m.rounds}</td><td class="num">${m.orders}</td><td class="num">${fmt(m.items)}</td>
      <td class="num">${m.custCount}</td><td class="num">${m.hasPrev ? m.returning : '<span class="dot">·</span>'}</td>
      <td class="num">${baht(m.rev)}</td></tr>`;
  }).join('');
  const tR = monthly.reduce((a, m) => a + m.rounds, 0), tO = monthly.reduce((a, m) => a + m.orders, 0);
  const tI = monthly.reduce((a, m) => a + m.items, 0), tV = monthly.reduce((a, m) => a + m.rev, 0);
  return `<section class="block"><h3>🗓️ สรุปรายเดือน</h3>
    <div class="table-scroll"><table class="tbl"><thead><tr><th>เดือน</th><th class="num">รอบ</th><th class="num">ออเดอร์</th><th class="num">รายการ</th><th class="num">ลูกค้า</th><th class="num" title="ลูกค้าที่กลับมาสั่งซ้ำจากเดือนก่อนหน้า">ซ้ำเดือนก่อน</th><th class="num">รายได้</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><th>รวม</th><th class="num">${tR}</th><th class="num">${tO}</th><th class="num">${fmt(tI)}</th><th></th><th></th><th class="num">${baht(tV)}</th></tr></tfoot></table></div>
    <p class="muted small">* คลิกชื่อเดือนเพื่อกรองดูเฉพาะเดือนนั้น · "ซ้ำเดือนก่อน" = ลูกค้าที่สั่งทั้งเดือนนี้และเดือนก่อนหน้า</p></section>`;
}

function renderFilterBar(monthly) {
  const chip = (key, label) => `<button class="mchip${SEL === key ? ' on' : ''}" data-mk="${esc(key)}">${esc(label)}</button>`;
  return `<div class="mfilter">${chip('all', 'ทุกเดือน')}${monthly.map((m) => chip(m.key, m.short)).join('')}</div>`;
}

function renderTrend(rounds) {
  if (!rounds.length) return '';
  const max = Math.max(1, ...rounds.map((r) => r.rev));
  const rows = rounds.map((r) => `
    <tr><td>${esc(r.label)}</td><td class="num">${r.orders}</td><td class="num">${fmt(r.items)}</td>
    <td class="num">${baht(r.rev)}</td>
    <td class="barcell"><span class="bar" style="width:${Math.round((r.rev / max) * 100)}%"></span></td></tr>`).join('');
  const totalRev = rounds.reduce((a, r) => a + r.rev, 0);
  return `<section class="block"><h3>📈 เทรนด์รายรอบ (รายได้รวม)</h3>
    <div class="table-scroll"><table class="tbl"><thead><tr><th>รอบจัดส่ง</th><th class="num">ออเดอร์</th><th class="num">รายการ</th><th class="num">รายได้</th><th>·</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><th>รวม</th><th></th><th></th><th class="num">${baht(totalRev)}</th><th></th></tr></tfoot></table></div></section>`;
}

function renderCategories(cats, rounds) {
  const order = Object.entries(cats).sort((a, b) => b[1].total - a[1].total);
  if (!order.length) return '';
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

function renderCustomers(cust, scopeLabel) {
  const list = Object.entries(cust).sort((a, b) => b[1].total - a[1].total);
  const repeat = list.filter(([, d]) => d.rounds.size >= 2).length;
  const rowsHtml = (entries) => entries.map(([u, d]) => {
    const lines = d.lines.map((l) => `<div class="hist-line"><span class="hist-round">${esc(l.round)}</span> ${l.items}${l.note ? ` <span class="hist-note">📝${esc(l.note)}</span>` : ''}${l.remark ? ` <span class="hist-remark">❓${esc(l.remark)}</span>` : ''} <span class="hist-amt">${baht(l.total)}</span></div>`).join('');
    return `<details class="cust-item" data-user="${esc(u.toLowerCase())}"><summary><span class="cust-name">@${esc(u)}</span>${d.rounds.size >= 2 ? `<span class="badge badge-open">ลูกค้าประจำ ${d.rounds.size} รอบ</span>` : `<span class="muted small">${d.rounds.size} รอบ</span>`}<span class="cust-total">${baht(d.total)}</span></summary><div class="hist-lines">${lines}</div></details>`;
  }).join('');
  return `<section class="block"><h3>👤 ประวัติลูกค้า${scopeLabel ? ` · ${esc(scopeLabel)}` : ''} (${list.length} คน · ลูกค้าประจำ ${repeat} คน)</h3>
    <input type="text" id="custSearch" class="cust-search" placeholder="🔍 ค้นหาชื่อลูกค้า (เช่น juve2000)" />
    <div id="custList">${rowsHtml(list)}</div></section>`;
}

// Re-renders the month-scoped portion (stat cards + trends + customers) when the filter changes.
function renderDyn() {
  const rounds = scopedRounds();
  const { rounds: rs, cats, topItems, cust } = aggregate(rounds);
  const totalOrders = rs.reduce((a, r) => a + r.orders, 0);
  const grand = rs.reduce((a, r) => a + r.rev, 0);
  const scopeLabel = SEL === 'all' ? '' : (monthOf(rounds[0] || {}).label || '');
  const dyn = document.getElementById('dyn');
  dyn.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="stat-num">${rs.length}</div><div class="stat-label">รอบ${SEL === 'all' ? 'ทั้งหมด' : ''}</div></div>
      <div class="stat"><div class="stat-num">${fmt(totalOrders)}</div><div class="stat-label">ออเดอร์${SEL === 'all' ? 'รวม' : ''}</div></div>
      <div class="stat"><div class="stat-num">${Object.keys(cust).length}</div><div class="stat-label">ลูกค้า (ไม่ซ้ำ)</div></div>
      <div class="stat alt"><div class="stat-num">${baht(grand)}</div><div class="stat-label">รายได้${SEL === 'all' ? 'รวมทุกรอบ' : 'เดือนนี้'}</div></div>
    </div>
    ${SEL !== 'all' ? `<p class="scope-note">กำลังดูเฉพาะเดือน <b>${esc(scopeLabel)}</b> · <a href="#" id="clearScope">ดูทุกเดือน</a></p>` : ''}
    ${renderTrend(rs)}
    ${renderCategories(cats, rs)}
    ${renderTopItems(topItems)}
    ${renderCustomers(cust, scopeLabel)}`;

  const search = document.getElementById('custSearch');
  if (search) search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    document.querySelectorAll('#custList .cust-item').forEach((el) => { el.style.display = !q || el.dataset.user.includes(q) ? '' : 'none'; });
  });
  const clr = document.getElementById('clearScope');
  if (clr) clr.addEventListener('click', (e) => { e.preventDefault(); setMonth('all'); });
}

function setMonth(key) {
  SEL = key;
  document.querySelectorAll('.mchip').forEach((b) => b.classList.toggle('on', b.dataset.mk === key));
  document.querySelectorAll('#monthSummary tr').forEach((tr) => tr.classList.remove('row-sel'));
  renderDyn();
  document.getElementById('dyn').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  const monthly = monthlyRollup();
  MONTHS = monthly.map((m) => ({ key: m.key, label: m.label, short: m.short }));

  app.innerHTML = `
    <header class="site-header"><div><a class="back" href="index.html">‹ กลับ</a><h1>📊 สถิติ & เทรนด์</h1>
      <p class="muted">${esc(index.site || 'RoodeeLMS')} · ${ROUNDS.length} รอบ · ${monthly.length} เดือน</p></div>
      <button class="lock-btn" id="lockBtn" title="ออกจากระบบ">🔓 ล็อก</button></header>
    <main class="container">
      <div id="monthSummary">${renderMonthSummary(monthly)}</div>
      ${renderFilterBar(monthly)}
      <div id="dyn"></div>
    </main>
    <footer class="site-footer">RoodeeLMS · ข้อมูลถูกเข้ารหัสไว้ในเครื่อง · เปิดดูเฉพาะผู้มีรหัสผ่าน</footer>`;
  document.getElementById('lockBtn').addEventListener('click', lock);

  document.querySelectorAll('.mchip').forEach((b) => b.addEventListener('click', () => setMonth(b.dataset.mk)));
  document.querySelectorAll('.mlink').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); setMonth(a.dataset.mk); }));

  renderDyn();
}

main();
