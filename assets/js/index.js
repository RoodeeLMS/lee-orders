// Landing page: shows the list of order rounds after unlocking.
import { requireUnlock, lock } from './gate.js';

const STATUS_LABEL = {
  open: { text: 'เปิดรับออเดอร์', cls: 'badge-open' },
  closed: { text: 'ปิดรอบแล้ว', cls: 'badge-closed' },
  delivered: { text: 'จัดส่งแล้ว', cls: 'badge-done' }
};

function card(o) {
  const st = STATUS_LABEL[o.status] || STATUS_LABEL.open;
  return `
    <a class="order-card" href="order.html?id=${encodeURIComponent(o.id)}">
      <div class="order-card-top">
        <span class="badge ${st.cls}">${st.text}</span>
        <span class="order-card-arrow">›</span>
      </div>
      <h2>${o.vendor || o.title || o.id}</h2>
      <p class="order-card-sub">${o.deliveryDateLabel ? '🗓️ ' + o.deliveryDateLabel : ''}</p>
    </a>`;
}

async function main() {
  const index = await requireUnlock();
  const app = document.getElementById('app');
  const orders = (index.orders || []).slice();

  app.innerHTML = `
    <header class="site-header">
      <div>
        <h1>📋 สรุปยอดออเดอร์</h1>
        <p class="muted">${index.site || 'RoodeeLMS'}${index.updated ? ' · อัปเดต ' + index.updated : ''}</p>
      </div>
      <button class="lock-btn" id="lockBtn" title="ออกจากระบบ">🔓 ล็อก</button>
    </header>
    <main class="container">
      <a class="insights-link" href="insights.html">📊 ดูสถิติ & เทรนด์ · ประวัติลูกค้า ›</a>
      ${orders.length
        ? `<div class="order-grid">${orders.map(card).join('')}</div>`
        : `<p class="empty">ยังไม่มีรอบออเดอร์</p>`}
    </main>
    <footer class="site-footer">RoodeeLMS · ข้อมูลถูกเข้ารหัสไว้ในเครื่อง · เปิดดูเฉพาะผู้มีรหัสผ่าน</footer>`;

  document.getElementById('lockBtn').addEventListener('click', lock);
}

main();
