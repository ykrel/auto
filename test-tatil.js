// Tatil ozelligi duman testi. Kullanim: node test-tatil.js <repo-dizini>
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const REPO = path.resolve(process.argv[2]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdks-tatil-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_PASSWORD = 'test-sifre';
process.env.SESSION_SECRET = 'test-secret';
process.env.PORT = '0';
delete process.env.TELEGRAM_BOT_TOKEN;

const RealDate = Date;
function setNow(iso) {
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(iso); }
    static now() { return new RealDate(iso).getTime(); }
  };
}

let fail = 0, pass = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('HATA:', msg); } }

const { db } = require(REPO + '/src/db.js');
const T = require(REPO + '/src/time.js');
const service = require(REPO + '/src/service.js');
const telegram = require(REPO + '/src/telegram.js');

// Lokasyonlar: Merkez (1) gibi ve Uretim gibi (cumartesi kapali, 18:40, aksam 18:50)
const now0 = new RealDate().toISOString();
db.prepare('DELETE FROM locations').run();
db.prepare("INSERT INTO locations (id, name, slug, lat, lng, radius_m, shift_start, active, created_at) VALUES (1,'Merkez','umraniye',41,29,350,'08:30',1,?)").run(now0);
db.prepare("INSERT INTO locations (id, name, slug, lat, lng, radius_m, shift_start, active, created_at, shift_end, saturday, evening_at) VALUES (5,'Üretim','uretim',41,29,350,'08:25',1,?,'18:40',0,'18:50')").run(now0);
const addEmp = (id, name, loc) => db.prepare("INSERT INTO employees (id,name,phone,location_id,status,created_at) VALUES (?,?,?,?,'active',?)").run(id, name, '0555' + id, loc, now0);
addEmp(1, 'Ayse Merkez', 1); addEmp(2, 'Veli Merkez', 1); addEmp(3, 'Ali Uretim', 5); addEmp(4, 'Can Uretim', 5);
const addCk = (emp, loc, type, day, hm) => {
  const [y, m, d] = day.split('-').map(Number); const [h, mi] = hm.split(':').map(Number);
  const ts = T.localToUtc(y, m, d, h, mi, 0).toISOString();
  db.prepare("INSERT INTO checkins (employee_id, location_id, type, ts, business_day, source, created_at) VALUES (?,?,?,?,?,'qr',?)").run(emp, loc, type, ts, day, now0);
};

// 1) Tatil yokken eski davranis
ok(T.worksOn('2026-10-29', { id: 1, saturday: 1 }) === true, 'tatil yokken persembe calisir');
ok(T.shiftEndFor('2026-10-28', { id: 5, shift_end: '18:40' }) === '18:40', 'tatil yokken uretim bitis 18:40');
ok(T.holidayFor('2026-10-29', { id: 1 }) === null, 'tatil yok -> null');

// 2) Tatil ekleme: 29.10 tam gun (tum), 28.10 yarim gun 13:00 (tum)
ok(service.addHoliday({ fromDay: '2026-10-29', toDay: '2026-10-29', note: 'Cumhuriyet Bayramı' }) === 1, 'tam gun eklendi');
ok(service.addHoliday({ fromDay: '2026-10-28', toDay: '2026-10-28', shiftEnd: '13:00', note: 'Arife' }) === 1, 'yarim gun eklendi');
ok(T.worksOn('2026-10-29', { id: 1, saturday: 1 }) === false, '29.10 merkez calismaz');
ok(T.worksOn('2026-10-29', { id: 5, saturday: 0 }) === false, '29.10 uretim calismaz');
ok(T.worksOn('2026-10-29') === false, '29.10 lokasyonsuz calismaz');
ok(T.worksOn('2026-10-28', { id: 5 }) === true, '28.10 yarim gun calisir');
ok(T.shiftEndFor('2026-10-28', { id: 5, shift_end: '18:40' }) === '13:00', '28.10 uretim bitis 13:00');
ok(T.shiftEndFor('2026-10-28', { id: 1 }) === '13:00', '28.10 merkez bitis 13:00');
ok(T.shiftEndFor('2026-10-30', { id: 5, shift_end: '18:40' }) === '18:40', '30.10 normal');
ok(T.worksOn('2026-10-31', { id: 5, saturday: 0 }) === false && T.worksOn('2026-10-31', { id: 1, saturday: 1 }) === true, 'cumartesi kurali korunur');
ok(T.worksOn('2026-11-01', { id: 1 }) === false, 'pazar kapali');

