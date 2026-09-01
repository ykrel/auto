'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { qrContent } = require('./qr');
const ExcelJS = require('exceljs');

const { db, logAction } = require('./db');
const T = require('./time');
const { slugify, cleanName, normalizePhone, validPhone, validShift } = require('./util');
const { checkPassword, setSessionCookie, clearSessionCookie, requireAdmin } = require('./auth');
const service = require('./service');

const router = express.Router();

const baseUrl = () => (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

function allLocations() {
  return db.prepare('SELECT * FROM locations ORDER BY active DESC, name COLLATE NOCASE').all();
}

function allEmployees() {
  return db
    .prepare(
      `SELECT e.*, l.name AS location_name, l.shift_start AS location_shift
       FROM employees e LEFT JOIN locations l ON l.id = e.location_id
       ORDER BY CASE e.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, e.name COLLATE NOCASE`
    )
    .all();
}

function flash(req, res, type, message) {
  res.cookie('pdks_flash', JSON.stringify({ type, message }), { maxAge: 10000, sameSite: 'lax' });
}

router.use((req, res, next) => {
  let msg = null;
  if (req.cookies && req.cookies.pdks_flash) {
    try {
      msg = JSON.parse(req.cookies.pdks_flash);
    } catch {
      msg = null;
    }
    res.clearCookie('pdks_flash');
  }
  res.locals.flash = msg;
  res.locals.T = T;
  res.locals.path = req.path;
  next();
});

// --- Giris ---
router.get('/giris', (req, res) => {
  res.render('admin/login', { title: 'Yonetici Girisi', error: null, next: req.query.next || '/admin' });
});

const loginAttempts = new Map();

router.post('/giris', (req, res) => {
  const ip = req.ip || 'ip';
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((t) => now - t < 60000);
  if (attempts.length >= 5) {
    return res.status(429).render('admin/login', {
      title: 'Yonetici Girisi',
      error: 'Cok fazla deneme. Bir dakika sonra tekrar deneyin.',
      next: '/admin'
    });
  }
  if (!checkPassword(req.body.password)) {
    attempts.push(now);
    loginAttempts.set(ip, attempts);
    return res.status(401).render('admin/login', {
      title: 'Yonetici Girisi',
      error: 'Sifre hatali.',
      next: req.body.next || '/admin'
    });
  }
  loginAttempts.delete(ip);
  setSessionCookie(req, res);
  const target = typeof req.body.next === 'string' && req.body.next.startsWith('/admin') ? req.body.next : '/admin';
  res.redirect(target);
});

router.post('/cikis', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/admin/giris');
});

router.use(requireAdmin);

// --- Bugun ---
router.get('/', (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.gun || '') ? req.query.gun : T.todayBusinessDay();
  const locationId = req.query.lokasyon ? Number(req.query.lokasyon) : null;
  const overview = service.dayOverview(day, locationId);
  res.render('admin/today', {
    title: 'Bugun',
    day,
    locations: allLocations(),
    locationId,
    overview,
    pendingCount: service.pendingRequests().length
  });
});

// --- Personel ---
router.get('/personel', (req, res) => {
  res.render('admin/employees', {
    title: 'Personel',
    employees: allEmployees(),
    locations: allLocations(),
    requests: service.pendingRequests(),
    pendingCount: service.pendingRequests().length
  });
});

router.post('/personel/talep/:id/onayla', (req, res) => {
  const result = service.approveRequest(Number(req.params.id), 'admin');
  flash(req, res, result.ok ? 'ok' : 'err', result.ok ? 'Talep onaylandi.' : result.error);
  res.redirect('/admin/personel');
});

router.post('/personel/talep/:id/reddet', (req, res) => {
  const result = service.rejectRequest(Number(req.params.id), 'admin');
  flash(req, res, result.ok ? 'ok' : 'err', result.ok ? 'Talep reddedildi.' : result.error);
  res.redirect('/admin/personel');
});

