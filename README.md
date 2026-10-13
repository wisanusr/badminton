# แทนที่จะตีแบด 🏸

ระบบลงชื่อก๊วนแบดมินตัน: ผู้เล่นลงชื่อ/ยกเลิกผ่าน LINE (LIFF) แอดมินจัดการรอบ รายชื่อ และค่าใช้จ่าย
ข้อมูลทั้งหมดเก็บใน Google Sheets ไม่มีเซิร์ฟเวอร์ของตัวเอง

```
LINE (LIFF)  ──►  index.html (GitHub Pages)  ──fetch POST──►  Apps Script Web App  ──►  Google Sheets
                                                                   └──► LINE Messaging API (แจ้งแอดมิน)
```

| ส่วน | ไฟล์ | ทำอะไร |
|---|---|---|
| หน้าเว็บ | [`index.html`](index.html) | React (โหลดจาก CDN) + Tailwind ไฟล์เดียว ไม่ต้อง build |
| Backend | [`backend/`](backend) | Apps Script แยกตามหมวด (ดูตารางด้านล่าง) |
| ทดสอบ | [`tests/`](tests) | ทดสอบ backend ด้วย mock ของชีท (ไม่ต้องใช้บัญชี Google) |

### ไฟล์ใน `backend/`

Apps Script รวมทุกไฟล์ `.gs` ไว้ใน global เดียวกัน ไฟล์ที่แยกไว้เพื่อให้หาโค้ดง่ายเท่านั้น ไม่ต้อง import

| ไฟล์ | หน้าที่ |
|---|---|
| `Main.gs` | `doGet`/`doPost`, `handleRequest` (router), `dispatchWrite` |
| `Auth.gs` | ตรวจ LINE ID token, เช็คสิทธิ์แอดมิน/ผู้ใช้ |
| `Users.gs` | ผู้ใช้: หาจาก LINE uid, สร้าง/ผูกโปรไฟล์, `getMe` |
| `Rules.gs` | กติกา (Settings + ช่วงค่าที่ยอมรับ), ช่วงชั่วโมง, ฟังก์ชันวันที่ |
| `Registrations.gs` | ลงชื่อ / ยกเลิก |
| `Admin.gs` | จัดการรอบ, เช็คลิสต์, แก้รายชื่อ, ตั้งค่า, สมาชิก |
| `Notify.gs` | ส่งข้อความ LINE, ข้อความโพสต์กลุ่ม, เช็คจำนวนคนรอบวันหยุด, ตัวจัดการ trigger |
| `Sheets.gs` | อ่าน/เขียนชีท, `getAllData` (มี cache) |
| `Setup.gs` | ติดตั้งครั้งแรก: สร้างชีท/คอลัมน์/ค่าตั้งต้น, `setupTriggers` |
| `appsscript.json` | manifest (เขตเวลา Asia/Bangkok, V8, Web app: Execute as Me / Anyone) |

## กติกาของก๊วน (ค่าจริงอ่านจากชีท Settings)

- **วันธรรมดา** 18:00–20:00 รับสูงสุด 8 คนต่อชั่วโมง ลงชื่อ/ยกเลิกได้จนถึงวันเล่น
- **วันหยุด** 16:00–18:00 ปิดรับลงชื่อก่อนวันเล่น 2 วัน ถ้าไม่ถึง 6 คน ระบบงดรอบอัตโนมัติและแจ้งทาง LINE
- **ค่าใช้จ่าย** (ค่าคอร์ด + ลูกแบด) หารตามจำนวนคน แต่ไม่เกิน 6 คน

## ติดตั้งครั้งแรก

1. สร้าง Google Sheet ใหม่ → Extensions → Apps Script แล้วนำโค้ดจาก `backend/` เข้าไป (วิธีดูหัวข้อ "นำโค้ดเข้า Apps Script" ด้านล่าง)
2. รัน `initialSetup` หนึ่งครั้งจาก editor (สร้างชีท `Settings`, `Users`, `Sessions`, `Registrations` และคีย์ตั้งต้น รันซ้ำได้ ไม่ทับข้อมูล)
3. ในชีท **Settings** ใส่ค่า:
   - `LINE_CHANNEL_ID` — Channel ID ของ LINE Login channel (ใช้ตรวจ ID token)
   - `ADMIN_LINE_IDS` — LINE userId ของแอดมิน คั่นด้วย `,`
4. Project Settings → **Script Properties** เพิ่ม `LINE_MESSAGING_TOKEN` (Channel access token ของ Messaging API) ใช้ส่งข้อความหาแอดมิน/ผู้เล่น
   อย่าใส่ token ในโค้ดหรือในชีท