// 3) Lokasyona ozel tatil, genelden once gelir; ayni gun tekrar ekleme degistirir
service.addHoliday({ fromDay: '2026-11-02', toDay: '2026-11-03', locationId: 5, note: 'Üretim bakım' });
ok(T.worksOn('2026-11-02', { id: 5 }) === false && T.worksOn('2026-11-02', { id: 1 }) === true, 'lokasyona ozel tatil yalniz o lokasyon');
service.addHoliday({ fromDay: '2026-11-02', toDay: '2026-11-02', locationId: 5, shiftEnd: '12:00', note: 'yarim' });
ok(T.shiftEndFor('2026-11-02', { id: 5, shift_end: '18:40' }) === '12:00', 'ayni gun tekrar ekleme degistirir');
ok(db.prepare("SELECT COUNT(*) n FROM holidays WHERE day='2026-11-02'").get().n === 1, 'ayni gun tek satir');
service.addHoliday({ fromDay: '2026-11-02', toDay: '2026-11-02', note: 'genel' });
ok(T.shiftEndFor('2026-11-02', { id: 5, shift_end: '18:40' }) === '12:00', 'lokasyona ozel genelden once');
ok(T.worksOn('2026-11-02', { id: 1 }) === false, 'genel tatil merkez icin gecerli');

// 4) Yoklama/gun ozeti: tatilde kimse gelmedi sayilmaz
addCk(3, 5, 'in', '2026-10-29', '09:30'); // tatilde gelen
let ov = service.dayOverview('2026-10-29');
ok(ov.absent.length === 0, '29.10 gelmeyen listesi bos (' + ov.absent.length + ')');
const aliRow = ov.all.find((r) => r.employee.id === 3);
ok(aliRow.lateMinutes == null || aliRow.lateMinutes === 0, 'tatilde gelen gec sayilmaz');
ov = service.dayOverview('2026-10-30');
ok(ov.absent.length === 4, '30.10 normal gun 4 gelmeyen (' + ov.absent.length + ')');
addCk(1, 1, 'in', '2026-10-30', '09:30');
ov = service.dayOverview('2026-10-30');
ok(ov.all.find((r) => r.employee.id === 1).lateMinutes === 60, 'normal gunde gec sayilir');

// 5) Rapor satirlari
addCk(3, 5, 'out', '2026-10-29', '13:30');
addCk(2, 1, 'in', '2026-10-28', '08:20'); addCk(2, 1, 'out', '2026-10-28', '13:00');
const rows = service.dailyRows('2026-10-28', '2026-10-30');
const r29 = rows.find((r) => r.day === '2026-10-29' && r.employeeId === 3);
ok(r29 && r29.offDay && r29.holiday === 'Cumhuriyet Bayramı' && r29.lateMinutes === 0, 'rapor: tatilde calisma notu');
const r28 = rows.find((r) => r.day === '2026-10-28' && r.employeeId === 2);
ok(r28 && !r28.offDay && r28.holiday === 'Arife (yarım gün, 13:00)', 'rapor: arife notu ' + (r28 && r28.holiday));
const r30 = rows.find((r) => r.day === '2026-10-30' && r.employeeId === 1);
ok(r30 && r30.lateMinutes === 60 && !r30.holiday, 'rapor: normal gun gecikme');
const tot = service.employeeTotals(rows);
ok(tot.find((t) => t.employeeId === 3).offDayWork === 1, 'toplam: tatilde calisma 1 gun');
ok(tot.find((t) => t.employeeId === 2).offDayWork === 0, 'toplam: arife tatil sayilmaz');
// izin satiri (kaydi olmayan) tatil gununde de calisir
service.addLeave({ employeeId: 4, fromDay: '2026-10-29', toDay: '2026-10-29', note: 'yillik' });
const lrow = service.dailyRows('2026-10-29', '2026-10-29').find((r) => r.employeeId === 4);
ok(lrow && lrow.leave && lrow.offDay, 'izin satiri tatil bilgisi alir');