router.post('/personel/:id/guncelle', (req, res) => {
  const id = Number(req.params.id);
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (!employee) {
    flash(req, res, 'err', 'Personel bulunamadi.');
    return res.redirect('/admin/personel');
  }
  const name = cleanName(req.body.name) || employee.name;
  const phone = normalizePhone(req.body.phone) || employee.phone;
  const status = ['pending', 'active', 'passive'].includes(req.body.status) ? req.body.status : employee.status;
  const locationId = req.body.location_id ? Number(req.body.location_id) : null;
  const shift = (req.body.shift_start || '').trim() || null;

  if (!validPhone(phone)) {
    flash(req, res, 'err', 'Telefon numarasi gecersiz.');
    return res.redirect('/admin/personel');
  }
  if (!validShift(shift)) {
    flash(req, res, 'err', 'Mesai baslangici SS:DD formatinda olmali.');
    return res.redirect('/admin/personel');
  }
  const clash = db.prepare('SELECT id FROM employees WHERE phone = ? AND id != ?').get(phone, id);
  if (clash) {
    flash(req, res, 'err', 'Bu telefon numarasi baska bir personelde kayitli.');
    return res.redirect('/admin/personel');
  }

  db.prepare('UPDATE employees SET name = ?, phone = ?, status = ?, location_id = ?, shift_start = ? WHERE id = ?')
    .run(name, phone, status, locationId, shift, id);
  if (status === 'passive') {
    db.prepare('UPDATE devices SET active = 0, revoked_at = ? WHERE employee_id = ? AND active = 1')
      .run(new Date().toISOString(), id);
  }
  logAction('admin', 'employee_update', `#${id} ${name} durum=${status}`);
  flash(req, res, 'ok', 'Personel guncellendi.');
  res.redirect('/admin/personel');
});

router.post('/personel/:id/cihaz-iptal', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE devices SET active = 0, revoked_at = ? WHERE employee_id = ? AND active = 1')
    .run(new Date().toISOString(), id);
  logAction('admin', 'device_revoke', `personel #${id}`);
  flash(req, res, 'ok', 'Cihaz kaydi iptal edildi. Personel yeniden kayit olmali.');
  res.redirect('/admin/personel');
});

router.post('/personel/ekle', (req, res) => {
  const name = cleanName(req.body.name);
  const phone = normalizePhone(req.body.phone);
  const locationId = req.body.location_id ? Number(req.body.location_id) : null;
  const shift = (req.body.shift_start || '').trim() || null;
  if (name.length < 3 || !validPhone(phone) || !validShift(shift)) {
    flash(req, res, 'err', 'Ad soyad, telefon veya mesai bilgisi gecersiz.');
    return res.redirect('/admin/personel');
  }
  if (db.prepare('SELECT id FROM employees WHERE phone = ?').get(phone)) {
    flash(req, res, 'err', 'Bu telefon numarasi zaten kayitli.');
    return res.redirect('/admin/personel');
  }
  db.prepare(
    "INSERT INTO employees (name, phone, location_id, status, shift_start, created_at) VALUES (?, ?, ?, 'active', ?, ?)"
  ).run(name, phone, locationId, shift, new Date().toISOString());
  logAction('admin', 'employee_create', `${name} / ${phone}`);
  flash(req, res, 'ok', 'Personel eklendi. Cihaz kaydi icin QR okutmasi gerekir.');
  res.redirect('/admin/personel');
});

// --- Lokasyonlar ---
router.get('/lokasyonlar', (req, res) => {
  res.render('admin/locations', {
    title: 'Lokasyonlar',
    locations: allLocations(),
    baseUrl: baseUrl(),
    pendingCount: service.pendingRequests().length
  });
});

function parseLocationBody(body) {
  const name = cleanName(body.name);
  const slug = slugify(body.slug || body.name);
  const lat = body.lat === '' || body.lat == null ? null : Number(body.lat);
  const lng = body.lng === '' || body.lng == null ? null : Number(body.lng);
  const radius = Number(body.radius_m) > 0 ? Math.round(Number(body.radius_m)) : 150;
  const shift = (body.shift_start || '').trim() || null;
  const active = body.active === 'on' || body.active === '1' ? 1 : 0;
  return { name, slug, lat, lng, radius, shift, active };
}

