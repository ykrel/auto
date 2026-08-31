'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { db, logAction } = require('./db');
const T = require('./time');
const {
  normalizePhone,
  validPhone,
  cleanName,
  newToken,
  createRateLimiter
} = require('./util');
const { TOKEN_COOKIE, setTokenCookie, resolveToken } = require('./auth');
const service = require('./service');
const adminRouter = require('./admin');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser());
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

app.locals.T = T;
app.locals.BASE_URL = BASE_URL;

// --- Rate limit: token (yoksa IP) basina dakikada 5 istek ---
const writeLimiter = createRateLimiter({ limit: 5, windowMs: 60000 });

function limitKey(req) {
  const token = (req.body && req.body.token) || req.cookies[TOKEN_COOKIE];
  return token ? 'tok:' + token : 'ip:' + (req.ip || 'bilinmiyor');
}

function rateLimited(req, res, next) {
  const result = writeLimiter(limitKey(req));
  if (!result.ok) {
    res.setHeader('Retry-After', String(result.retryAfter));
    return res.status(429).json({
      error: 'rate_limited',
      message: `Cok fazla istek. ${result.retryAfter} saniye sonra tekrar deneyin.`
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
      .prepare('INSERT INTO devices (employee_id, token, active, user_agent, created_at) VALUES (?, ?, 0, ?, ?)')
      .run(employeeId, token, String(req.get('user-agent') || '').slice(0, 200), now).lastInsertRowid;
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
  db.transaction(() => {
    const deviceId = db
      .prepare('INSERT INTO devices (employee_id, token, active, user_agent, created_at) VALUES (?, ?, 0, ?, ?)')
      .run(employee.id, token, String(req.get('user-agent') || '').slice(0, 200), now).lastInsertRowid;
    db.prepare(
      `INSERT INTO device_requests (employee_id, device_id, location_id, name, phone, type, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'change', 'pending', ?)`
    ).run(employee.id, deviceId, location.id, employee.name, phone, now);
  })();

  logAction('personel', 'device_change_request', `${employee.name} / ${phone}`);
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

  const location = service.getLocationBySlug(req.body.slug);
  if (!location || !location.active) return res.status(404).json({ error: 'Lokasyon bulunamadi' });

  let coords = null;
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    coords = { lat, lng, accuracy: Number.isFinite(Number(req.body.accuracy)) ? Number(req.body.accuracy) : null };
  }

  const result = service.recordCheckin({
    employee: info.employee,
    location,
    coords,
    source: 'qr',
    now: new Date()
  });

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
    ...result
  });
});

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

if (require.main === module) {
  require('./seed').ensureSeed();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PDKS calisiyor: http://0.0.0.0:${PORT} (BASE_URL=${BASE_URL})`);
  });
}

module.exports = app;
