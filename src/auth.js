'use strict';

const crypto = require('crypto');
const { db } = require('./db');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.createHash('sha256').update('pdks:' + ADMIN_PASSWORD).digest('hex');

const SESSION_COOKIE = 'pdks_admin';
const TOKEN_COOKIE = 'pdks_token';
const SESSION_MAX_AGE = 12 * 3600 * 1000;
const TOKEN_MAX_AGE = 365 * 24 * 3600 * 1000;

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function makeSession() {
  const payload = JSON.stringify({ u: 'admin', exp: Date.now() + SESSION_MAX_AGE });
  const body = Buffer.from(payload).toString('base64url');
  return `${body}.${sign(body)}`;
}

function verifySession(raw) {
  if (!raw || typeof raw !== 'string' || !raw.includes('.')) return null;
  const [body, sig] = raw.split('.');
  const expected = sign(body);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function checkPassword(input) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function secureCookies(req) {
  return req.protocol === 'https' || req.get('x-forwarded-proto') === 'https';
}

function setSessionCookie(req, res) {
  res.cookie(SESSION_COOKIE, makeSession(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(req),
    maxAge: SESSION_MAX_AGE
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE);
}

function setTokenCookie(req, res, token) {
  res.cookie(TOKEN_COOKIE, token, {
    httpOnly: false, // localStorage ile karsilikli yedekleme icin okunabilir olmali
    sameSite: 'lax',
    secure: secureCookies(req),
    maxAge: TOKEN_MAX_AGE
  });
}

function requireAdmin(req, res, next) {
  const session = verifySession(req.cookies[SESSION_COOKIE]);
  if (!session) {
    if (req.accepts('html')) return res.redirect('/admin/giris?next=' + encodeURIComponent(req.originalUrl));
    return res.status(401).json({ error: 'Oturum gerekli' });
  }
  req.admin = session;
  next();
}

// Token -> cihaz + personel cozumleme
function resolveToken(token) {
  if (!token || typeof token !== 'string') return { state: 'unknown' };
  const device = db.prepare('SELECT * FROM devices WHERE token = ?').get(token);
  if (!device) return { state: 'unknown' };
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(device.employee_id);
  if (!employee) return { state: 'unknown' };
  if (!device.active) {
    const pendingReq = db
      .prepare("SELECT * FROM device_requests WHERE device_id = ? AND status = 'pending'")
      .get(device.id);
    if (pendingReq) return { state: 'pending', device, employee, request: pendingReq };
    const rejected = db
      .prepare("SELECT * FROM device_requests WHERE device_id = ? AND status = 'rejected' ORDER BY id DESC")
      .get(device.id);
    if (rejected) return { state: 'rejected', device, employee };
    return { state: 'revoked', device, employee };
  }
  if (employee.status === 'pending') return { state: 'pending', device, employee };
  if (employee.status !== 'active') return { state: 'passive', device, employee };
  return { state: 'ok', device, employee };
}

module.exports = {
  ADMIN_PASSWORD,
  SESSION_COOKIE,
  TOKEN_COOKIE,
  checkPassword,
  setSessionCookie,
  clearSessionCookie,
  setTokenCookie,
  requireAdmin,
  verifySession,
  resolveToken
};
