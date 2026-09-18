'use strict';

/**
 * PDKS Telegram bildirim botu (AI yok, yalnizca bildirim + buton).
 * - Kayit: bota erisim kodunu (TELEGRAM_JOIN_CODE) gonderen sohbet aboneligi alir.
 * - 08:33 yoklamasi: hala gelmeyen aktif personel listesi abonelere gider (pazar haric);
 *   izinli personel ayri bolumde "izinli" etiketiyle listelenir, gelmeyen sayilmaz.
 * - Gec gelen giris yapinca "X geldi (Y dk gec)" + "Mucbir sebep isaretle" butonu.
 *   Ilk basan gecerli; ikinci basana "Ilk kisi secti zaten" denir.
 *   Mucbir isaretli girisin gecikmesi raporda 0 sayilir (maas kesintisine yansimaz).
 * - Erken cikis: mesai bitisinden once cikan olunca aninda bildirim + "Saati duzelt" butonu.
 * - Aksam yoklamasi: mesai bitisinden 5 dk sonra hala cikis yapmayanlar listelenir; her kisi icin
 *   tek dokunusla mesai bitis saati girilir ya da klavye butonuyla baska saat yazilir.
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

// --- Erken cikis bildirimi ---
async function notifyEarlyExit(employee, checkin, shiftEnd, earlyMinutes) {
  const text =
    `🚪 <b>${esc(employee.name)}</b> çıkış yaptı — ${T.fmtTime(new Date(checkin.ts))}\n` +
    `Mesai bitişi ${shiftEnd}, <b>${earlyMinutes} dk erken</b>.`;
  await broadcast(text, [[{ text: '🕐 Saati düzelt', callback_data: 'fixout:' + checkin.id }]]);
}

// --- Telegram'dan cikis kaydi yazma/duzeltme ---
// Cikisi hic olmayan gune yeni kayit ekler.
function addExit(employeeId, day, hhmm, who) {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!emp) return { ok: false, msg: 'Personel bulunamadı.' };
  const range = T.businessDayRange(day);
  const last = db
    .prepare('SELECT * FROM checkins WHERE employee_id = ? AND ts >= ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1')
    .get(employeeId, range.start, range.end);
  if (!last) return { ok: false, msg: `${emp.name} o gün hiç giriş yapmamış — panelden girilmeli.` };
  if (last.type === 'out') {
    return { ok: false, msg: `${emp.name} için çıkış zaten var (${T.fmtTime(new Date(last.ts))}).` };
  }
  const when = T.dayTimeUtc(day, hhmm);
  if (!when) return { ok: false, msg: 'Saat geçersiz.' };
  if (when.getTime() <= new Date(last.ts).getTime()) {
    return { ok: false, msg: `Çıkış, girişten (${T.fmtTime(new Date(last.ts))}) sonra olmalı.` };
  }
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT INTO checkins (employee_id, location_id, type, ts, business_day, flagged, flag_reason, source, created_at, edited_by, edited_at)
       VALUES (?, ?, 'out', ?, ?, 0, NULL, 'manual', ?, ?, ?)`
    )
    .run(employeeId, emp.location_id, when.toISOString(), T.businessDay(when), now, 'telegram:' + who, now);
  logAction('telegram', 'checkin_manual_add', `personel #${employeeId} out ${T.fmtDateTime(when)} — ${who}`);
  return { ok: true, id: res.lastInsertRowid, msg: `✓ ${emp.name} — ${T.fmtDateTR(day)} çıkış ${hhmm} kaydedildi.` };
}

// Var olan cikis kaydinin saatini degistirir (erken cikis duzeltmesi).
function fixExit(checkinId, hhmm, who) {
  const row = db
    .prepare('SELECT c.*, e.name AS emp_name FROM checkins c JOIN employees e ON e.id = c.employee_id WHERE c.id = ?')
    .get(checkinId);
  if (!row) return { ok: false, msg: 'Kayıt bulunamadı.' };
  if (row.type !== 'out') return { ok: false, msg: 'Bu bir çıkış kaydı değil.' };
  const when = T.dayTimeUtc(row.business_day, hhmm);
  if (!when) return { ok: false, msg: 'Saat geçersiz.' };
  const range = T.businessDayRange(row.business_day);
  const prevIn = db
    .prepare("SELECT * FROM checkins WHERE employee_id = ? AND type = 'in' AND ts >= ? AND ts < ? AND ts < ? ORDER BY ts DESC LIMIT 1")
    .get(row.employee_id, range.start, range.end, row.ts);
  if (prevIn && when.getTime() <= new Date(prevIn.ts).getTime()) {
    return { ok: false, msg: `Çıkış, girişten (${T.fmtTime(new Date(prevIn.ts))}) sonra olmalı.` };
  }
  const eski = T.fmtTime(new Date(row.ts));
  const now = new Date().toISOString();
  db.prepare("UPDATE checkins SET ts = ?, business_day = ?, edited_by = ?, edited_at = ? WHERE id = ?")
    .run(when.toISOString(), T.businessDay(when), 'telegram:' + who, now, row.id);
  logAction('telegram', 'checkin_edit', `kayit #${row.id}: ${eski} -> ${hhmm} (out) — ${who}`);
  return { ok: true, msg: `✓ ${row.emp_name} — ${T.fmtDateTR(row.business_day)} çıkış ${eski} → <b>${hhmm}</b> düzeltildi.` };
}

// --- Cihaz bildirimleri (otomatik cihaz onayi, 2026-09-09) ---
async function notifyDeviceAdded(employee, label, activeCount) {
  await broadcast(`📱 <b>${esc(employee.name)}</b> yeni cihaz ekledi (${esc(label)}) — aktif cihaz: ${activeCount}`);
}

async function notifyDeviceHeld(employee, label, reason) {
  await broadcast(`⏸ <b>${esc(employee.name)}</b> cihaz talebi onaya düştü (${esc(label)}): ${esc(reason)}. Panel → Personel.`);
}

async function notifySharedDevice(employee, others, label) {
  await broadcast(
    `⚠️ <b>Ortak telefon:</b> ${esc(employee.name)} okuttu (${esc(label)}); aynı telefon şu personelde de kayıtlı: <b>${esc(others.join(', '))}</b>`
  );
}

// --- Gelen mesaj / buton islemleri ---
function whoOf(from) {
  return (from && (from.first_name || from.username)) || 'biri';
}

// Saat soran mesaj: cevabi yakalayabilmek icin metne kayit isareti gomulur
//   "@<checkinId>"        -> var olan cikisin saatini duzelt
//   "#<empId>/<gun>"      -> o gune cikis kaydi ekle
async function askTime(chatId, text) {
  return api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: { force_reply: true } });
}

async function handleCallback(cq) {
  const data = cq.data || '';
  const who = whoOf(cq.from);
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  let m;

  if ((m = /^excuse:(\d+)$/.exec(data))) {
    const row = db.prepare('SELECT * FROM checkins WHERE id = ?').get(Number(m[1]));
    if (!row) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Kayıt bulunamadı.' });
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

  // Erken cikisin saatini duzelt
  if ((m = /^fixout:(\d+)$/.exec(data))) {
    const row = db
      .prepare('SELECT c.*, e.name AS emp_name FROM checkins c JOIN employees e ON e.id = c.employee_id WHERE c.id = ?')
      .get(Number(m[1]));
    if (!row) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Kayıt bulunamadı.' });
    await api('answerCallbackQuery', { callback_query_id: cq.id });
    return askTime(
      chatId,
      `🕐 <b>${esc(row.emp_name)}</b> — ${T.fmtDateTR(row.business_day)} çıkışı şu an <b>${T.fmtTime(new Date(row.ts))}</b>.\n` +
        `Doğru saati yazın (örn. 18:30). @${row.id}`
    );
  }

  // Cikis yapmayana tek dokunusla mesai bitis saati
  if ((m = /^out:(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data))) {
    const day = m[2];
    const r = addExit(Number(m[1]), day, T.shiftEndFor(day), who);
    await api('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: r.msg.replace(/<[^>]+>/g, ''),
      show_alert: !r.ok
    });
    if (r.ok && chatId) await api('sendMessage', { chat_id: chatId, text: r.msg + ` (${who})`, parse_mode: 'HTML' });
    return null;
  }

  // Cikis yapmayana elle saat
  if ((m = /^outask:(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data))) {
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(m[1]));
    if (!emp) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Personel bulunamadı.' });
    const day = m[2];
    await api('answerCallbackQuery', { callback_query_id: cq.id });
    return askTime(
      chatId,
      `🕐 <b>${esc(emp.name)}</b> — ${T.fmtDateTR(day)} çıkış saatini yazın.\n` +
        `Mesai bitişi ${T.shiftEndFor(day)}. #${emp.id}/${day}`
    );
  }

  return api('answerCallbackQuery', { callback_query_id: cq.id });
}

// force_reply ile sorulan saate gelen cevap
async function handleTimeReply(u) {
  const src = (u.message.reply_to_message && u.message.reply_to_message.text) || '';
  const fix = /@(\d+)/.exec(src);
  const add = /#(\d+)\/(\d{4}-\d{2}-\d{2})/.exec(src);
  if (!fix && !add) return false;
  const chatId = String(u.message.chat.id);
  const hhmm = T.parseHM(u.message.text);
  if (!hhmm) {
    await api('sendMessage', { chat_id: chatId, text: 'Saati anlayamadım. Örnek: 18:30' });
    return true;
  }
  const who = whoOf(u.message.from);
  const r = fix ? fixExit(Number(fix[1]), hhmm, who) : addExit(Number(add[1]), add[2], hhmm, who);
  await api('sendMessage', { chat_id: chatId, text: r.ok ? r.msg + ` (${who})` : '⚠️ ' + r.msg, parse_mode: 'HTML' });
  return true;
}

async function handleUpdate(u) {
  if (u.callback_query) return handleCallback(u.callback_query);

  if (u.message && u.message.chat && typeof u.message.text === 'string') {
    const chatId = String(u.message.chat.id);
    const text = u.message.text.trim();
    if (u.message.reply_to_message && (await handleTimeReply(u))) return null;
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
        text:
          `Kayıt tamam, ${name} ✓\nPDKS bildirimleri bu sohbete gelecek:\n` +
          `• 08:33 yoklaması (gelmeyenler)\n• Geç gelen personel + mücbir sebep butonu\n` +
          `• Erken çıkan personel + saat düzeltme\n• Akşam yoklaması (çıkış okutmayanlar)`
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
  const text = morningText(service.dayOverview(day));
  broadcast(text).catch((e) => console.error('yoklama gonderilemedi:', e.message));
}

// Yoklama metni: gelmeyenler (aranacaklar) + izinliler ayri, "izinli" etiketiyle
function morningText(ov) {
  const yok = ov.absent.map((r) => r.employee.name);
  const izin = (ov.onLeave || []).map((r) => r.employee.name);
  let text = yok.length
    ? `📋 <b>08:33 yoklaması</b> — henüz gelmeyenler (${yok.length}):\n` + yok.map((n) => '• ' + esc(n)).join('\n')
    : `📋 <b>08:33 yoklaması</b> — ${izin.length ? 'izinliler hariç ' : ''}herkes geldi ✅`;
  if (izin.length) {
    text += `\n\n🏖 <b>İzinli</b> (${izin.length}):\n` + izin.map((n) => '• ' + esc(n) + ' — izinli').join('\n');
  }
  return text;
}

// --- Aksam yoklamasi: mesai bitisi + 5 dk, hala cikis yapmayanlar (pazar haric, gunde bir kez) ---
function eveningTick() {
  const now = new Date();
  const day = T.businessDay(now);
  if (T.weekdayOf(day) === 0) return; // pazar
  const end = T.shiftEndFor(day);
  const trigger = T.addMinutesHM(end, 5);
  const hm = T.fmtTime(now);
  // Gec baslayan konteyner gece yarisi eski gunun raporunu atmasin diye ust sinir
  if (hm < trigger || hm > T.addMinutesHM(trigger, 180)) return;
  const done = db.prepare("SELECT 1 FROM audit_log WHERE action = 'evening_report' AND detail = ? LIMIT 1").get(day);
  if (done) return;
  logAction('telegram', 'evening_report', day);
  const service = require('./service');
  eveningSend(service.dayOverview(day), day, end, trigger).catch((e) =>
    console.error('aksam yoklamasi gonderilemedi:', e.message)
  );
}

async function eveningSend(ov, day, end, trigger) {
  const inside = ov.present;
  if (!inside.length) {
    await broadcast(`🌙 <b>${trigger} akşam yoklaması</b> — herkes çıkış yaptı ✅`);
    return;
  }
  const lines = inside.map((r) => `• <b>${esc(r.employee.name)}</b> — giriş ${r.inTime || '—'}`);
  const text =
    `🌙 <b>${trigger} akşam yoklaması</b> — çıkış okutmayan ${inside.length} kişi:\n` +
    lines.join('\n') +
    `\n\nİsme basınca çıkış <b>${end}</b> olarak kaydedilir; başka saat için ⌨ düğmesini kullanın.`;
  const kb = inside.slice(0, 10).map((r) => [
    { text: `${r.employee.name} → ${end}`, callback_data: `out:${r.employee.id}:${day}` },
    { text: '⌨', callback_data: `outask:${r.employee.id}:${day}` }
  ]);
  await broadcast(text, kb);
}

function start() {
  if (!TOKEN) {
    console.log('Telegram botu kapali (TELEGRAM_BOT_TOKEN yok).');
    return;
  }
  poll();
  setInterval(morningTick, 30000);
  setInterval(eveningTick, 30000);
  console.log('Telegram botu aktif (bildirim + mucbir/cikis butonlari).');
}

module.exports = {
  start,
  notifyLate,
  handleUpdate,
  eveningSend,
  notifyEarlyExit,
  morningText,
  eveningTick,
  addExit,
  fixExit,
  notifyDeviceAdded,
  notifyDeviceHeld,
  notifySharedDevice
};