router.post('/lokasyonlar/ekle', (req, res) => {
  const loc = parseLocationBody(req.body);
  if (!loc.name || !loc.slug) {
    flash(req, res, 'err', 'Ad ve slug zorunlu.');
    return res.redirect('/admin/lokasyonlar');
  }
  if (!validShift(loc.shift)) {
    flash(req, res, 'err', 'Mesai baslangici SS:DD formatinda olmali.');
    return res.redirect('/admin/lokasyonlar');
  }
  if (db.prepare('SELECT id FROM locations WHERE slug = ?').get(loc.slug)) {
    flash(req, res, 'err', 'Bu slug zaten kullaniliyor.');
    return res.redirect('/admin/lokasyonlar');
  }
  db.prepare(
    `INSERT INTO locations (slug, name, lat, lng, radius_m, shift_start, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(loc.slug, loc.name, loc.lat, loc.lng, loc.radius, loc.shift, new Date().toISOString());
  logAction('admin', 'location_create', `${loc.name} (${loc.slug})`);
  flash(req, res, 'ok', 'Lokasyon eklendi.');
  res.redirect('/admin/lokasyonlar');
});

router.post('/lokasyonlar/:id/guncelle', (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
  if (!current) {
    flash(req, res, 'err', 'Lokasyon bulunamadi.');
    return res.redirect('/admin/lokasyonlar');
  }
  const loc = parseLocationBody(req.body);
  if (!loc.name || !loc.slug || !validShift(loc.shift)) {
    flash(req, res, 'err', 'Girilen bilgiler gecersiz.');
    return res.redirect('/admin/lokasyonlar');
  }
  const clash = db.prepare('SELECT id FROM locations WHERE slug = ? AND id != ?').get(loc.slug, id);
  if (clash) {
    flash(req, res, 'err', 'Bu slug baska bir lokasyonda kullaniliyor.');
    return res.redirect('/admin/lokasyonlar');
  }
  db.prepare(
    'UPDATE locations SET name = ?, slug = ?, lat = ?, lng = ?, radius_m = ?, shift_start = ?, active = ? WHERE id = ?'
  ).run(loc.name, loc.slug, loc.lat, loc.lng, loc.radius, loc.shift, loc.active, id);
  logAction('admin', 'location_update', `#${id} ${loc.name}`);
  flash(req, res, 'ok', 'Lokasyon guncellendi.');
  res.redirect('/admin/lokasyonlar');
});

router.get('/lokasyonlar/:id/qr.png', async (req, res) => {
  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(Number(req.params.id));
  if (!loc) return res.status(404).send('Lokasyon bulunamadi');
  // Icerik link degil, imzali lokasyon kodu — yalnizca personel sayfasindaki okuyucu dogrular
  const png = await QRCode.toBuffer(qrContent(loc.slug), { width: 900, margin: 2, errorCorrectionLevel: 'M' });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `attachment; filename="qr-${loc.slug}.png"`);
  res.send(png);
});

router.get('/lokasyonlar/:id/qr-onizleme', async (req, res) => {
  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(Number(req.params.id));
  if (!loc) return res.status(404).send('Lokasyon bulunamadi');
  const url = `${baseUrl()}/c/${loc.slug}`;
  const dataUrl = await QRCode.toDataURL(qrContent(loc.slug), { width: 600, margin: 2 });
  res.render('admin/qr', { title: `QR - ${loc.name}`, loc, url, dataUrl, pendingCount: 0 });
});

// --- Kayitlar ---
router.get('/kayitlar', (req, res) => {
  const today = T.todayBusinessDay();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.baslangic || '') ? req.query.baslangic : T.addDays(today, -6);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.bitis || '') ? req.query.bitis : today;
  const employeeId = req.query.personel ? Number(req.query.personel) : null;
  const range = T.rangeToUtc(from, to);

  let sql = `SELECT c.*, e.name AS employee_name, l.name AS location_name
             FROM checkins c
             JOIN employees e ON e.id = c.employee_id
             LEFT JOIN locations l ON l.id = c.location_id
             WHERE c.ts >= ? AND c.ts < ?`;
  const params = [range.start, range.end];
  if (employeeId) {
    sql += ' AND c.employee_id = ?';
    params.push(employeeId);
  }
  sql += ' ORDER BY c.ts DESC LIMIT 1000';
  const rows = db.prepare(sql).all(...params);

  res.render('admin/records', {
    title: 'Kayitlar',
    rows,
    from,
    to,
    employeeId,
    employees: allEmployees(),
    locations: allLocations(),
    defaultDateTime: T.fmtInputDateTime(new Date()),
    pendingCount: service.pendingRequests().length
  });
});

function parseLocalDateTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  return T.localToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), 0);
}

router.post('/kayitlar/ekle', (req, res) => {
  const employeeId = Number(req.body.employee_id);
  const locationId = req.body.location_id ? Number(req.body.location_id) : null;
  const type = req.body.type === 'out' ? 'out' : 'in';
  const when = parseLocalDateTime(req.body.ts);
  const back = req.get('referer') && req.get('referer').includes('/admin/kayitlar') ? req.get('referer') : '/admin/kayitlar';

  if (!employeeId || !when) {
    flash(req, res, 'err', 'Personel ve tarih-saat zorunlu.');
    return res.redirect(back);
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO checkins (employee_id, location_id, type, ts, business_day, flagged, flag_reason, source, created_at, edited_by, edited_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, 'manual', ?, 'admin', ?)`
  ).run(employeeId, locationId, type, when.toISOString(), T.businessDay(when), now, now);
  logAction('admin', 'checkin_manual_add', `personel #${employeeId} ${type} ${T.fmtDateTime(when)}`);
  flash(req, res, 'ok', 'Kayit eklendi.');
  res.redirect(back);
});

router.post('/kayitlar/:id/guncelle', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM checkins WHERE id = ?').get(id);
  const back = req.get('referer') && req.get('referer').includes('/admin/kayitlar') ? req.get('referer') : '/admin/kayitlar';
  if (!row) {
    flash(req, res, 'err', 'Kayit bulunamadi.');
    return res.redirect(back);
  }
  const when = parseLocalDateTime(req.body.ts);
  const type = req.body.type === 'out' ? 'out' : 'in';
  if (!when) {
    flash(req, res, 'err', 'Tarih-saat gecersiz.');
    return res.redirect(back);
  }
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE checkins SET ts = ?, business_day = ?, type = ?, edited_by = 'admin', edited_at = ? WHERE id = ?"
  ).run(when.toISOString(), T.businessDay(when), type, now, id);
  logAction('admin', 'checkin_edit', `kayit #${id}: ${T.fmtDateTime(new Date(row.ts))} -> ${T.fmtDateTime(when)} (${type})`);
  flash(req, res, 'ok', 'Kayit duzeltildi.');
  res.redirect(back);
});

