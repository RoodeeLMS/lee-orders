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
  // returning (vs previous month) + new/back (vs ALL earlier months, cumulative) + AOV
  const seen = new Set();
  return keys.map((k, i) => {
    const M = byKey[k];
    let returning = 0;
    if (i > 0) { const prev = byKey[keys[i - 1]].cust; M.cust.forEach((u) => { if (prev.has(u)) returning++; }); }
    let newCount = 0; M.cust.forEach((u) => { if (!seen.has(u)) newCount++; });
    const backCount = M.cust.size - newCount;       // ordered in some earlier month too
    M.cust.forEach((u) => seen.add(u));
    const aov = M.orders ? Math.round(M.rev / M.orders) : 0;
    return { ...M, custCount: M.cust.size, returning, newCount, backCount, aov, hasPrev: i > 0 };
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
      <td class="num">${baht(m.aov)}</td><td class="num">${baht(m.rev)}</td></tr>`;
  }).join('');
  const tR = monthly.reduce((a, m) => a + m.rounds, 0), tO = monthly.reduce((a, m) => a + m.orders, 0);
  const tI = monthly.reduce((a, m) => a + m.items, 0), tV = monthly.reduce((a, m) => a + m.rev, 0);
  return `<section class="block"><h3>🗓️ สรุปรายเดือน</h3>
    <div class="table-scroll"><table class="tbl"><thead><tr><th>เดือน</th><th class="num">รอบ</th><th class="num">ออเดอร์</th><th class="num">รายการ</th><th class="num">ลูกค้า</th><th class="num" title="ลูกค้าที่กลับมาสั่งซ้ำจากเดือนก่อนหน้า">ซ้ำเดือนก่อน</th><th class="num" title="รายได้เฉลี่ยต่อ 1 ออเดอร์">เฉลี่ย/ออเดอร์</th><th class="num">รายได้</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><th>รวม</th><th class="num">${tR}</th><th class="num">${tO}</th><th class="num">${fmt(tI)}</th><th></th><th></th><th class="num">${baht(tO ? Math.round(tV / tO) : 0)}</th><th class="num">${baht(tV)}</th></tr></tfoot></table></div>
    <p class="muted small">* คลิกชื่อเดือนเพื่อกรองดูเฉพาะเดือนนั้น · "ซ้ำเดือนก่อน" = ลูกค้าที่สั่งทั้งเดือนนี้และเดือนก่อนหน้า · "เฉลี่ย/ออเดอร์" = รายได้ ÷ จำนวนออเดอร์</p></section>`;
}

function renderNewReturning(monthly) {
  if (monthly.length < 2) return '';  // only meaningful with 2+ months
  const max = Math.max(1, ...monthly.map((m) => m.custCount));
  const rows = monthly.map((m, i) => {
    const nwPct = Math.round((m.newCount / max) * 100), bkPct = Math.round((m.backCount / max) * 100);
    const ret = (i > 0 && monthly[i - 1].custCount) ? Math.round((m.returning / monthly[i - 1].custCount) * 100) + '%' : '<span class="dot">·</span>';
    return `<tr><td>${esc(m.label)}</td>
      <td class="num">${m.newCount}</td><td class="num">${m.backCount}</td><td class="num">${m.custCount}</td><td class="num">${ret}</td>
      <td class="barcell"><span class="bar2 nw" style="width:${nwPct}%"></span><span class="bar2 bk" style="width:${bkPct}%"></span></td></tr>`;
  }).join('');
  return `<section class="block"><h3>🌱 ลูกค้าใหม่ vs กลับมา (รายเดือน)</h3>
    <div class="table-scroll"><table class="tbl"><thead><tr><th>เดือน</th><th class="num">ลูกค้าใหม่</th><th class="num">กลับมา</th><th class="num">รวม</th><th class="num" title="สัดส่วนลูกค้าเดือนก่อนที่กลับมาสั่งเดือนนี้">คงอยู่</th><th><span class="lg nw"></span>ใหม่ <span class="lg bk"></span>กลับมา</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted small">* "ลูกค้าใหม่" = ไม่เคยสั่งในเดือนก่อนๆ เลย · "กลับมา" = เคยสั่งเดือนก่อนหน้า · "คงอยู่" = ลูกค้าเดือนก่อนที่กลับมาสั่งเดือนนี้ ÷ ลูกค้าเดือนก่อนทั้งหมด</p></section>`;
}

function renderTopDishes(rounds) {
  const agg = {};  // short name -> { qty, rev }  (same-named dishes summed across rounds)
  rounds.forEach((r) => {
    const p = priceMap(r.menu);
    [...(r.orders || []), ...(r.captionOrders || [])].forEach((o) => {
      for (const k in o.items) {
        const mi = r.menu.find((m) => m.code === k) || {};
        const nm = mi.short || mi.name || k;
        agg[nm] = agg[nm] || { qty: 0, rev: 0 };
        agg[nm].qty += o.items[k]; agg[nm].rev += o.items[k] * (p[k] || 0);
      }
    });
  });
  const byRev = Object.entries(agg).sort((a, b) => b[1].rev - a[1].rev).slice(0, 12);
  if (!byRev.length) return '';
  const max = byRev[0][1].rev;
  const rows = byRev.map(([nm, d], i) => `<tr><td class="num muted">${i + 1}</td><td>${esc(nm)}</td><td class="num">${fmt(d.qty)}</td><td class="num">${baht(d.rev)}</td><td class="barcell"><span class="bar" style="width:${Math.round((d.rev / max) * 100)}%"></span></td></tr>`).join('');
  return `<section class="block"><h3>🥇 เมนูขายดีสะสม (Top 12 ตามรายได้)</h3>
    <div class="table-scroll"><table class="tbl"><thead><tr><th class="num">#</th><th>เมนู</th><th class="num">จำนวน</th><th class="num">รายได้</th><th>·</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted small">* รวมเมนูชื่อเดียวกันข้ามรอบ</p></section>`;
}

function renderOrderTimes(rounds) {
  const buckets = new Array(24).fill(0); let total = 0;
  rounds.forEach((r) => (r.orders || []).forEach((o) => {
    if (!o.time) return; const d = new Date(o.time); if (isNaN(d)) return;
    buckets[(d.getUTCHours() + 7) % 24]++; total++;   // Thai local = UTC+7
  }));
  if (!total) return '';
  const max = Math.max(...buckets);
  const bars = buckets.map((c, h) => `<div class="hbar" title="${h}:00–${h + 1}:00 — ${c} ออเดอร์"><span class="hbar-fill" style="height:${max ? Math.round((c / max) * 100) : 0}%"></span><span class="hbar-lbl">${h}</span></div>`).join('');
  const peak = buckets.indexOf(max);
  return `<section class="block"><h3>⏰ ช่วงเวลาที่ลูกค้าสั่ง (เวลาไทย)</h3>
    <div class="hbars">${bars}</div>
    <p class="muted small">* อิงเวลาคอมเมนต์ ${fmt(total)} ออเดอร์ · ชั่วโมงที่สั่งมากสุด ≈ <b>${peak}:00–${peak + 1}:00 น.</b></p></section>`;
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

/* ---------- 📉 per-menu performance across rounds ---------- */
// Categorical palette validated against this site's dark surface (#181b22):
// lightness band, chroma floor, CVD ΔE (worst adjacent 8.4), normal-vision ΔE (19.3)
// and 3:1 contrast all pass. Slots are assigned in fixed order and never cycled —
// past 8 series the picker stops rather than inventing a 9th hue.
const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const MENU_MAX = SERIES_COLORS.length;
let MENU_METRIC = 'qty';   // 'qty' | 'rev'
let MENU_VIEW = 'chart';   // 'chart' | 'table'
let MENU_SEL = [];         // selected menu names, in the order they were added
let MENU_SLOT = {};        // name -> colour index; held while selected, so removing one never repaints the rest
let MENU_TIP = [];         // per-round tooltip payload, rebuilt on each chart render

// "อังคารที่ 15 ก.ย. 2569" -> "15 ก.ย."
const shortRound = (r) => String(r.deliveryDateLabel || r.id).replace(/^\S*ที่\s*/, '').replace(/\s*25\d\d$/, '').trim();

// name -> { offered:Set<roundId>, qty:{roundId}, rev:{roundId}, totQty, totRev }
// `offered` is seeded from each round's MENU, so a dish that was on sale but sold
// nothing plots a real 0, while a round that never offered it leaves a gap.
function menuStats(rounds) {
  const S = {};
  const slot = (n) => (S[n] = S[n] || { offered: new Set(), qty: {}, rev: {}, totQty: 0, totRev: 0 });
  rounds.forEach((r) => {
    const p = priceMap(r.menu), nm = nameMap(r.menu);
    (r.menu || []).forEach((m) => slot(m.short || m.name).offered.add(r.id));
    [...(r.orders || []), ...(r.captionOrders || [])].forEach((o) => {
      for (const k in o.items) {
        const e = slot(nm[k] || k);
        e.offered.add(r.id);
        e.qty[r.id] = (e.qty[r.id] || 0) + o.items[k];
        e.rev[r.id] = (e.rev[r.id] || 0) + o.items[k] * (p[k] || 0);
        e.totQty += o.items[k];
        e.totRev += o.items[k] * (p[k] || 0);
      }
    });
  });
  return S;
}

// Chip pool + default selection come from ALL rounds, so colours and choices
// survive a month filter instead of being reshuffled by it.
function menuPool() {
  const S = menuStats(ROUNDS);
  return Object.entries(S)
    .filter(([, d]) => d.totQty > 0 && d.offered.size >= 2)
    // most-recurring first: this is a trend chart, so the dishes that actually span
    // rounds lead, and the default picks the ones with a line worth reading
    .sort((a, b) => b[1].offered.size - a[1].offered.size || b[1].totRev - a[1].totRev)
    .map(([nm, d]) => ({ nm, rounds: d.offered.size, totQty: d.totQty, totRev: d.totRev }));
}

function pickSlot(name) {
  if (MENU_SLOT[name] != null) return MENU_SLOT[name];
  const used = new Set(Object.values(MENU_SLOT));
  for (let i = 0; i < MENU_MAX; i++) if (!used.has(i)) return (MENU_SLOT[name] = i);
  return -1;
}

// Round the axis up to a whole number of nice ticks — picking the step (not the max)
// keeps the plot from wasting half its height when one round spikes.
function niceMax(peak, ticks) {
  if (!(peak > 0)) return ticks;
  const p = Math.pow(10, Math.floor(Math.log10(peak / ticks)));
  const raw = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((c) => c * ticks >= peak) || 10 * p;
  const step = Math.max(1, Math.ceil(raw - 1e-9));   // whole-number ticks: both counts and baht are integers
  return step * ticks;
}

function menuChartSVG(rounds, S) {
  const n = rounds.length;
  const series = MENU_SEL.filter((nm) => S[nm]).map((nm) => ({ nm, color: SERIES_COLORS[MENU_SLOT[nm]], d: S[nm] }));
  if (!n || !series.length) return `<p class="empty small">เลือกเมนูอย่างน้อย 1 อย่างเพื่อดูกราฟ</p>`;

  const val = (d, id) => (MENU_METRIC === 'qty' ? d.qty[id] : d.rev[id]) || 0;
  let peak = 0;
  series.forEach((s) => rounds.forEach((r) => { if (s.d.offered.has(r.id)) peak = Math.max(peak, val(s.d, r.id)); }));
  const TICKS = 5;
  const yMax = niceMax(peak, TICKS);

  // The y-axis lives in its own fixed SVG beside the scroller, so the scale stays
  // on screen while the rounds scroll — losing it was the first thing that broke.
  const axisW = MENU_METRIC === 'rev' ? 62 : 44, padR = 16, padT = 14, plotH = 240, padB = 44;
  const colW = Math.max(46, Math.min(96, Math.floor(860 / Math.max(1, n))));
  const W = n * colW + padR, H = padT + plotH + padB;
  const x = (i) => colW / 2 + i * colW;
  const y = (v) => padT + plotH - (v / yMax) * plotH;

  // recessive solid hairline grid + y ticks
  let grid = '', axis = '';
  for (let t = 0; t <= TICKS; t++) {
    const v = (yMax / TICKS) * t, yy = y(v);
    grid += `<line class="mt-grid" x1="0" y1="${yy}" x2="${W - padR}" y2="${yy}"></line>`;
    axis += `<text class="mt-ytick" x="${axisW - 8}" y="${yy + 4}" text-anchor="end">${fmt(Math.round(v))}</text>`;
  }
  axis += `<line class="mt-grid" x1="${axisW - 0.5}" y1="${padT}" x2="${axisW - 0.5}" y2="${padT + plotH}"></line>`;

  // x labels thin out as rounds pile up; first and last are always kept
  const every = n <= 16 ? 1 : n <= 30 ? 2 : 3;
  const xlab = rounds.map((r, i) =>
    (i % every === 0 || i === n - 1)
      ? `<text class="mt-xtick" x="${x(i)}" y="${padT + plotH + 18}" text-anchor="middle">${esc(shortRound(r))}</text>`
      : '').join('');

  // A line only spans rounds where the dish was actually on the menu — gaps stay gaps.
  let paths = '', dots = '', labels = '';
  series.forEach((s) => {
    const segs = []; let cur = [];
    rounds.forEach((r, i) => {
      if (!s.d.offered.has(r.id)) { if (cur.length) segs.push(cur); cur = []; return; }
      cur.push([x(i), y(val(s.d, r.id))]);
    });
    if (cur.length) segs.push(cur);
    segs.forEach((sg) => {
      if (sg.length > 1) paths += `<polyline class="mt-line" points="${sg.map((p) => p.join(',')).join(' ')}" stroke="${s.color}"></polyline>`;
      sg.forEach((p) => { dots += `<circle class="mt-dot" cx="${p[0]}" cy="${p[1]}" r="4" fill="${s.color}"></circle>`; });
    });
    // ≤4 series also get a direct label at their last point; more than that, the legend carries identity
    if (series.length <= 4 && segs.length) {
      const last = segs[segs.length - 1][segs[segs.length - 1].length - 1];
      if (last[0] < W - padR - 60) labels += `<text class="mt-dlabel" x="${last[0] + 9}" y="${last[1] + 4}">${esc(s.nm)}</text>`;
    }
  });

  // hover bands + crosshair; the band is the hit target, far bigger than the dot
  const bands = rounds.map((_, i) => `<rect class="mt-band" data-i="${i}" x="${i * colW}" y="${padT}" width="${colW}" height="${plotH}"></rect>`).join('');

  MENU_TIP = rounds.map((r) => ({
    full: String(r.deliveryDateLabel || r.id),
    rows: series.filter((s) => s.d.offered.has(r.id))
      .map((s) => ({ nm: s.nm, color: s.color, v: val(s.d, r.id) }))
      .sort((a, b) => b.v - a.v),
  }));

  return `<div class="mt-wrap">
    <svg class="mt-axis" width="${axisW}" height="${H}" aria-hidden="true">${axis}</svg>
    <div class="table-scroll mt-scroll">
      <svg class="mt-svg" width="${W}" height="${H}" role="img"
           aria-label="กราฟยอด${MENU_METRIC === 'rev' ? 'รายได้' : 'จำนวน'}ของแต่ละเมนูในแต่ละรอบ">
        ${grid}
        <line class="mt-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" style="display:none"></line>
        ${paths}${dots}${labels}${xlab}${bands}
      </svg>
      <div class="mt-tip" style="display:none"></div>
    </div>
  </div>`;
}

function menuTableHTML(rounds, S) {
  const series = MENU_SEL.filter((nm) => S[nm]);
  if (!rounds.length || !series.length) return `<p class="empty small">เลือกเมนูอย่างน้อย 1 อย่างเพื่อดูตาราง</p>`;
  const val = (d, id) => (MENU_METRIC === 'qty' ? d.qty[id] : d.rev[id]) || 0;
  const head = rounds.map((r) => `<th class="num" title="${esc(String(r.deliveryDateLabel || r.id))}">${esc(shortRound(r))}</th>`).join('');
  const body = series.map((nm) => {
    const d = S[nm];
    const cells = rounds.map((r) => {
      if (!d.offered.has(r.id)) return `<td class="num"><span class="dot">·</span></td>`;
      const v = val(d, r.id);
      return `<td class="num">${MENU_METRIC === 'rev' ? baht(v) : fmt(v)}</td>`;
    }).join('');
    const tot = rounds.reduce((a, r) => a + val(d, r.id), 0);
    return `<tr><td><span class="mt-swatch" style="background:${SERIES_COLORS[MENU_SLOT[nm]]}"></span>${esc(nm)}</td>${cells}<td class="num total">${MENU_METRIC === 'rev' ? baht(tot) : fmt(tot)}</td></tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="tbl"><thead><tr><th>เมนู</th>${head}<th class="num">รวม</th></tr></thead><tbody>${body}</tbody></table></div>
    <p class="muted small">* "·" = รอบนั้นไม่มีเมนูนี้ขาย (ต่างจาก 0 ที่แปลว่ามีขายแต่ไม่มีใครสั่ง)</p>`;
}

function renderMenuBody(rounds) {
  const S = menuStats(rounds);
  return MENU_VIEW === 'chart' ? menuChartSVG(rounds, S) : menuTableHTML(rounds, S);
}

function renderMenuTrend(rounds) {
  const pool = menuPool();
  if (!pool.length) return '';
  const chips = pool.map((p) => {
    const on = MENU_SEL.includes(p.nm);
    const sw = on ? `<span class="mt-swatch" style="background:${SERIES_COLORS[MENU_SLOT[p.nm]]}"></span>` : '';
    return `<button class="mt-chip${on ? ' on' : ''}" data-nm="${esc(p.nm)}" title="ขายใน ${p.rounds} รอบ · รวม ${fmt(p.totQty)} รายการ · ${baht(p.totRev)}">${sw}${esc(p.nm)}<span class="mt-chip-n">${p.rounds}</span></button>`;
  }).join('');
  return `<section class="block" id="menuTrend">
    <h3>📉 เทรนด์รายเมนูข้ามรอบ</h3>
    <div class="mt-controls">
      <div class="mt-seg" role="group" aria-label="หน่วยที่แสดง">
        <button class="mt-segbtn${MENU_METRIC === 'qty' ? ' on' : ''}" data-metric="qty">จำนวน</button>
        <button class="mt-segbtn${MENU_METRIC === 'rev' ? ' on' : ''}" data-metric="rev">รายได้</button>
      </div>
      <div class="mt-seg" role="group" aria-label="รูปแบบการแสดงผล">
        <button class="mt-segbtn${MENU_VIEW === 'chart' ? ' on' : ''}" data-view="chart">กราฟ</button>
        <button class="mt-segbtn${MENU_VIEW === 'table' ? ' on' : ''}" data-view="table">ตาราง</button>
      </div>
      <span class="mt-count muted small">เลือกได้สูงสุด ${MENU_MAX} เมนู · ตอนนี้ <b id="mtCount">${MENU_SEL.length}</b></span>
    </div>
    <div class="mt-chips">${chips}</div>
    <div id="menuTrendBody">${renderMenuBody(rounds)}</div>
    <p class="muted small">* เลือกเมนูจากปุ่มด้านบน (ตัวเลขท้ายปุ่ม = จำนวนรอบที่เมนูนั้นเคยขาย) · แสดงเฉพาะเมนูที่ขายมาแล้วอย่างน้อย 2 รอบ · เส้นจะขาดช่วงในรอบที่ไม่มีเมนูนั้นขาย</p>
  </section>`;
}

function bindMenuTrend(rounds) {
  const sec = document.getElementById('menuTrend');
  if (!sec) return;
  const redraw = () => {
    document.getElementById('menuTrendBody').innerHTML = renderMenuBody(rounds);
    bindMenuHover();
  };
  sec.querySelectorAll('.mt-segbtn').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.metric) { MENU_METRIC = b.dataset.metric; sec.querySelectorAll('[data-metric]').forEach((x) => x.classList.toggle('on', x === b)); }
    else { MENU_VIEW = b.dataset.view; sec.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x === b)); }
    redraw();
  }));
  sec.querySelectorAll('.mt-chip').forEach((b) => b.addEventListener('click', () => {
    const nm = b.dataset.nm, i = MENU_SEL.indexOf(nm);
    if (i >= 0) { MENU_SEL.splice(i, 1); delete MENU_SLOT[nm]; }
    else if (MENU_SEL.length >= MENU_MAX) { b.classList.add('shake'); setTimeout(() => b.classList.remove('shake'), 400); return; }
    else { MENU_SEL.push(nm); pickSlot(nm); }
    const on = MENU_SEL.includes(nm);
    b.classList.toggle('on', on);
    b.innerHTML = (on ? `<span class="mt-swatch" style="background:${SERIES_COLORS[MENU_SLOT[nm]]}"></span>` : '') + esc(nm) + b.querySelector('.mt-chip-n').outerHTML;
    document.getElementById('mtCount').textContent = MENU_SEL.length;
    redraw();
  }));
  bindMenuHover();
}

