'use strict';

const express = require('express');
const { db } = require('./db');
const T = require('./time');
const service = require('./service');
const telegram = require('./telegram');
const auth = require('./panel-auth');

const router = express.Router();
const base = '/yonetim';
const flashCookie = 'yonetim_flash';

function expired(res) {
  return res.status(401).render('checkin-error', { title: 'Yönetici girişi', message: "Bağlantının süresi dolmuş. Telegram'da bota /panel yazın." });
}

router.use((req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  next();
});

router.get('/giris', (req, res) => {
  if (typeof req.query.t !== 'string') return expired(res);
  const session = auth.consume(req.query.t);
  if (!session) return expired(res);
  res.cookie('yonetim', session, { ...auth.cookie, maxAge: auth.MAX_AGE });
  res.redirect(base);
});

router.use((req, res, next) => {
  const session = auth.sessionOf(req.cookies.yonetim);
  if (!session) return expired(res);
  if (req.method === 'POST' && req.body?.csrf !== session.csrf) {
    return res.status(403).render('checkin-error', { title: 'İşlem doğrulanamadı', message: 'Sayfayı yenileyip tekrar deneyin.' });
  }
  res.locals.session = session;
  res.locals.path = req.path;
  res.locals.flash = req.cookies[flashCookie];
  if (res.locals.flash) res.clearCookie(flashCookie, auth.cookie);
  next();
});

function redirectMessage(res, path, message) {
  res.cookie(flashCookie, message, { ...auth.cookie, maxAge: 10000 });
  return res.redirect(base + path);
}

router.post('/cikis', (req, res) => {
  res.clearCookie('yonetim', auth.cookie);
  res.render('checkin-error', { title: 'Oturum kapatıldı', message: "Tekrar giriş yapmak için Telegram'da bota /panel yazın." });
});

router.get('/', (req, res) => {
  const select = `SELECT r.*, e.name, l.name AS location FROM leave_requests r JOIN employees e ON e.id = r.employee_id
    LEFT JOIN locations l ON l.id = e.location_id`;
  const pending = db.prepare(select + " WHERE r.status = 'pending' ORDER BY r.id").all();
  const decided = db.prepare(select + " WHERE r.status != 'pending' ORDER BY r.decided_at DESC, r.id DESC LIMIT 30").all();
  res.render('yonetim/talepler', { title: 'Talepler', pending, decided, statuses: service.leaveStatuses });
});

router.post('/talep/:id/:action(onayla|reddet)', async (req, res, next) => {
  try {
    const approve = req.params.action === 'onayla';
    const result = service.decideLeaveRequest(req.params.id, approve, res.locals.session.name, 'panel');
    if (!result.ok) return redirectMessage(res, '', result.already ? 'Bu talebe zaten karar verildi — ' + result.already.decided_by : 'Talep bulunamadı.');
    await telegram.updateLeaveMessages(req.params.id);
    redirectMessage(res, '', approve ? 'Talep onaylandı.' : 'Talep reddedildi.');
  } catch (e) { next(e); }
});

function activePeople() {
  return db.prepare(`SELECT e.id, e.name, e.hire_date, e.location_id, l.name AS location FROM employees e
    LEFT JOIN locations l ON l.id = e.location_id WHERE e.status = 'active' ORDER BY l.name, e.location_id, e.name`).all();
}

router.get('/takvim', (req, res) => {
  const month = typeof req.query.ay === 'string' && service.validDay(req.query.ay + '-01') ? req.query.ay : T.todayBusinessDay().slice(0, 7);
  const rows = service.leavesBetween(month + '-01', month + '-31');
  const totals = new Map();
  const dates = new Map();
  for (const row of rows) {
    if (!dates.has(row.day)) dates.set(row.day, []);
    dates.get(row.day).push(row);
    if (!totals.has(row.employee_id)) totals.set(row.employee_id, { name: row.employee_name, total: 0, counts: new Map() });
    const person = totals.get(row.employee_id);
    person.total++;
    const label = service.leaveLabels[row.type] || 'Tür belirtilmemiş';
    person.counts.set(label, (person.counts.get(label) || 0) + 1);
  }
  res.render('yonetim/takvim', { title: 'İzin takvimi', month, dates, totals });
});

function annualBalance(hire, today, employeeId) {
  if (!hire) return null;
  const year = Number(today.slice(0, 4));
  const anniversary = (y) => {
    const day = y + hire.slice(4);
    return service.validDay(day) ? day : y + '-02-28';
  };
  const last = anniversary(year) > today ? anniversary(year - 1) : anniversary(year);
  const years = Math.max(0, Number(last.slice(0, 4)) - Number(hire.slice(0, 4)));
  const granted = years < 1 ? 0 : years <= 5 ? 14 : years < 15 ? 20 : 26;
  const used = db.prepare("SELECT COUNT(*) n FROM leaves WHERE employee_id = ? AND type = 'yillik' AND day BETWEEN ? AND ?")
    .get(employeeId, last < hire ? hire : last, today).n;
  return { years, granted, used, remaining: granted - used };
}

router.get('/kisiler', (req, res) => {
  const today = T.todayBusinessDay();
  const from = today.slice(0, 4) + '-01-01';
  const people = activePeople();
  const counts = db.prepare('SELECT type, COUNT(*) n FROM leaves WHERE employee_id = ? AND day BETWEEN ? AND ? GROUP BY type');
  const groups = new Map();
  for (const person of people) {
    person.counts = Object.fromEntries(counts.all(person.id, from, today).map((r) => [r.type || 'belirtilmemis', r.n]));
    person.balance = annualBalance(person.hire_date, today, person.id);
    if (!groups.has(person.location_id)) groups.set(person.location_id, []);
    groups.get(person.location_id).push(person);
  }
  res.render('yonetim/kisiler', { title: 'Kişiler', groups, year: today.slice(0, 4) });
});

router.get('/izin-ekle', (req, res) => {
  res.render('yonetim/ekle', { title: 'İzin ekle', people: activePeople(), today: T.todayBusinessDay() });
});

router.post('/izin-ekle', (req, res) => {
  const employee = db.prepare("SELECT * FROM employees WHERE id = ? AND status = 'active'").get(Number(req.body.employee_id));
  if (!employee) return redirectMessage(res, '/izin-ekle', 'Aktif bir personel seçin.');
  const result = service.createLeaveRequest(employee, req.body, res.locals.session.name);
  redirectMessage(res, result.error ? '/izin-ekle' : '', result.error || 'İzin eklendi.');
});

module.exports = router;
