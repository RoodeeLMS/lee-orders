// Password gate. Verifies the password by attempting to decrypt the index file.
// On success the password is kept in sessionStorage (cleared when the tab closes).
import { CONFIG } from './config.js';
import { decryptBlob } from './crypto.js';

let cachedIndex = null;

async function tryPassword(pw) {
  const res = await fetch(CONFIG.INDEX_FILE, { cache: 'no-store' });
  if (!res.ok) throw new Error('โหลดข้อมูลไม่สำเร็จ (' + res.status + ')');
  const blob = await res.text();
  const json = await decryptBlob(blob, pw); // throws if wrong password
  cachedIndex = JSON.parse(json);
  sessionStorage.setItem(CONFIG.SESSION_KEY, pw);
  return cachedIndex;
}

function getPassword() {
  return sessionStorage.getItem(CONFIG.SESSION_KEY) || CONFIG.HARDCODED_PASSWORD || '';
}

function lock() {
  sessionStorage.removeItem(CONFIG.SESSION_KEY);
  location.reload();
}

// Mounts a gate overlay. Resolves with the decrypted index once unlocked.
function requireUnlock() {
  return new Promise((resolve) => {
    const existing = getPassword();

    const overlay = document.createElement('div');
    overlay.className = 'gate';
    overlay.innerHTML = `
      <form class="gate-card" autocomplete="off">
        <div class="gate-logo">🔒</div>
        <h1>RoodeeLMS · สรุปออเดอร์</h1>
        <p class="gate-sub">กรอกรหัสผ่านเพื่อเข้าดูข้อมูล</p>
        <input type="password" class="gate-input" placeholder="รหัสผ่าน" autofocus />
        <button type="submit" class="gate-btn">เข้าสู่ระบบ</button>
        <p class="gate-err" hidden></p>
      </form>`;
    document.body.appendChild(overlay);

    const form = overlay.querySelector('form');
    const input = overlay.querySelector('.gate-input');
    const btn = overlay.querySelector('.gate-btn');
    const err = overlay.querySelector('.gate-err');

    async function attempt(pw) {
      err.hidden = true;
      btn.disabled = true;
      btn.textContent = 'กำลังตรวจสอบ…';
      try {
        const index = await tryPassword(pw);
        overlay.classList.add('gate-open');
        setTimeout(() => overlay.remove(), 250);
        resolve(index);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'เข้าสู่ระบบ';
        err.hidden = false;
        err.textContent = (e && e.name === 'OperationError')
          ? 'รหัสผ่านไม่ถูกต้อง'
          : (e.message || 'เกิดข้อผิดพลาด');
        input.select();
      }
    }

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const pw = input.value.trim();
      if (pw) attempt(pw);
    });

    // Auto-unlock if a valid password already exists this session (or hardcoded).
    if (existing) attempt(existing);
  });
}

export { requireUnlock, getPassword, lock, decryptBlob };