function bindMenuHover() {
  const wrap = document.querySelector('#menuTrend .mt-wrap');
  if (!wrap) return;
  const scroll = wrap.querySelector('.mt-scroll');
  if (scroll) scroll.scrollLeft = scroll.scrollWidth;   // open on the most recent rounds
  const tip = wrap.querySelector('.mt-tip'), cross = wrap.querySelector('.mt-cross');
  const hide = () => { tip.style.display = 'none'; cross.style.display = 'none'; };
  wrap.querySelectorAll('.mt-band').forEach((band) => {
    const show = () => {
      const i = +band.dataset.i, t = MENU_TIP[i];
      if (!t) return;
      const cx = +band.getAttribute('x') + +band.getAttribute('width') / 2;
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.display = '';
      tip.innerHTML = `<div class="mt-tip-head">${esc(t.full)}</div>`
        + (t.rows.length ? t.rows.map((r) => `<div class="mt-tip-row"><span class="mt-swatch" style="background:${r.color}"></span><span class="mt-tip-nm">${esc(r.nm)}</span><span class="mt-tip-v">${MENU_METRIC === 'rev' ? baht(r.v) : fmt(r.v)}</span></div>`).join('')
          : `<div class="mt-tip-row muted">ไม่มีเมนูที่เลือกในรอบนี้</div>`);
      tip.style.display = '';
      tip.style.left = cx + 'px';
    };
    band.addEventListener('mouseenter', show);
    band.addEventListener('mousemove', show);
    band.addEventListener('click', show);
  });
  wrap.addEventListener('mouseleave', hide);
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
    ${renderMenuTrend(rounds)}
    ${renderTopItems(topItems)}
    ${renderTopDishes(rounds)}
    ${renderOrderTimes(rounds)}
    ${renderCustomers(cust, scopeLabel)}`;

  bindMenuTrend(rounds);

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

  // seed the menu-trend picker: the 5 biggest earners that have run in 2+ rounds
  menuPool().slice(0, 5).forEach((p) => { MENU_SEL.push(p.nm); pickSlot(p.nm); });

  app.innerHTML = `
    <header class="site-header"><div><a class="back" href="index.html">‹ กลับ</a><h1>📊 สถิติ & เทรนด์</h1>
      <p class="muted">${esc(index.site || 'RoodeeLMS')} · ${ROUNDS.length} รอบ · ${monthly.length} เดือน</p></div>
      <button class="lock-btn" id="lockBtn" title="ออกจากระบบ">🔓 ล็อก</button></header>
    <main class="container">
      <div id="monthSummary">${renderMonthSummary(monthly)}</div>
      ${renderNewReturning(monthly)}
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
