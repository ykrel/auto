'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const { db, logAction } = require('./db');
const T = require('./time');
const {
  normalizePhone,
  validPhone,
  cleanName,
  newToken,
  createRateLimiter,
  cleanBrowserId,
  uaLabel
} = require('./util');
const { TOKEN_COOKIE, setTokenCookie, resolveToken } = require('./auth');
const service = require('./service');
const belge = require('./belge');
const { qrSlug } = require('./qr');
const telegram = require('./telegram');
const adminRouter = require('./admin');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
// Bu saatten (Europe/Istanbul, HH:MM) once yapilan cikislar "erken cikis" sayilir ve onay kutusu cikar.
// Cumartesi is yeri erken kapandigi icin esik ayridir.
const EARLY_EXIT_BEFORE = /^\d{2}:\d{2}$/.test(process.env.EARLY_EXIT_BEFORE || '') ? process.env.EARLY_EXIT_BEFORE : '18:29';
const EARLY_EXIT_BEFORE_SAT = /^\d{2}:\d{2}$/.test(process.env.EARLY_EXIT_BEFORE_SAT || '') ? process.env.EARLY_EXIT_BEFORE_SAT : '16:59';
// Reddedilen okutmada dogruluk payi bu degerin ustundeyse telefon yaklasik konum veriyor sayilir (Android kaba konum ~2 km).
const COARSE_ACCURACY_M = Number(process.env.COARSE_ACCURACY_M) > 0 ? Number(process.env.COARSE_ACCURACY_M) : 500;

function earlyExitThreshold(businessDayStr, location) {
  // Tam gun tatilde mesai yok, onay sorulmaz; yarim gun tatilde esik tatil bitisinden 1 dk once
  if (!T.worksOn(businessDayStr, location)) return null;
  const holiday = T.holidayFor(businessDayStr, location);
  if (holiday && holiday.shift_end) return T.addMinutesHM(holiday.shift_end, -1);
  if (T.weekdayOf(businessDayStr) === 6) return EARLY_EXIT_BEFORE_SAT;
  // Lokasyonun kendi mesai bitisi varsa esik bitisten 1 dk oncesi (18:30 -> 18:29)
  if (location && location.shift_end) return T.addMinutesHM(location.shift_end, -1);
  return EARLY_EXIT_BEFORE;
}

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

const reportClosed = 'Rapor yükleme şu an kapalı.';
const reportTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']);

// Bu uçta yalnız belge sunucusunun imzaladığı küçük JSON gövdesi okunur.
app.post('/api/belge/kayit', express.raw({ type: 'application/json', limit: '10kb', inflate: false }), async (req, res, next) => {
  try {
    if (!belge.enabled()) return res.status(503).json({ error: reportClosed });
    if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: 'JSON gövdesi bekleniyor.' });
    if (!belge.verifyCallback(req.get('X-Ik-Zaman'), req.get('X-Ik-Imza'), req.body)) {
      return res.status(401).json({ error: 'Kayıt çağrısı doğrulanamadı.' });
    }
    let body;
    try { body = JSON.parse(req.body.toString('utf8')); }
    catch { return res.status(400).json({ error: 'Geçersiz JSON.' }); }
    const ticket = belge.verifyTicket(body?.bilet);
    if (!ticket) return res.status(400).json({ error: 'Geçersiz yükleme bileti.' });
    if (Math.floor(Date.now() / 1000) > ticket.x + 600) {
      return res.status(400).json({ error: 'Yükleme süresi doldu, tekrar deneyin.' });
    }
    const file = body.belge;
    if (!file || typeof file.id !== 'string' || !/^[a-f0-9]{32}$/.test(file.id) ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isInteger(file.boyut) || file.boyut < 1 || file.boyut > 15 * 1024 * 1024 || !reportTypes.has(file.tur)) {
      return res.status(400).json({ error: 'Belge bilgileri geçersiz.' });
    }
    const result = service.registerReport(ticket, file.id);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    await telegram.notifyLeaveRequest(result.id);
    res.status(201).json(result);
  } catch (e) { next(e); }
}, (err, req, res, next) => {
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'Kayıt gövdesi okunamadı.' });
  next(err);
});

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser());
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

