'use strict';

// Duvardaki QR'in icerigi: link DEGIL, lokasyona ozel imzali kod.
// Telefon kamerasi bu kodu acamaz; yalnizca sitedeki okuyucu dogrular.
const crypto = require('crypto');

const QR_KEY = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'pdks-qr';

function qrContent(slug) {
  const sig = crypto.createHmac('sha256', QR_KEY).update('loc:' + slug).digest('hex').slice(0, 16);
  return `PDKS|${slug}|${sig}`;
}

function qrValid(code, slug) {
  if (typeof code !== 'string' || code.length > 128) return false;
  const expected = qrContent(slug);
  return code.length === expected.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected));
}

module.exports = { qrContent, qrValid };
