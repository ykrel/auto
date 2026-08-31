'use strict';

const crypto = require('crypto');

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// 0532 123 45 67 / +90 532 ... -> 05321234567
function normalizePhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D+/g, '');
  if (digits.startsWith('90') && digits.length === 12) digits = digits.slice(2);
  if (digits.length === 10 && !digits.startsWith('0')) digits = '0' + digits;
  return digits;
}

function validPhone(phone) {
  return /^0[1-9][0-9]{9}$/.test(phone);
}

function newToken() {
  return crypto.randomUUID();
}

function slugify(text) {
  const map = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', İ: 'i', Ç: 'c', Ğ: 'g', Ö: 'o', Ş: 's', Ü: 'u' };
  return String(text || '')
    .split('')
    .map((ch) => map[ch] || ch)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function cleanName(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function validShift(hhmm) {
  return !hhmm || /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(hhmm);
}

// Basit bellek ici pencere sayaci: anahtar basina limit/pencere
function createRateLimiter({ limit = 5, windowMs = 60000 } = {}) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, list] of hits) {
      const kept = list.filter((t) => now - t < windowMs);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
  }, windowMs).unref();

  return function check(key) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= limit) {
      hits.set(key, list);
      return { ok: false, retryAfter: Math.ceil((windowMs - (now - list[0])) / 1000) };
    }
    list.push(now);
    hits.set(key, list);
    return { ok: true };
  };
}

module.exports = {
  haversineMeters,
  normalizePhone,
  validPhone,
  newToken,
  slugify,
  cleanName,
  validShift,
  createRateLimiter
};
