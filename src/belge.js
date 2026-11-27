'use strict';

const crypto = require('crypto');

function enabled() {
  return Boolean(process.env.IK_BELGE_SECRET && process.env.IK_BELGE_URL);
}

function hmac(prefix, raw = '') {
  return crypto.createHmac('sha256', process.env.IK_BELGE_SECRET).update(prefix).update(raw).digest();
}

function equal(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signTicket(payload) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return p + '.' + hmac('bilet.' + p).toString('base64url');
}

function verifyTicket(bilet) {
  if (!enabled() || typeof bilet !== 'string') return null;
  const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(bilet);
  if (!parts || !equal(Buffer.from(parts[2]), Buffer.from(hmac('bilet.' + parts[1]).toString('base64url')))) return null;
  try {
    const t = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const id = (value) => Number.isSafeInteger(value) && value > 0;
    if (!t || t.v !== 1 || !id(t.emp) || !(t.by === null || id(t.by)) || !id(t.x) ||
        typeof t.s !== 'string' || typeof t.e !== 'string' || typeof t.n !== 'string' || !/^[a-f0-9]{32}$/.test(t.n)) return null;
    return t;
  } catch {
    return null;
  }
}

function verifyCallback(zaman, imza, raw) {
  if (!enabled() || !/^\d+$/.test(zaman) || Math.abs(Math.floor(Date.now() / 1000) - Number(zaman)) > 300 ||
      typeof imza !== 'string' || !/^[a-fA-F0-9]{64}$/.test(imza)) return false;
  return equal(Buffer.from(imza, 'hex'), hmac('kayit.' + zaman + '.', raw));
}

function viewUrl(id, ttlSec) {
  if (!enabled() || typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return null;
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = hmac('gor.' + id + '.' + exp).toString('base64url');
  return process.env.IK_BELGE_URL + '/b/' + id + '?x=' + exp + '&s=' + sig;
}

module.exports = { enabled, signTicket, verifyTicket, verifyCallback, viewUrl };
