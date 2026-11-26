'use strict';

const crypto = require('crypto');
const { db } = require('./db');

const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const cookie = { path: '/yonetim', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' };
const secret = process.env.SESSION_SECRET || crypto.randomBytes(32);

function approvers() {
  return new Set((process.env.IZIN_ONAYCILAR || '').split(',').map((s) => s.trim()).filter(Boolean));
}

function approverName(chatId, botKey) {
  const sub = db.prepare(`SELECT name FROM telegram_subs WHERE chat_id = ? AND name IS NOT NULL AND name != ''
    ORDER BY bot = ? DESC, bot LIMIT 1`).get(chatId, botKey);
  return sub ? sub.name : chatId;
}

function issueLink(chatId, name) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO panel_links (token, chat_id, name, expires_at) VALUES (?, ?, ?, ?)').run(token, chatId, name, expires);
  const base = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
  return base + '/yonetim/giris?t=' + token;
}

function signature(body) {
  return crypto.createHmac('sha256', secret).update('yonetim:' + body).digest('base64url');
}

const consume = db.transaction((token) => {
  const now = new Date().toISOString();
  const row = db.prepare('SELECT * FROM panel_links WHERE token = ? AND used_at IS NULL AND expires_at > ?').get(token, now);
  if (!row || !approvers().has(row.chat_id)) return null;
  db.prepare('UPDATE panel_links SET used_at = ? WHERE token = ?').run(now, token);
  const session = { chat: row.chat_id, name: row.name, exp: Date.now() + MAX_AGE, csrf: crypto.randomBytes(32).toString('hex') };
  const body = Buffer.from(JSON.stringify(session)).toString('base64url');
  return body + '.' + signature(body);
}).immediate;

function sessionOf(raw) {
  if (typeof raw !== 'string') return null;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(raw);
  if (!match || !crypto.timingSafeEqual(Buffer.from(match[2]), Buffer.from(signature(match[1])))) return null;
  const session = JSON.parse(Buffer.from(match[1], 'base64url').toString());
  return session.exp > Date.now() && approvers().has(session.chat) ? session : null;
}

module.exports = { approvers, approverName, issueLink, consume, sessionOf, cookie, MAX_AGE };