5. รัน `setupTriggers` หนึ่งครั้ง (ตั้งเวลา 08:00 เช็คจำนวนคนรอบวันหยุด, 10:00 ส่งข้อความโพสต์วันเล่น, 12:00 แจ้งจองคอร์ด)
6. Deploy → New deployment → **Web app**: Execute as *Me*, Who has access *Anyone* แล้วคัดลอก URL ที่ลงท้าย `/exec`
7. ใน `index.html` แก้ค่าด้านบน: `GAS_URL` (URL ข้อ 6), `LIFF_ID`, `POINT_URL`
   และใน `backend/Notify.gs` แก้ `LIFF_URL` ให้ตรงกับ LIFF ID
8. LINE Developers: ตั้ง **Endpoint URL** ของ LIFF app เป็น URL ของหน้าเว็บ (เช่น `https://<user>.github.io/badminton/`)
9. ทดสอบจาก editor: `testNotify`, `testDailyNotify` (ส่งข้อความทดสอบถึงแอดมิน)

ฟังก์ชันที่รันมือจาก editor ได้: `initialSetup`, `setupTriggers`, `migrateChecklist` (ย้ายเช็คลิสต์รอบเก่า), `testNotify`, `testDailyNotify`
และ
- `dedupeSettings` — ถ้าชีท Settings มี Key ซ้ำ (เคยเกิดเมื่อหลายคำขอตั้งค่าพร้อมกันตอน cache ว่าง) จะเก็บแถวแรกของแต่ละ Key แล้วลบแถวที่ซ้ำ ใน log จะเตือนถ้าค่าที่ลบต่างจากที่เก็บไว้
- `clearDataCache` — ล้าง cache ของ `getAllData` หลังแก้ชีทด้วยมือ (ถ้าไม่ล้าง จะเห็นผลในแอปภายใน 5 นาที)

## นำโค้ดเข้า Apps Script

**วิธี A: clasp (แนะนำ)** ใช้คำสั่งเดียว push ทุกไฟล์ ไม่ต้องคัดลอกทีละไฟล์

```bash
npm install -g @google/clasp      # ต้องมี Node.js; ทำครั้งเดียว
clasp login                        # ล็อกอินบัญชี Google ที่เป็นเจ้าของสคริปต์
cp .clasp.json.example .clasp.json # แก้ scriptId (Project Settings > IDs ใน editor)
clasp push                         # อัปโหลดโฟลเดอร์ backend/
```

ต้องเปิด Apps Script API ที่ https://script.google.com/home/usersettings ก่อน
`.clasp.json` ไม่ถูก commit (อยู่ใน `.gitignore`)
คำเตือน: `clasp push` เขียนทับ `appsscript.json` ของโปรเจกต์ ตรวจเขตเวลาใน Project Settings ว่าเป็น Asia/Bangkok ก่อน

**วิธี B: ทำเอง** สร้างไฟล์ใน editor ให้ชื่อตรงกับ `backend/*.gs` ทีละไฟล์แล้ววางเนื้อหา (ลำดับไม่สำคัญ)

## ลำดับ deploy เมื่อแก้โค้ด (สำคัญ)

หน้าเว็บกับ Apps Script deploy แยกกัน คนละเวลา ต้องทำตามลำดับนี้:

1. **Apps Script ก่อน** — `clasp push` (หรือวางโค้ดใหม่) แล้ว Deploy → Manage deployments → Edit → *New version*
   (ถ้ากด Save เฉย ๆ URL `/exec` เดิมยังรันโค้ดเก่า)
2. **จากนั้นค่อย merge หน้าเว็บเข้า `main`** (Pages อัปเดตเองใน 1–2 นาที)

Backend ควรรองรับหน้าเว็บทั้งเวอร์ชันเก่าและใหม่ในช่วงเปลี่ยนผ่าน (ตัวอย่าง: `adminUpdateRegistrations` ยังรับรูปแบบเก่า `registrations`)

## ชีทและคีย์ใน Settings

