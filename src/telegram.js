'use strict';

/**
 * PDKS Telegram bildirim botu (AI yok, yalnizca bildirim + buton).
 * - Kayit: bota erisim kodunu (TELEGRAM_JOIN_CODE) gonderen sohbet aboneligi alir.
 * - 08:33 yoklamasi: hala gelmeyen aktif personel listesi abonelere gider (pazar haric).
 * - Gec gelen giris yapinca "X geldi (Y dk gec)" + "Mucbir sebep isaretle" butonu.
 *   Ilk basan gecerli; ikinci basana "Ilk kisi secti zaten" denir.
 *   Mucbir isaretli girisin gecikmesi raporda 0 sayilir (maas kesintisine yansimaz).
 */

const { db, logAction } = require('./db');
const T = require('./time');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const JOIN_CODE = (process.env.TELEGRAM_JOIN_CODE || '').trim();
const API = `https://api.telegram.org/bot${TOKEN}`;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function api(method, payload) {
  try {
    const r = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    return await r.json();
  } catch (e) {
    console.error('telegram api hatasi:', method, e.message);
    return null;
  }
}

function subscribers() {
  return db.prepare('SELECT * FROM telegram_subs').all();
}

async function broadcast(text, inlineKeyboard) {
  const extra = { parse_mode: 'HTML' };
  if (inlineKeyboard) extra.reply_markup = { inline_keyboard: inlineKeyboard };
  for (const s of subscribers()) {
    await api('sendMessage', { chat_id: s.chat_id, text, ...extra });
  }
}

// --- Gec gelen bildirimi ---
async function notifyLate(employee, checkinId, ts, lateMinutes) {
  const text = `⏰ <b>${esc(employee.name)}</b> geldi — giriş ${T.fmtTime(new Date(ts))} (${lateMinutes} dk geç)`;
  await broadcast(text, [[{ text: 'Mücbir sebep işaretle', callback_data: 'excuse:' + checkinId }]]);
}

// --- Gelen mesaj / buton islemleri ---
async function handleUpdate(u) {
  if (u.callback_query) {
    const cq = u.callback_query;
    const m = /^excuse:(\d+)$/.exec(cq.data || '');
    if (!m) return api('answerCallbackQuery', { callback_query_id: cq.id });
    const row = db.prepare('SELECT * FROM checkins WHERE id = ?').get(Number(m[1]));
    const who = (cq.from && (cq.from.first_name || cq.from.username)) || 'biri';
    if (!row) {
      return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Kayıt bulunamadı.' });
    }
    if (row.excused) {
      return api('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: `İlk kişi seçti zaten (${row.excused_by || 'bilinmiyor'}).`,
        show_alert: true
      });
    }
    db.prepare('UPDATE checkins SET excused = 1, excused_by = ? WHERE id = ?').run(who, row.id);
    logAction('telegram', 'late_excused', `kayit #${row.id} mucbir — ${who}`);
    await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Mücbir sebep işaretlendi ✓' });
    if (cq.message) {
      await api('editMessageText', {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: (cq.message.text || '') + `\n✅ Mücbir sebep işaretlendi — ${who}. Gecikme maaş kesintisine yansımaz.`
      });
    }
    return null;
  }

  if (u.message && u.message.chat && typeof u.message.text === 'string') {
    const chatId = String(u.message.chat.id);
    const text = u.message.text.trim();
    const known = db.prepare('SELECT 1 FROM telegram_subs WHERE chat_id = ?').get(chatId);
    if (known) {
      return api('sendMessage', { chat_id: chatId, text: 'Kayıtlısınız ✓ Bildirimler otomatik gelir; mesaj yazmanız gerekmez.' });
    }
    const aday = text.replace(/^\/start\s*/i, '').trim();
    if (JOIN_CODE && (aday === JOIN_CODE || text === JOIN_CODE)) {
      const from = u.message.from || {};
      const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || chatId;
      db.prepare('INSERT OR REPLACE INTO telegram_subs (chat_id, name, created_at) VALUES (?, ?, ?)')
        .run(chatId, name, new Date().toISOString());
      logAction('telegram', 'sub_added', `${name} (${chatId})`);
      return api('sendMessage', {
        chat_id: chatId,
        text: `Kayıt tamam, ${name} ✓\nPDKS bildirimleri bu sohbete gelecek:\n• 08:33 yoklaması (gelmeyenler)\n• Geç gelen personel + mücbir sebep butonu`
      });
    }
    return api('sendMessage', { chat_id: chatId, text: 'PDKS bildirim botu. Kayıt olmak için erişim kodunu gönderin.' });
  }
  return null;
}

// --- Uzun sorgulama dongusu ---
let offset = 0;
async function poll() {
  const r = await api('getUpdates', { timeout: 25, offset, allowed_updates: ['message', 'callback_query'] });
  if (r && r.ok) {
    for (const u of r.result) {
      offset = u.update_id + 1;
      try { await handleUpdate(u); } catch (e) { console.error('telegram update hatasi:', e.message); }
    }
  }
  setTimeout(poll, r && r.ok ? 300 : 5000);
}

// --- 08:33 yoklamasi (pazar haric, gunde bir kez; tekrar deploy'da mukerrer gondermez) ---
function morningTick() {
  const now = new Date();
  const hm = T.fmtTime(now);
  if (hm < '08:33') return;
  const day = T.businessDay(now);
  const [y, mo, d] = day.split('-').map(Number);
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === 0) return; // pazar
  const done = db.prepare("SELECT 1 FROM audit_log WHERE action = 'morning_report' AND detail = ? LIMIT 1").get(day);
  if (done) return;
  logAction('telegram', 'morning_report', day);
  const service = require('./service');
  const ov = service.dayOverview(day);
  const yok = ov.absent.map((r) => r.employee.name);
  const text = yok.length
    ? `📋 <b>08:33 yoklaması</b> — henüz gelmeyenler (${yok.length}):\n` + yok.map((n) => '• ' + esc(n)).join('\n')
    : '📋 <b>08:33 yoklaması</b> — herkes geldi ✅';
  broadcast(text).catch((e) => console.error('yoklama gonderilemedi:', e.message));
}

function start() {
  if (!TOKEN) {
    console.log('Telegram botu kapali (TELEGRAM_BOT_TOKEN yok).');
    return;
  }
  poll();
  setInterval(morningTick, 30000);
  console.log('Telegram botu aktif (bildirim + mucbir butonu).');
}

module.exports = { start, notifyLate };