app.locals.T = T;
app.locals.leaveLabels = service.leaveLabels;
app.locals.BASE_URL = BASE_URL;

// --- Rate limit: token basina dakikada 5 istek; token yoksa IP basina 30 ---
// (Toplu kayit gununde ayni Wi-Fi'deki herkes tek IP'den gelir; 5 ile kuyruk olusuyordu.)
const writeLimiter = createRateLimiter({ limit: 5, windowMs: 60000 });
const ipLimiter = createRateLimiter({ limit: 30, windowMs: 60000 });

function rateLimited(req, res, next) {
  const scope = req.baseUrl === '/api/izin' ? 'izin:' : '';
  const token = (req.body && req.body.token) || (scope && req.get('X-PDKS-Token')) || req.cookies[TOKEN_COOKIE];
  const result = token ? writeLimiter(scope + 'tok:' + token) : ipLimiter(scope + 'ip:' + (req.ip || 'bilinmiyor'));
  if (!result.ok) {
    res.setHeader('Retry-After', String(result.retryAfter));
    return res.status(429).json({
      error: 'rate_limited',
      message: `Çok fazla istek. ${result.retryAfter} saniye sonra tekrar deneyin.`
    });
  }
  next();
}

// --- Personel sayfasi ---
app.get('/', (req, res) => {
  res.render('index', { title: 'PDKS' });
});

app.get('/saglik', (req, res) => res.json({ ok: true, now: new Date().toISOString() }));

app.get('/c/:slug', (req, res) => {
  const location = service.getLocationBySlug(req.params.slug);
  if (!location || !location.active) {
    return res.status(404).render('checkin-error', {
      title: 'Lokasyon bulunamadi',
      message: 'Bu QR kod gecerli bir lokasyona ait degil. Lutfen yoneticinize bildirin.'
    });
  }
  res.render('checkin', {
    title: location.name,
    location,
    serverTime: T.fmtTime(new Date()),
    serverDate: T.fmtDateTR(T.fmtDate(new Date()))
  });
});

app.use('/api/izin', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const token = (req.body && req.body.token) || req.get('x-pdks-token') || req.cookies[TOKEN_COOKIE];
  const identity = resolveToken(token);
  if (identity.state !== 'ok') return res.status(identity.state === 'unknown' ? 401 : 403).json({ error: 'İzin işlemleri için aktif bir personel kaydı gerekiyor.' });
  req.employee = identity.employee;
  if (req.method === 'POST') return rateLimited(req, res, next);
  next();
});

app.get('/api/izin', (req, res) => {
  const sef = service.isLeaveSupervisor(req.employee.id);
  const people = sef ? { personel: service.leaveTeam(req.employee) } : {};
  const party = sef ? 'JOIN employees e ON e.id = r.employee_id WHERE r.opened_by = ?'
    : 'LEFT JOIN employees e ON e.id = r.opened_by WHERE r.employee_id = ?';
  const talepler = db.prepare(`SELECT r.id, r.start_day, r.end_day, r.leave_type, r.work_days, r.note, r.status,
    e.name AS ${sef ? 'ad' : 'acan'} FROM leave_requests r ${party} ORDER BY r.id DESC LIMIT 10`).all(req.employee.id).map((r) => ({
      ...r, tur: service.leaveLabels[r.leave_type], durum: service.leaveStatuses[r.status]
    }));
  res.json({ sef, rapor: belge.enabled(), ...people, talepler, turler: Object.keys(service.leaveLabels).filter((type) => type !== 'rapor') });
});

app.post('/api/izin/rapor-bilet', (req, res) => {
  if (!belge.enabled()) return res.status(503).json({ error: reportClosed });
  const r = service.validateReport(req.employee, req.body);
  if (r.error) return res.status(400).json(r);
  const bilet = belge.signTicket({ v: 1, emp: r.employeeId, by: r.openedBy, s: r.start, e: r.end,
    n: crypto.randomBytes(16).toString('hex'), x: Math.floor(Date.now() / 1000) + 900 });
  res.json({ bilet, url: process.env.IK_BELGE_URL + '/yukle' });
});