| Key | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `LINE_CHANNEL_ID` | – | Channel ID ตรวจ ID token |
| `ADMIN_LINE_IDS` | – | LINE userId ของแอดมิน (คั่น `,`) |
| `WORKDAY_HOUR_CAP` | 8 | วันธรรมดา: รับสูงสุดต่อชั่วโมง |
| `WORKDAY_MIN_PLAYERS` | 6 | วันธรรมดา: เป้าหมายขั้นต่ำ (แสดงผลเท่านั้น ไม่งดรอบ) |
| `WEEKEND_CLOSE_DAYS` | 2 | วันหยุด: ปิดรับก่อนวันเล่นกี่วัน |
| `WEEKEND_MIN_PLAYERS` | 6 | วันหยุด: ขั้นต่ำถึงจะเล่น ไม่ครบ = งดรอบอัตโนมัติ |
| `COST_SPLIT_BASE` | 6 | หารค่าใช้จ่ายสูงสุดกี่คน |
| `SHUTTLES_PER_SESSION` | 2 | ลูกแบดที่รวมในราคาต่อรอบ |
| `SHUTTLECOCK_PRICE` | 65 | ราคาลูกแบดต่อลูก (บาท) |
| `NOTIFY_CANCEL` | TRUE | แจ้งแอดมินเมื่อมีคนยกเลิก |
| `NOTIFY_PLAY_DAY` | TRUE | ส่งข้อความโพสต์กลุ่มให้แอดมินตอน 10:00 วันเล่น |
| `BOOK_NOTICE_DAYS` | 2 | รอบวันหยุด: แจ้งแอดมินจำนวนคนก่อนวันเล่นกี่วัน (จองคอร์ด) |
| `LINE_POST_TEMPLATE` | – | แม่แบบข้อความโพสต์กลุ่ม (แก้ได้จากหน้า "จัดการข้อมูล") |

หน้าเว็บไม่คำนวณกติกาเอง แต่ใช้ `rules` ที่ server ส่งมากับ `getAllData` (ตัวเดียวกับที่ server ตัดสิน) และ `limits` สำหรับช่องกรอก
ตัวเลขมีช่วงที่ยอมรับ (ดู `SETTING_LIMITS` ใน `backend/Rules.gs`) ค่านอกช่วงจะถูกปฏิเสธตอนบันทึก และใช้ค่าเริ่มต้นแทนถ้ามีคนแก้ชีทด้วยมือ

## ความปลอดภัย

- ตัวตนผู้ใช้มาจาก **LINE ID token** ที่ตรวจกับ LINE ทุกครั้ง (cache ได้ไม่เกิน 10 นาที) ไม่เชื่อ user id ที่หน้าเว็บส่งมา
- action ของแอดมินตรวจจาก `ADMIN_LINE_IDS` ฝั่ง server
- `getAllData` เปิดให้อ่านโดยไม่ต้อง login (ใช้กับหน้า public) ข้อมูลที่ส่งออกคือรอบ รายชื่อ และชื่อผู้เล่น ไม่รวม LINE userId และไม่ส่ง `LINE_CHANNEL_ID`, `ADMIN_LINE_IDS` กับคีย์เก่าที่เลิกใช้แล้ว (`PRICE_*`, `MAX_WORKDAY_*`)
- `getAllData` ถูก cache 5 นาที และล้างทุกครั้งที่เขียนผ่าน API หรือ trigger
- `getAllData` ส่งเฉพาะรอบข้างหน้า, รอบที่ผ่านไปไม่เกิน 30 วัน (`RECENT_DAYS` ใน `backend/Sheets.gs`) และรอบเก่ากว่านั้นที่ยังค้างเช็คลิสต์ ประวัติทั้งหมดแอดมินดึงผ่าน `adminGetHistory` ตอนเปิดหน้า "จัดการข้อมูล" (ไม่ผ่าน cache) ถ้าเพิ่มคอลัมน์เช็คลิสต์ใหม่ ต้องแก้ `CHECKLIST_TASKS` ให้ตรงกับ `TASKS` ใน `index.html`
- ห้าม commit token/ความลับลง repo (ใช้ Script Properties)

## ทดสอบ

```bash
node tests/run.js
```

ใช้ Node 18+ ไม่ต้องติดตั้งแพ็กเกจเพิ่ม ทดสอบโหลดไฟล์ใน `backend/` ใน `vm` (ทั้งลำดับปกติและกลับด้าน เพื่อยืนยันว่าลำดับโหลดไม่มีผล) ร่วมกับ mock ของ Sheets/Cache/Lock ครอบคลุมการลงชื่อ/ยกเลิก, การตรวจ token, แคช `getAllData`, การแก้รายชื่อของแอดมิน และการตรวจค่า Settings
ไม่ได้ทดสอบการเขียนชีทจริงและ trigger — ต้องลองในระบบจริงหลัง deploy

## GitHub Pages

ปัจจุบัน Pages เสิร์ฟทั้ง repo จาก branch `main` (ทำให้โค้ด backend เปิดอ่านได้ที่ `/backend/*.gs` ด้วย)
ถ้าอยากเผยแพร่เฉพาะ `index.html`: ตั้ง repository variable `PAGES_VIA_ACTIONS` = `true` แล้วเปลี่ยน Settings → Pages → Source เป็น **GitHub Actions**
(workflow [`pages.yml`](.github/workflows/pages.yml) จะ deploy เฉพาะ `index.html`)