router.post('/kayitlar/:id/sil', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM checkins WHERE id = ?').get(id);
  const back = req.get('referer') && req.get('referer').includes('/admin/kayitlar') ? req.get('referer') : '/admin/kayitlar';
  if (row) {
    db.prepare('DELETE FROM checkins WHERE id = ?').run(id);
    logAction('admin', 'checkin_delete', `kayit #${id} personel #${row.employee_id} ${row.ts}`);
    flash(req, res, 'ok', 'Kayit silindi.');
  }
  res.redirect(back);
});

// --- Rapor ---
router.get('/rapor', (req, res) => {
  const today = T.todayBusinessDay();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.baslangic || '') ? req.query.baslangic : T.addDays(today, -29);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.bitis || '') ? req.query.bitis : today;
  const rows = service.dailyRows(from, to);
  res.render('admin/report', {
    title: 'Rapor',
    from,
    to,
    rows,
    totals: service.employeeTotals(rows),
    pendingCount: service.pendingRequests().length
  });
});

router.get('/rapor/xlsx', async (req, res) => {
  const today = T.todayBusinessDay();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.baslangic || '') ? req.query.baslangic : T.addDays(today, -29);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.bitis || '') ? req.query.bitis : today;
  const rows = service.dailyRows(from, to);
  const totals = service.employeeTotals(rows);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'PDKS';
  wb.created = new Date();

  const s1 = wb.addWorksheet('Günlük');
  s1.columns = [
    { header: 'Tarih', key: 'day', width: 12 },
    { header: 'Personel', key: 'name', width: 24 },
    { header: 'Lokasyon', key: 'location', width: 16 },
    { header: 'Giriş', key: 'in', width: 10 },
    { header: 'Çıkış', key: 'out', width: 10 },
    { header: 'Çalışma Süresi', key: 'work', width: 15 },
    { header: 'Geç Kalma (dk)', key: 'late', width: 15 },
    { header: 'Not', key: 'note', width: 26 }
  ];
  for (const r of rows) {
    const notes = [];
    if (r.missingOut) notes.push('Çıkış eksik');
    if (r.flagged) notes.push('Konum doğrulanamadı');
    s1.addRow({
      day: T.fmtDateTR(r.day),
      name: r.employeeName,
      location: r.locationName || '',
      in: r.inTime,
      out: r.outTime,
      work: r.workText,
      late: r.lateMinutes || 0,
      note: notes.join(', ')
    });
  }
  s1.getRow(1).font = { bold: true };
  s1.autoFilter = { from: 'A1', to: 'H1' };

  const s2 = wb.addWorksheet('Personel Toplamları');
  s2.columns = [
    { header: 'Personel', key: 'name', width: 24 },
    { header: 'Gün Sayısı', key: 'days', width: 12 },
    { header: 'Toplam Çalışma (saat:dk)', key: 'work', width: 24 },
    { header: 'Toplam Çalışma (dk)', key: 'workmin', width: 20 },
    { header: 'Geç Gelme Sayısı', key: 'latecount', width: 18 },
    { header: 'Toplam Geç Kalma (dk)', key: 'latemin', width: 22 },
    { header: 'Eksik Çıkış Sayısı', key: 'missing', width: 18 }
  ];
  for (const t of totals) {
    s2.addRow({
      name: t.employeeName,
      days: t.days,
      work: T.fmtDuration(t.workMinutes),
      workmin: t.workMinutes,
      latecount: t.lateCount,
      latemin: t.lateMinutes,
      missing: t.missingOutCount
    });
  }
  s2.getRow(1).font = { bold: true };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="pdks-${from}_${to}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// --- Islem gunlugu ---
router.get('/log', (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300').all();
  res.render('admin/log', { title: 'Islem Gunlugu', rows, pendingCount: service.pendingRequests().length });
});

module.exports = router;