app.post('/api/izin', async (req, res, next) => {
  try {
    const result = service.createLeaveRequest(req.employee, req.body);
    if (result.error) return res.status(400).json(result);
    await telegram.notifyLeaveRequest(result.id);
    res.status(201).json(result);
  } catch (e) { next(e); }
});

app.post('/api/izin/:id/iptal', async (req, res, next) => {
  try {
    const id = req.params.id;
    const changed = db.prepare(`UPDATE leave_requests SET status = 'cancelled', decided_by = ?, decided_at = ?
      WHERE id = ? AND status = 'pending' AND ((opened_by IS NULL AND employee_id = ?) OR opened_by = ?)`)
      .run(req.employee.name, new Date().toISOString(), id, req.employee.id,
        service.isLeaveSupervisor(req.employee.id) ? req.employee.id : null);
    if (!changed.changes) return res.status(409).json({ error: 'Yalnızca kendi bekleyen talebinizi iptal edebilirsiniz.' });
    await telegram.updateLeaveMessages(id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Cihaz / kimlik ---
app.post('/api/identify', (req, res) => {
  const token = req.body.token || req.cookies[TOKEN_COOKIE] || null;
  const info = resolveToken(token);
  if (info.state === 'unknown') return res.json({ state: 'unknown' });

  // Cookie ile localStorage arasinda karsilikli yedekleme
  if (token && req.cookies[TOKEN_COOKIE] !== token && info.state !== 'unknown') {
    setTokenCookie(req, res, token);
  }

  const today = T.todayBusinessDay();
  const range = T.businessDayRange(today);
  const checks = db
    .prepare('SELECT type, ts, flagged FROM checkins WHERE employee_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC')
    .all(info.employee.id, range.start, range.end);

  res.json({
    state: info.state,
    izinSef: info.state === 'ok' ? service.isLeaveSupervisor(info.employee.id) : undefined,
    rapor: info.state === 'ok' ? belge.enabled() : undefined,
    token,
    name: info.employee.name,
    today: checks.map((c) => ({ type: c.type, time: T.fmtTime(new Date(c.ts)), flagged: !!c.flagged }))
  });
});

app.post('/api/register', rateLimited, (req, res) => {
  const location = service.getLocationBySlug(req.body.slug);
  if (!location || !location.active) return res.status(404).json({ error: 'Lokasyon bulunamadi' });

  const name = cleanName(req.body.name);
  const phone = normalizePhone(req.body.phone);
  const kvkk = req.body.kvkk === true || req.body.kvkk === 'on';

  if (name.length < 3 || !name.includes(' ')) {
    return res.status(400).json({ error: 'Lutfen ad ve soyadinizi yazin.' });
  }
  if (!validPhone(phone)) {
    return res.status(400).json({ error: 'Telefon numarasi gecersiz. Ornek: 0532 123 45 67' });
  }
  if (!kvkk) {
    return res.status(400).json({ error: 'Devam etmek icin aydinlatma metnini onaylamalisiniz.' });
  }

  const existing = db.prepare('SELECT * FROM employees WHERE phone = ?').get(phone);
  if (existing && existing.status === 'active') {
    return res.status(409).json({
      error: 'Bu telefon numarasi zaten kayitli. "Daha once kayitliyim" secenegini kullanin.',
      code: 'already_registered'
    });
  }

  const now = new Date().toISOString();
  const token = newToken();
  const browserId = cleanBrowserId(req.body.bid);
  const result = db.transaction(() => {
    let employeeId;
    if (existing) {
      db.prepare('UPDATE employees SET name = ?, location_id = ? WHERE id = ?').run(name, location.id, existing.id);
      employeeId = existing.id;
    } else {
      employeeId = db
        .prepare(
          "INSERT INTO employees (name, phone, location_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
        )
        .run(name, phone, location.id, now).lastInsertRowid;
    }
    const deviceId = db
      .prepare('INSERT INTO devices (employee_id, token, active, user_agent, created_at, browser_id) VALUES (?, ?, 0, ?, ?, ?)')
      .run(employeeId, token, String(req.get('user-agent') || '').slice(0, 200), now, browserId).lastInsertRowid;
    db.prepare(
      `INSERT INTO device_requests (employee_id, device_id, location_id, name, phone, type, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'new', 'pending', ?)`
    ).run(employeeId, deviceId, location.id, name, phone, now);
    return { employeeId, deviceId };
  })();

  logAction('personel', 'register', `${name} / ${phone} / ${location.name}`);
  setTokenCookie(req, res, token);
  res.json({ state: 'pending', token, name, employeeId: result.employeeId });
});

app.post('/api/device-change', rateLimited, (req, res) => {
  const location = service.getLocationBySlug(req.body.slug);
  if (!location || !location.active) return res.status(404).json({ error: 'Lokasyon bulunamadi' });

  const phone = normalizePhone(req.body.phone);
  if (!validPhone(phone)) return res.status(400).json({ error: 'Telefon numarasi gecersiz.' });

  const employee = db.prepare('SELECT * FROM employees WHERE phone = ?').get(phone);
  if (!employee) {
    return res.status(404).json({ error: 'Bu numarayla kayitli personel bulunamadi. Yeni kayit olusturun.' });
  }
  if (employee.status === 'passive') {
    return res.status(403).json({ error: 'Kaydiniz pasif durumda. Lutfen yoneticinizle gorusun.' });
  }

  const now = new Date().toISOString();
  const token = newToken();
  const ua = String(req.get('user-agent') || '').slice(0, 200);
  const browserId = cleanBrowserId(req.body.bid);
  const label = uaLabel(ua);

  // 2026-09-09: aktif personelin cihaz degisikligi guvenliyse ANINDA onaylanir (yonetici onayi beklenmez).
  // Eski cihazlar kapatilmaz. Supheli durumlarda (haftalik sinir, ayni telefon baska personelde) eski akis: onaya duser.
  const decision = service.autoDeviceDecision(employee, browserId);
  if (decision.auto) {
    db.transaction(() => {
      const deviceId = db
        .prepare('INSERT INTO devices (employee_id, token, active, user_agent, created_at, browser_id) VALUES (?, ?, 1, ?, ?, ?)')
        .run(employee.id, token, ua, now, browserId).lastInsertRowid;
      db.prepare(
        `INSERT INTO device_requests (employee_id, device_id, location_id, name, phone, type, status, created_at, decided_at, decided_by)
         VALUES (?, ?, ?, ?, ?, 'change', 'approved', ?, ?, 'auto')`
      ).run(employee.id, deviceId, location.id, employee.name, phone, now, now);
    })();
    const activeCount = service.activeDeviceCount(employee.id);
    logAction('sistem', 'device_auto_approve', `${employee.name} / ${phone} / ${label} / aktif cihaz: ${activeCount}`);
    telegram.notifyDeviceAdded(employee, label, activeCount).catch(() => {});
    setTokenCookie(req, res, token);
    return res.json({ state: 'ok', token, name: employee.name, type: 'change', auto: true });
  }

  db.transaction(() => {
    const deviceId = db
      .prepare('INSERT INTO devices (employee_id, token, active, user_agent, created_at, browser_id) VALUES (?, ?, 0, ?, ?, ?)')
      .run(employee.id, token, ua, now, browserId).lastInsertRowid;
    db.prepare(
      `INSERT INTO device_requests (employee_id, device_id, location_id, name, phone, type, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'change', 'pending', ?)`
    ).run(employee.id, deviceId, location.id, employee.name, phone, now);
  })();

  logAction('personel', 'device_change_request', `${employee.name} / ${phone} / ${label} / onaya düştü: ${decision.reason}`);
  if (employee.status === 'active') telegram.notifyDeviceHeld(employee, label, decision.reason).catch(() => {});
  setTokenCookie(req, res, token);
  res.json({ state: 'pending', token, name: employee.name, type: 'change' });
});

// --- Okutma ---
app.post('/api/checkin', rateLimited, (req, res) => {
  const token = req.body.token || req.cookies[TOKEN_COOKIE] || null;
  const info = resolveToken(token);

  if (info.state === 'unknown') return res.status(401).json({ state: 'unknown' });
  if (info.state === 'pending') return res.status(403).json({ state: 'pending', name: info.employee.name });
  if (info.state === 'rejected') return res.status(403).json({ state: 'rejected', name: info.employee.name });
  if (info.state === 'revoked') return res.status(403).json({ state: 'revoked', name: info.employee.name });
  if (info.state === 'passive') return res.status(403).json({ state: 'passive', name: info.employee.name });

  // Kayit okutulan QR'in lokasyonuna yazilir. Giris-cikis binadan bagimsiz donusumludur (Kagan 22.10):
  // Merkez'den giren, Uretim'e gorevlendirildiyse Uretim'de cikis okutur.
  const scannedSlug = qrSlug(req.body.qr);
  const location = service.getLocationBySlug(scannedSlug || req.body.slug);
  if (!location || !location.active) return res.status(404).json({ error: 'Lokasyon bulunamadi' });

  // Duvardaki imzali QR kod zorunlu (link degil; yalnizca sayfadaki okuyucu okur)
  if (!scannedSlug) {
    logAction('personel', 'checkin_rejected', `${info.employee.name} / qr_invalid / ${location.name}`);
    return res.status(403).json({
      state: 'qr_invalid',
      error: 'Duvardaki QR kod okutulmadan kayıt alınamaz. Lütfen lokasyondaki güncel PDKS kodunu okutun.'
    });
  }

  let coords = null;
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    coords = { lat, lng, accuracy: Number.isFinite(Number(req.body.accuracy)) ? Number(req.body.accuracy) : null };
  }

  // Konum dogrulamasi: uzakta veya konumsuz okutma KAYIT EDILMEZ, reddedilir.
  const pos = service.evaluatePosition(location, coords);
  if (pos.flagged) {
    if (pos.flag_reason === 'out_of_range') {
      const dist = Math.round(pos.distance);
      const acc = coords && coords.accuracy != null ? Math.round(coords.accuracy) : null;
      const accTxt = acc != null ? ` / ±${acc}m` : '';
      // Telefon yaklasik konum veriyorsa (Android "Hassas konum" / iPhone "Tam Konum" kapali, ya da yalniz baz istasyonu)
      // personel ne yapacagini bilsin (26.11 Gulay: 1,4 km sabit, dogrulugu dusuk konum).
      if (acc != null && acc >= COARSE_ACCURACY_M) {
        logAction('personel', 'checkin_rejected', `${info.employee.name} / coarse_location / ${dist}m${accTxt} / ${location.name}`);
        return res.status(403).json({
          state: 'location_rejected',
          reason: 'coarse_location',
          distance: dist,
          accuracy: acc,
          error: `Telefonunuz konumu yaklaşık veriyor (±${acc >= 1000 ? (acc / 1000).toFixed(1) + ' km' : acc + ' m'}). Telefon ayarlarında tarayıcınızın konum izninde "Hassas konum" (iPhone'da "Tam Konum") açık olmalı. Açıp tekrar deneyin. Kayıt alınmadı.`
        });
      }
      logAction('personel', 'checkin_rejected', `${info.employee.name} / out_of_range / ${dist}m${accTxt} / ${location.name}`);
      return res.status(403).json({
        state: 'location_rejected',
        reason: 'out_of_range',
        distance: dist,
        error: `İş yerinde görünmüyorsunuz: ${location.name} konumuna ${dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : dist + ' m'} uzaktasınız. Kayıt alınmadı.`
      });
    }
    logAction('personel', 'checkin_rejected', `${info.employee.name} / no_gps / ${location.name}`);
    return res.status(403).json({
      state: 'location_rejected',
      reason: 'no_gps',
      error: 'Konumunuz alınamadı. Telefonunuzun konumunu açıp tarayıcıya konum izni verin ve tekrar deneyin. Kayıt alınmadı.'
    });
  }

  // Erken cikis onayi: siradaki islem CIKIS ise ve mesai bitiminden onceyse onay istenir.
  const day0 = T.todayBusinessDay();
  const range0 = T.businessDayRange(day0);
  const lastRec = db
    .prepare('SELECT * FROM checkins WHERE employee_id = ? AND ts >= ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1')
    .get(info.employee.id, range0.start, range0.end);
  const inDupWindow = lastRec && Date.now() - new Date(lastRec.ts).getTime() < 2 * 60 * 1000; // service.js ile ayni pencere
  if (lastRec && lastRec.type === 'in' && !inDupWindow && req.body.confirm !== true) {
    const nowHM = T.fmtTime(new Date());
    const threshold = earlyExitThreshold(day0, location);
    if (threshold && nowHM < threshold) {
      return res.status(409).json({
        state: 'confirm_required',
        type: 'out',
        nowTime: nowHM,
        threshold
      });
    }
  }

  // Tarayici kimligini cihaza isle (eski cihazlar icin geriye donuk doldurma)
  const bid = cleanBrowserId(req.body.bid);
  if (bid && info.device.browser_id !== bid) {
    db.prepare('UPDATE devices SET browser_id = ? WHERE id = ?').run(bid, info.device.id);
    info.device.browser_id = bid;
  }

  const result = service.recordCheckin({
    employee: info.employee,
    location,
    coords,
    source: 'qr',
    now: new Date(),
    device: info.device
  });

  // Ortak telefon tespiti: ayni tarayici kimligi baska bir aktif personelde de kayitliysa Telegram'a uyari (gunde 1 kez / kisi)
  if (result.id && !result.duplicate && info.device.browser_id) {
    const others = service.browserIdOtherOwners(info.device.browser_id, info.employee.id);
    if (others.length) {
      const key = `${result.day} #${info.employee.id}`;
      const already = db
        .prepare("SELECT 1 FROM audit_log WHERE action = 'shared_device' AND detail LIKE ? LIMIT 1")
        .get(key + '%');
      if (!already) {
        const names = others.map((o) => o.name);
        logAction('sistem', 'shared_device', `${key} ${info.employee.name} ~ ${names.join(', ')} / cihaz #${info.device.id}`);
        telegram.notifySharedDevice(info.employee, names, uaLabel(info.device.user_agent)).catch(() => {});
      }
    }
  }

  // Gec giris bilgisi: yalnizca gunun ILK girisi icin (ogle arasi donusleri gec sayilmaz)
  const shiftStart = info.employee.shift_start || location.shift_start || '08:30';
  // Calisilmayan gunde (pazar, tatil) gelen mesaiye gelmistir, gec sayilmaz
  const lateMin =
    !lastRec && result.type === 'in' && !result.duplicate && T.worksOn(result.day, location)
      ? T.lateMinutesFor(result.day, shiftStart, result.ts)
      : 0;
  const late = lateMin > 0;
  if (late && result.id) {
    telegram.notifyLate(info.employee, result.id, result.ts, lateMin).catch(() => {});
  }

  // Yoklama sonrasi durum bildirimi: 08:33 raporu "gelmedi" dedikten sonra gec sayilmadan gelen,
  // ya da aksam raporu "cikis okutmadi" dedikten sonra QR ile cikan kisi abonelere bildirilir.
  if (result.id && !result.duplicate) {
    const reported = (action) => telegram.reportSent(action, result.day, info.employee.location_id);
    if (!lastRec && result.type === 'in' && !late && reported('morning_report')) {
      telegram.notifyArrivedAfterReport(info.employee, result.ts).catch(() => {});
    }
    if (result.type === 'out' && reported('evening_report')) {
      telegram.notifyLeftAfterReport(info.employee, result.ts).catch(() => {});
    }
  }

  // Gun ici geri donus: cikistan sonraki yeniden giris abonelere gider. Sabahki ilk giris (yoklama) ve
  // aksam cikisi (aksam yoklamasi) toplu bildirildigi icin ayrica gitmez.
  if (result.id && !result.duplicate && result.type === 'in' && lastRec && lastRec.type === 'out') {
    telegram.notifyReturned(info.employee, result.ts, lastRec.ts).catch(() => {});
  }

  // Erken cikis bildirimi: mesai bitiminden once okutulan cikis aninda abonelere gider.
  // Son EARLY_EXIT_TOLERANCE_MIN dakika (vars. 5) tolerans: 18:25 ve sonrasi bildirim uretmez.
  if (result.type === 'out' && result.id && !result.duplicate && T.worksOn(result.day, location)) {
    const shiftEnd = T.shiftEndFor(result.day, location);
    const outHM = T.fmtTime(new Date(result.ts));
    const earlyMin = outHM >= '05:00' ? T.earlyMinutesFor(result.day, result.ts, shiftEnd) : 0;
    if (earlyMin > 0) {
      telegram.notifyEarlyExit(info.employee, { id: result.id, ts: result.ts }, shiftEnd, earlyMin).catch(() => {});
    }
  }

  const range = T.businessDayRange(result.day);
  const today = db
    .prepare('SELECT type, ts, flagged FROM checkins WHERE employee_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC')
    .all(info.employee.id, range.start, range.end)
    .map((c) => ({ type: c.type, time: T.fmtTime(new Date(c.ts)), flagged: !!c.flagged }));

  res.json({
    state: 'ok',
    name: info.employee.name,
    location: location.name,
    today,
    late,
    shiftStart,
    ...result
  });
});

// --- Bekci (guvenlik, CT102) icin salt okunur "iceride kim var" ucu ---
// Bearer BEKCI_API_TOKEN ile; kaynak Telegram /ictima ile ayni (service.dayOverview().present):
// personelin KENDI lokasyonuna gore, gunun son kaydi giris olanlar.
function bekciAuthorized(req) {
  const expected = process.env.BEKCI_API_TOKEN || '';
  if (expected.length < 16) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') || '');
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

app.get('/api/icerde', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!bekciAuthorized(req)) return res.status(401).json({ error: 'yetkisiz' });
  const slug = String(req.query.lokasyon || '').trim();
  const location = slug ? service.getLocationBySlug(slug) : null;
  if (!location || !location.active) return res.status(404).json({ error: 'lokasyon_yok' });
  const now = new Date();
  const day = T.businessDay(now);
  const ov = service.dayOverview(day, location.id);
  res.json({
    lokasyon: location.slug,
    zaman: now.toISOString(),
    gun: day,
    // O gun calisilmiyorsa (pazar, tam gun tatil, kapali cumartesi) null; yarim gun tatilde tatil bitisi
    mesai_bitis: T.worksOn(day, location) ? T.shiftEndFor(day, location) : null,
    sayi: ov.present.length,
    icerde: ov.present.map((r) => ({ ad: r.employee.name, giris: r.inTime }))
  });
});

app.use('/yonetim', require('./yonetim'));
app.use('/admin', adminRouter);

app.use((req, res) => {
  res.status(404).render('checkin-error', { title: 'Sayfa bulunamadi', message: 'Aradiginiz sayfa bulunamadi.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Sunucu hatasi' });
  res.status(500).render('checkin-error', {
    title: 'Hata',
    message: 'Beklenmeyen bir hata olustu. Lutfen tekrar deneyin.'
  });
});

function start() {
  if (!process.env.ADMIN_PASSWORD) {
    if (process.env.NODE_ENV === 'production') {
      console.error('HATA: ADMIN_PASSWORD tanimli degil. Railway > Variables icinden ekleyin.');
      process.exit(1);
    }
    console.warn('UYARI: ADMIN_PASSWORD tanimli degil, gelistirme sifresi "admin123" kullaniliyor.');
  }
  if (!process.env.BASE_URL) {
    console.warn(`UYARI: BASE_URL tanimli degil, QR kodlari ${BASE_URL} adresini gosterecek.`);
  }

  require('./seed').ensureSeed();

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`PDKS calisiyor: http://0.0.0.0:${PORT} (BASE_URL=${BASE_URL})`);
  });

  // Railway yeniden deploy ederken SIGTERM gonderir: WAL'i kapatip temiz cikis yap
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} alindi, kapatiliyor...`);
    server.close(() => {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
      } catch (err) {
        console.error('Veritabani kapatilamadi:', err.message);
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  ['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => shutdown(sig)));

  telegram.start();
}

if (require.main === module) start();

module.exports = app;