// 6) Telegram yoklamalari (token yok, karar audit_log'dan okunur)
const sent = (action, detail) => !!db.prepare('SELECT 1 FROM audit_log WHERE action=? AND detail=?').get(action, detail);
setNow('2026-10-29T05:40:00Z'); // 08:40 TR
telegram.morningTick();
ok(!sent('morning_report', '2026-10-29 #1') && !sent('morning_report', '2026-10-29 #5'), 'tatilde sabah yoklamasi yok');
setNow('2026-10-29T15:55:00Z'); // 18:55 TR
telegram.eveningTick();
ok(!sent('evening_report', '2026-10-29 #1') && !sent('evening_report', '2026-10-29 #5'), 'tatilde aksam yoklamasi yok');
setNow('2026-10-28T05:40:00Z');
telegram.morningTick();
ok(sent('morning_report', '2026-10-28 #1') && sent('morning_report', '2026-10-28 #5'), 'arife sabah yoklamasi gider');
setNow('2026-10-28T10:04:00Z'); // 13:04 TR, henuz erken
telegram.eveningTick();
ok(!sent('evening_report', '2026-10-28 #5'), 'arife 13:04 yoklama yok');
setNow('2026-10-28T10:06:00Z'); // 13:06 TR
telegram.eveningTick();
ok(sent('evening_report', '2026-10-28 #1') && sent('evening_report', '2026-10-28 #5'), 'arife aksam yoklamasi 13:05te');
setNow('2026-10-30T15:46:00Z'); // 18:46 TR
telegram.eveningTick();
ok(sent('evening_report', '2026-10-30 #1') && !sent('evening_report', '2026-10-30 #5'), 'normal gun: merkez 18:35, uretim 18:50 bekler');
setNow('2026-10-30T15:51:00Z');
telegram.eveningTick();
ok(sent('evening_report', '2026-10-30 #5'), 'normal gun uretim 18:50');
global.Date = RealDate;

// 7) Silme
const hid = db.prepare("SELECT id FROM holidays WHERE day='2026-10-29'").get().id;
ok(service.removeHoliday(hid) === true && T.worksOn('2026-10-29', { id: 1 }) === true, 'tatil silinince is gunu');
ok(service.removeHoliday(999999) === false, 'olmayan tatil silinmez');
service.addHoliday({ fromDay: '2026-10-29', toDay: '2026-10-29', note: 'Cumhuriyet Bayramı' });

// 8) HTTP: admin sayfalari
(async () => {
  const { spawn } = require('child_process');
  const port = 39000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [REPO + '/src/server.js'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errOut = '';
  srv.stderr.on('data', (d) => { errOut += d; });
  const B = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/saglik'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const jar = {};
  const req = async (p, opts = {}) => {
    const cookie = Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
    const r = await fetch(B + p, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return r;
  };
  const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
  let r = await req('/admin/giris', form({ password: 'test-sifre' }));
  ok(r.status === 302, 'admin giris');
  r = await req('/admin/tatiller?baslangic=2026-10-01&bitis=2026-11-30');
  let html = await r.text();
  ok(r.status === 200 && html.includes('Cumhuriyet Bayramı') && html.includes('Yarım gün (13:00)') && html.includes('Tatiller'), 'tatiller sayfasi');
  r = await req('/admin/tatiller/ekle', form({ baslangic: '2026-12-31', bitis: '2027-01-01', location_id: '', bitis_saati: '', not: 'Yılbaşı' }));
  ok(r.status === 302, 'tatil ekle http');
  ok(T.worksOn('2027-01-01', { id: 1 }) === false && T.worksOn('2026-12-31', { id: 5 }) === false, 'http ile eklenen tatil gecerli');
  r = await req('/admin/tatiller/ekle', form({ baslangic: '2026-12-10', bitis: '2026-12-01' }));
  ok(r.status === 302 && db.prepare("SELECT COUNT(*) n FROM holidays WHERE day LIKE '2026-12-0%'").get().n === 0, 'ters aralik reddedilir');
  const hid2 = db.prepare("SELECT id FROM holidays WHERE day='2026-12-31'").get().id;
  r = await req(`/admin/tatiller/${hid2}/sil`, { method: 'POST' });
  ok(r.status === 302 && !db.prepare('SELECT 1 FROM holidays WHERE id=?').get(hid2), 'tatil sil http');
  r = await req('/admin/rapor?baslangic=2026-10-28&bitis=2026-10-30');
  html = await r.text();
  ok(r.status === 200 && html.includes('Cumhuriyet Bayramı') && html.includes('Tatilde çalışma'), 'rapor sayfasi tatil notu');
  r = await req('/admin/rapor/xlsx?baslangic=2026-10-28&bitis=2026-10-30');
  const buf = Buffer.from(await r.arrayBuffer());
  ok(r.status === 200 && buf.length > 1000, 'xlsx indirildi');
  const ExcelJS = require(REPO + '/node_modules/exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const s2 = wb.getWorksheet('Personel Toplamları');
  ok(s2.getRow(1).values.includes('Tatilde Çalışılan Gün'), 'xlsx tatil sutunu');
  r = await req('/admin');
  ok(r.status === 200, 'bugun ekrani');
  r = await req('/admin/izinler');
  ok(r.status === 200, 'izinler ekrani');
  srv.kill();
  if (errOut.trim()) console.log('sunucu stderr:', errOut.trim().slice(0, 500));
  console.log(`gecen ${pass}, hatali ${fail}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
