# StockBar Mobile — หน้ามือถือผ่าน LINE (LIFF)

โฟลเดอร์นี้เป็นเว็บ static ล้วน โฮสต์บน GitHub Pages แล้วคุยกับ Apps Script ผ่าน JSONP
ทำแบบนี้เพื่อให้ใช้ **สแกนเนอร์ของ LINE** และ **ล็อกอินอัตโนมัติด้วยบัญชี LINE** ได้
(ซึ่งทำไม่ได้ถ้าเสิร์ฟหน้าเว็บจาก Apps Script โดยตรง เพราะ GAS รันในกรอบ iframe)

---

## ขั้นที่ 1 — Deploy Apps Script ให้เป็น API

1. ใน Apps Script กด **Deploy > New deployment > Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (จำเป็น เพราะหน้ามือถืออยู่คนละโดเมน)
2. คัดลอก URL ที่ลงท้ายด้วย `/exec` เก็บไว้

ทุกครั้งที่แก้ `Code.gs` ต้องกด **Deploy > Manage deployments > แก้ไข > Version: New version**
ไม่งั้น API จะยังเป็นโค้ดเก่า

---

## ขั้นที่ 2 — อัปขึ้น GitHub Pages

```bash
# สร้าง repo ใหม่ชื่ออะไรก็ได้ เช่น stockbar-mobile
git init
git add .
git commit -m "stockbar mobile"
git branch -M main
git remote add origin https://github.com/<ชื่อคุณ>/stockbar-mobile.git
git push -u origin main
```

จากนั้นใน GitHub: **Settings > Pages**
- Source: `Deploy from a branch`
- Branch: `main` / โฟลเดอร์ `/ (root)`

รอสักครู่จะได้ URL: `https://<ชื่อคุณ>.github.io/stockbar-mobile/`

> อัปเฉพาะไฟล์ในโฟลเดอร์ `liff-web` ขึ้น root ของ repo (ให้ `index.html` อยู่ชั้นบนสุด)
> ถ้าอัปทั้งโปรเจกต์ URL จะกลายเป็น `.../stockbar-mobile/liff-web/` ก็ใช้ URL นั้นแทนได้

---

## ขั้นที่ 3 — สร้าง LIFF app

