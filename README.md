# 📋 lee-orders — สรุปยอดออเดอร์ (RoodeeLMS)

เว็บไซต์สรุปยอดสั่งอาหาร/ออเดอร์ แบบ **static + data-driven** บน GitHub Pages
ออกแบบให้ **เพิ่มรอบออเดอร์ใหม่ได้ง่าย** (เพิ่มทีละไฟล์) และข้อมูลลูกค้าถูก **เข้ารหัสไว้ทั้งหมด**

🔗 เว็บ: `https://roodeelms.github.io/lee-orders/`

---

## 🔐 โมเดลความปลอดภัย (อ่านก่อน)

- repo นี้ **public** (เพราะ GitHub Pages บนแพลน free ใช้ได้กับ public เท่านั้น)
- ข้อมูลออเดอร์ทุกไฟล์ใน `data/` เป็น **ciphertext** (AES‑256‑GCM, key มาจาก PBKDF2‑SHA256)
- **ตัวรหัสผ่านไม่ได้ถูกเก็บไว้ใน repo** → ต้องพิมพ์รหัสตอนเข้าเว็บเพื่อถอดรหัสดู
- ถ้าไม่มีรหัสผ่าน จะอ่านข้อมูลลูกค้าไม่ได้ แม้จะโคลน repo ไปทั้งก้อน
- ⚠️ ถ้าตั้ง `HARDCODED_PASSWORD` ใน `assets/js/config.js` เป็นค่าใดๆ เว็บจะปลดล็อกอัตโนมัติ **โดยไม่ถาม** = ใครก็อ่านรหัสจากไฟล์นี้ได้ → **ความปลอดภัยเป็นศูนย์** ปล่อยว่างไว้ดีที่สุด
- เปลี่ยนรหัสผ่าน = ต้อง **เข้ารหัสไฟล์ทั้งหมดใหม่** ด้วยรหัสใหม่ (ดูด้านล่าง)

---

## 🗂️ โครงสร้าง

```
lee-orders/
├── index.html                      # หน้าแรก: รายการรอบออเดอร์ทั้งหมด
├── order.html                      # หน้ารายละเอียด: order.html?id=<slug>
├── assets/
│   ├── css/styles.css
│   └── js/
│       ├── config.js               # ตั้งค่า (รหัส hardcode/ไม่ hardcode)
│       ├── crypto.js               # ถอด/เข้ารหัส (WebCrypto)
│       ├── gate.js                 # หน้า login + ปลดล็อก
│       ├── index.js                # render หน้าแรก
│       └── order.js                # render หน้ารายละเอียด + คำนวณยอด
├── data/
│   ├── index.enc.json              # รายการรอบ (เข้ารหัส)
│   └── orders/
│       └── 2569-06-26-kruakhunlee.enc.json   # ข้อมูลรอบ (เข้ารหัส)
├── admin/encrypt.html              # เครื่องมือเข้ารหัส/ถอดรหัส (ในเบราว์เซอร์)
├── tools/encrypt.mjs · decrypt.mjs # เครื่องมือฝั่ง Node (ทางเลือก)
└── .github/workflows/pages.yml     # auto-deploy ขึ้น Pages
```

ยอดเงินทั้งหมด **คำนวณจาก `จำนวน × ราคา` ในหน้าเว็บ** ไม่ต้องกรอกยอดเอง — แก้แค่จำนวนก็พอ

---

## ➕ วิธีเพิ่มรอบออเดอร์ใหม่ (3 ขั้น)

1. **เตรียม JSON** ของรอบใหม่ (ดูโครงจากไฟล์ `data/orders/...` ที่ถอดรหัสแล้ว) เช่น
   ```json
   {
     "id": "2569-07-03-kruakhunlee",
     "vendor": "ครัวคุณหลี",
     "deliveryDateLabel": "ศุกร์ที่ 3 ก.ค. 2569",
     "menu": [ { "code": "แมว", "name": "ข้าวแมว (ปลาทู)", "price": 150 } ],
     "displayColumns": ["แมว"],
     "orders": [ { "user": "someone", "zip": "10110", "items": { "แมว": 2 } } ]
   }
   ```
2. **เข้ารหัส** ด้วยเครื่องมือ `admin/encrypt.html` (เปิดในเบราว์เซอร์ → ใส่รหัส → วาง JSON → ดาวน์โหลด)
   แล้วเซฟเป็น `data/orders/<id>.enc.json`
   - หรือใช้ Node: `LEE_PW='รหัส' node tools/encrypt.mjs new.json data/orders/<id>.enc.json`
3. **อัปเดต index**: ถอดรหัส `data/index.enc.json` (ผ่าน `admin/encrypt.html` แท็บถอดรหัส) → เพิ่ม 1 record ใน `orders[]` → เข้ารหัสกลับทับไฟล์เดิม
   ```json
   { "id": "2569-07-03-kruakhunlee", "vendor": "ครัวคุณหลี",
     "deliveryDateLabel": "ศุกร์ที่ 3 ก.ค. 2569", "status": "open",
     "file": "data/orders/2569-07-03-kruakhunlee.enc.json" }
   ```

จากนั้น `git commit` + `git push` → GitHub Actions deploy ให้อัตโนมัติ ✅

> **อย่า commit ไฟล์ plaintext** — `.gitignore` กันไว้ให้ (`data-src/`, `*.plain.json`) แต่ระวังด้วย

---

## 🔁 เปลี่ยนรหัสผ่าน

1. ถอดรหัสทุกไฟล์ใน `data/` ด้วยรหัสเดิม (`tools/decrypt.mjs`)
2. เข้ารหัสกลับด้วยรหัสใหม่ (`tools/encrypt.mjs` โดยตั้ง `LEE_PW` เป็นรหัสใหม่)
3. commit + push

## สถานะรอบ (`status`)
`open` = เปิดรับ · `closed` = ปิดรอบ · `delivered` = จัดส่งแล้ว

---
สร้างโดยทีม RoodeeLMS
