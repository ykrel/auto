'use strict';

// Duvardaki QR'in icerigi: link DEGIL, lokasyona ozel imzali kod.
// Telefon kamerasi bu kodu acamaz; yalnizca sitedeki okuyucu dogrular.
const crypto = require('crypto');

// QR imza anahtari oturum anahtarindan ayri tutulabilir (QR_SECRET): SESSION_SECRET degisince duvardaki
// basili QR'lar gecersiz olmasin (Kagan 22.10). Tanimli degilse eskisi gibi SESSION_SECRET kullanilir.
const QR_KEY = process.env.QR_SECRET || process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'pdks-qr';

function qrContent(slug) {
  const sig = crypto.createHmac('sha256', QR_KEY).update('loc:' + slug).digest('hex').slice(0, 16);
  return `PDKS|${slug}|${sig}`;
}

function qrValid(code, slug) {
  if (typeof code !== 'string' || code.length > 128) return false;
  const expected = qrContent(slug);
  return code.length === expected.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected));
}

// Okutulan koddaki lokasyon (imza dogruysa slug, degilse null).
// Kayit hangi binanin QR'i okutulduysa oraya yazilir; personelin actigi link (sayfa slug'i) belirleyici degil.
function qrSlug(code) {
  if (typeof code !== 'string' || code.length > 128) return null;
  const m = /^PDKS\|([a-z0-9-]+)\|[0-9a-f]{16}$/.exec(code);
  return m && qrValid(code, m[1]) ? m[1] : null;
}

module.exports = { qrContent, qrValid, qrSlug };