1. เข้า [LINE Developers Console](https://developers.line.biz/console/)
2. สร้าง **Provider** (ถ้ายังไม่มี) แล้วสร้าง Channel แบบ **LINE Login**
3. แท็บ **LIFF** > Add
   - LIFF app name: `StockBar`
   - Size: **Full**
   - Endpoint URL: `https://<ชื่อคุณ>.github.io/stockbar-mobile/`
   - Scopes: ติ๊ก `profile` และ `openid` (openid จำเป็นสำหรับล็อกอินอัตโนมัติ)
4. คัดลอก **LIFF ID** (หน้าตาเช่น `2001234567-AbCdEfGh`)
5. ไปแท็บ **Basic settings** ของ Channel คัดลอก **Channel ID** (ตัวเลขล้วน)

---

## ขั้นที่ 4 — ใส่ค่า 3 จุด

**`config.js`** ในโฟลเดอร์นี้
```js
GAS_URL: 'https://script.google.com/macros/s/XXXX/exec',
LIFF_ID: '2001234567-AbCdEfGh',
```

**`Code.gs`** ในโปรเจกต์ Apps Script
```js
LINE_CHANNEL_ID: '2001234567',
```

commit + push `config.js` แล้ว deploy Apps Script ใหม่อีกครั้ง

---

## ขั้นที่ 5 — เอาไปใช้ใน LINE

LIFF URL ของคุณคือ `https://liff.line.me/<LIFF_ID>`

- ใส่ใน **Rich Menu** ของ LINE OA (แนะนำ)
- หรือส่งเป็นลิงก์ในแชท
- หรือทำ QR ให้พนักงานสแกนเปิดครั้งแรก

### การผูกบัญชีพนักงาน (ทำครั้งเดียวต่อคน)
1. พนักงานเปิด LIFF ครั้งแรก ระบบจะบอกว่ายังไม่ได้ผูกบัญชี
2. ให้ล็อกอินด้วย **ชื่อผู้ใช้/รหัสผ่าน** ของ StockBar
3. ระบบผูก LINE userId เข้ากับบัญชีนั้นอัตโนมัติ
4. ครั้งต่อไปเปิดจาก LINE จะเข้าระบบทันที ไม่ต้องพิมพ์รหัสผ่านอีก

ผู้ดูแลยกเลิกการผูกได้ที่หน้าเว็บหลัก เมนู **เชื่อม LINE / มือถือ**

---

## ทำอะไรได้บ้างบนมือถือ

| หน้า | ความสามารถ |
|---|---|
| หน้าแรก | มูลค่าสต๊อก · จำนวนใกล้หมด · ล็อตใกล้หมดอายุ · PO ค้างรับ |
| เช็คของ | สแกนบาร์โค้ดหรือซีเรียล ดูยอดทุกคลัง ราคา ล็อต ประวัติล่าสุด |
| รับ-จ่าย | รับเข้า / เบิกออก / ตรวจนับ พร้อมระบุล็อตและยิงซีเรียลรายชิ้น |
| ใบสั่งซื้อ | ดึงรายการค้างรับจาก PO มาลงตะกร้ารับเข้าในคลิกเดียว |
| ใกล้หมดอายุ | ล็อตที่หมดอายุแล้วและที่ใกล้หมดอายุ พร้อมมูลค่าเสี่ยง |
| บัญชี | เปลี่ยนคลังที่ใช้ · ซิงก์ข้อมูล · ผูก/ออกจากระบบ |

---

## หมายเหตุทางเทคนิค

- เรียก API ด้วย **JSONP** เป็นหลัก จึงไม่ติดปัญหา CORS ของ Apps Script
- ถ้า URL ยาวเกิน 7,000 ตัวอักษร (เอกสารรายการเยอะมาก) จะสลับไปใช้ **POST แบบ text/plain** อัตโนมัติ
- ฝั่งเซิร์ฟเวอร์มี **whitelist** ชื่อฟังก์ชันที่เรียกผ่าน gateway ได้ (ตัวแปร `API_WHITELIST` ใน `Code.gs`)
  ฟังก์ชันที่ไม่อยู่ในลิสต์เรียกจากภายนอกไม่ได้
- Token เก็บใน `localStorage` อายุ 12 ชั่วโมง หมดอายุแล้วเข้าใหม่อัตโนมัติผ่าน LINE
- ถ้าเปิดนอก LINE (เบราว์เซอร์ธรรมดา) ยังใช้ได้ครบ แค่สแกนด้วยกล้องของเครื่องแทน

## แก้ปัญหาที่พบบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `เชื่อมต่อเซิร์ฟเวอร์ไม่ได้` | GAS_URL ผิด หรือ deployment ไม่ได้ตั้ง Who has access = Anyone |
| ล็อกอิน LINE แล้วขึ้น "ยังไม่ได้ผูกบัญชี" | ปกติ ให้ล็อกอินด้วยรหัสผ่านครั้งแรกครั้งเดียว |
| `ยังไม่ได้ตั้งค่า LINE_CHANNEL_ID` | ยังไม่ได้ใส่ Channel ID ใน Code.gs หรือลืม deploy ใหม่ |
| แก้โค้ดแล้วไม่มีอะไรเปลี่ยน | ลืมกด Deploy เวอร์ชันใหม่ / GitHub Pages ยัง cache อยู่ ให้รอ 1-2 นาทีแล้ว hard refresh |
| สแกนเนอร์ไม่ขึ้นใน LINE | LIFF Size ต้องเป็น Full และเปิดผ่าน `liff.line.me` ไม่ใช่ URL ของ Pages ตรงๆ |
