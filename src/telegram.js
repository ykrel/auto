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
 * - Birden cok lokasyon (2026-10-22, Uretim): yoklamalar lokasyon basina ayri mesajdir, saatleri
 *   lokasyonun mesaisine gore isler. Lokasyonun kendi botu olabilir (env TELEGRAM_BOT_TOKEN_<SLUG>,
 *   orn. TELEGRAM_BOT_TOKEN_URETIM): o lokasyonun bildirimleri yalniz o bottan, o botun abonelerine gider.
 *   Botu olmayan lokasyonlar ana bottan gider. Abonelik her botta ayri (ayni erisim kodu).
 */

const { db, logAction } = require('./db');
const T = require('./time');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const JOIN_CODE = (process.env.TELEGRAM_JOIN_CODE || '').trim();
const MAIN = { key: 'main', token: TOKEN, location: null, offset: 0 };

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function api(method, payload, bot = MAIN) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${bot.token}/${method}`, {
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

// --- Botlar: ana bot + kendi tokeni tanimli lokasyonlarin botlari ---
const locationBots = new Map(); // slug -> bot (offset korunur)

function locationBot(location) {
  if (!location || !location.slug) return null;
  const token = process.env['TELEGRAM_BOT_TOKEN_' + location.slug.toUpperCase().replace(/-/g, '_')] || '';
  if (!token) return null;
  let bot = locationBots.get(location.slug);
  if (!bot || bot.token !== token) {
    bot = { key: location.slug, token, location, offset: 0 };
    locationBots.set(location.slug, bot);
  }
  bot.location = location;
  return bot;
}

// Lokasyonun bildirimleri hangi bottan gider (kendi botu yoksa ana bot)
function botFor(locationId) {
  if (!locationId) return MAIN;
  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(locationId);
  return locationBot(loc) || MAIN;
}

function allBots() {
  const bots = MAIN.token ? [MAIN] : [];
  for (const loc of db.prepare('SELECT * FROM locations WHERE active = 1').all()) {
    const b = locationBot(loc);
    if (b) bots.push(b);
  }
  return bots;
}

function subscribers(bot) {
  return db.prepare('SELECT * FROM telegram_subs WHERE bot = ?').all(bot.key);
}

async function broadcast(text, inlineKeyboard, locationId) {
  const bot = botFor(locationId);
  if (!bot.token) return;
  const extra = { parse_mode: 'HTML' };
  if (inlineKeyboard) extra.reply_markup = { inline_keyboard: inlineKeyboard };
  for (const s of subscribers(bot)) {
    await api('sendMessage', { chat_id: s.chat_id, text, ...extra }, bot);
  }
}

// --- Lokasyon yardimcilari ---
// Aktif personeli olan acik lokasyonlar (yoklamalar bunlar icin gider)
function activeLocations() {
  return db
    .prepare(
      `SELECT DISTINCT l.* FROM locations l JOIN employees e ON e.location_id = l.id
       WHERE l.active = 1 AND e.status = 'active' ORDER BY l.id`
    )
    .all();
}

function locationOf(employee) {
  return employee && employee.location_id
    ? db.prepare('SELECT * FROM locations WHERE id = ?').get(employee.location_id)
    : null;
}

// Ana botu birden cok lokasyon paylasiyorsa mesaja " · <lokasyon>" eklenir. Tek lokasyonda ya da
// lokasyonun kendi botu varsa (bot adi zaten soyler) metin eskisi gibi kalir.
function locTag(location) {
  if (!location || locationBot(location)) return '';
  const shared = activeLocations().filter((l) => !locationBot(l));
  if (shared.length < 2) return '';
  return ' · ' + esc(location.name);
}

// Yoklama o gun o lokasyon icin gonderildi mi? (Eski kayitlar detail = gun: tum lokasyonlar icin sayilir)
function reportSent(action, day, locationId) {
  return !!db
    .prepare('SELECT 1 FROM audit_log WHERE action = ? AND (detail = ? OR detail = ?) LIMIT 1')
    .get(action, day, `${day} #${locationId || 0}`);
}

// --- Gec gelen bildirimi ---
async function notifyLate(employee, checkinId, ts, lateMinutes) {
  const text = `⏰ <b>${esc(employee.name)}</b> geldi — giriş ${T.fmtTime(new Date(ts))} (${lateMinutes} dk geç)${locTag(locationOf(employee))}`;
  await broadcast(text, [[{ text: 'Mücbir sebep işaretle', callback_data: 'excuse:' + checkinId }]], employee.location_id);
}

// --- Yoklamadan sonra gelen / cikan bildirimi ---
// 08:33 yoklamasinda "gelmedi" gorunup sonradan (tolerans icinde, gec sayilmadan) gelen kisi icin.
async function notifyArrivedAfterReport(employee, ts) {
  await broadcast(
    `✅ <b>${esc(employee.name)}</b> geldi — giriş ${T.fmtTime(new Date(ts))} (yoklamadan sonra)${locTag(locationOf(employee))}`,
    null,
    employee.location_id
  );
}

// Aksam yoklamasinda "cikis okutmayan" listesindeyken sonradan QR ile cikan kisi icin.
async function notifyLeftAfterReport(employee, ts) {
  await broadcast(
    `🚪 <b>${esc(employee.name)}</b> çıkış yaptı — ${T.fmtTime(new Date(ts))} (akşam yoklamasından sonra)${locTag(locationOf(employee))}`,
    null,
    employee.location_id
  );
}

// --- Gun ici geri donus: cikis okuttuktan sonra yeniden giris (Kagan 22.10: gun icinde giren cikan bilinsin) ---
async function notifyReturned(employee, ts, outTs) {
  const dk = T.minutesBetween(outTs, ts);
  await broadcast(
    `↩️ <b>${esc(employee.name)}</b> geri geldi — ${T.fmtTime(new Date(ts))} (çıkış ${T.fmtTime(new Date(outTs))}, ${dk} dk dışarıda)${locTag(locationOf(employee))}`,
    null,
    employee.location_id
  );
}

// --- Erken cikis bildirimi ---
async function notifyEarlyExit(employee, checkin, shiftEnd, earlyMinutes) {
  const text =
    `🚪 <b>${esc(employee.name)}</b> çıkış yaptı — ${T.fmtTime(new Date(checkin.ts))}${locTag(locationOf(employee))}\n` +
    `Mesai bitişi ${shiftEnd}, <b>${earlyMinutes} dk erken</b>.`;
  await broadcast(text, [[{ text: '🕐 Saati düzelt', callback_data: 'fixout:' + checkin.id }]], employee.location_id);
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
  await broadcast(
    `📱 <b>${esc(employee.name)}</b> yeni cihaz ekledi (${esc(label)}) — aktif cihaz: ${activeCount}`,
    null,
    employee.location_id
  );
}

async function notifyDeviceHeld(employee, label, reason) {
  await broadcast(
    `⏸ <b>${esc(employee.name)}</b> cihaz talebi onaya düştü (${esc(label)}): ${esc(reason)}. Panel → Personel.`,
    null,
    employee.location_id
  );
}

async function notifySharedDevice(employee, others, label) {
  await broadcast(
    `⚠️ <b>Ortak telefon:</b> ${esc(employee.name)} okuttu (${esc(label)}); aynı telefon şu personelde de kayıtlı: <b>${esc(others.join(', '))}</b>`,
    null,
    employee.location_id
  );
}

// --- Gelen mesaj / buton islemleri ---
function whoOf(from) {
  return (from && (from.first_name || from.username)) || 'biri';
}

// Abone personele bagliysa (telegram_subs.employee_id) kendi kaydi uzerinde islem yapamaz.
// Uyari bilerek kisa ve sistem mesaji gibi (Kagan 24.10).
const SELF_ERROR = 'err: person cannot be same';

function isSelf(chatId, bot, employeeId) {
  if (!chatId || !employeeId) return false;
  const sub = db.prepare('SELECT employee_id FROM telegram_subs WHERE chat_id = ? AND bot = ?').get(String(chatId), bot.key);
  return !!(sub && sub.employee_id && sub.employee_id === Number(employeeId));
}

// Saat soran mesaj: cevabi yakalayabilmek icin metne kayit isareti gomulur
//   "@<checkinId>"        -> var olan cikisin saatini duzelt
//   "#<empId>/<gun>"      -> o gune cikis kaydi ekle
async function askTime(chatId, text, bot = MAIN) {
  return api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: { force_reply: true } }, bot);
}

async function handleCallback(cq, bot = MAIN) {
  const data = cq.data || '';
  const who = whoOf(cq.from);
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  let m;

  if ((m = /^excuse:(\d+)$/.exec(data))) {
    const row = db.prepare('SELECT * FROM checkins WHERE id = ?').get(Number(m[1]));
    if (!row) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Kayıt bulunamadı.' }, bot);
    if (isSelf(chatId, bot, row.employee_id)) return api('answerCallbackQuery', { callback_query_id: cq.id, text: SELF_ERROR }, bot);
    if (row.excused) {
      return api(
        'answerCallbackQuery',
        { callback_query_id: cq.id, text: `İlk kişi seçti zaten (${row.excused_by || 'bilinmiyor'}).`, show_alert: true },
        bot
      );
    }
    db.prepare('UPDATE checkins SET excused = 1, excused_by = ? WHERE id = ?').run(who, row.id);
    logAction('telegram', 'late_excused', `kayit #${row.id} mucbir — ${who}`);
    await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Mücbir sebep işaretlendi ✓' }, bot);
    if (cq.message) {
      await api(
        'editMessageText',
        {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: (cq.message.text || '') + `\n✅ Mücbir sebep işaretlendi — ${who}. Gecikme maaş kesintisine yansımaz.`
        },
        bot
      );
    }
    return null;
  }

  // Erken cikisin saatini duzelt
  if ((m = /^fixout:(\d+)$/.exec(data))) {
    const row = db
      .prepare('SELECT c.*, e.name AS emp_name FROM checkins c JOIN employees e ON e.id = c.employee_id WHERE c.id = ?')
      .get(Number(m[1]));
    if (!row) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Kayıt bulunamadı.' }, bot);
    if (isSelf(chatId, bot, row.employee_id)) return api('answerCallbackQuery', { callback_query_id: cq.id, text: SELF_ERROR }, bot);
    await api('answerCallbackQuery', { callback_query_id: cq.id }, bot);
    return askTime(
      chatId,
      `🕐 <b>${esc(row.emp_name)}</b> — ${T.fmtDateTR(row.business_day)} çıkışı şu an <b>${T.fmtTime(new Date(row.ts))}</b>.\n` +
        `Doğru saati yazın (örn. 18:30). @${row.id}`,
      bot
    );
  }

  // Cikis yapmayana tek dokunusla mesai bitis saati
  if ((m = /^out:(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data))) {
    const day = m[2];
    if (isSelf(chatId, bot, m[1])) return api('answerCallbackQuery', { callback_query_id: cq.id, text: SELF_ERROR }, bot);
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(m[1]));
    const r = addExit(Number(m[1]), day, T.shiftEndFor(day, locationOf(emp)), who);
    await api(
      'answerCallbackQuery',
      { callback_query_id: cq.id, text: r.msg.replace(/<[^>]+>/g, ''), show_alert: !r.ok },
      bot
    );
    if (r.ok && chatId) await api('sendMessage', { chat_id: chatId, text: r.msg + ` (${who})`, parse_mode: 'HTML' }, bot);
    return null;
  }

  // Cikis yapmayana elle saat
  if ((m = /^outask:(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data))) {
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(m[1]));
    if (!emp) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Personel bulunamadı.' }, bot);
    if (isSelf(chatId, bot, emp.id)) return api('answerCallbackQuery', { callback_query_id: cq.id, text: SELF_ERROR }, bot);
    const day = m[2];
    await api('answerCallbackQuery', { callback_query_id: cq.id }, bot);
    return askTime(
      chatId,
      `🕐 <b>${esc(emp.name)}</b> — ${T.fmtDateTR(day)} çıkış saatini yazın.\n` +
        `Mesai bitişi ${T.shiftEndFor(day, locationOf(emp))}. #${emp.id}/${day}`,
      bot
    );
  }

  return api('answerCallbackQuery', { callback_query_id: cq.id }, bot);
}

// force_reply ile sorulan saate gelen cevap
async function handleTimeReply(u, bot = MAIN) {
  const src = (u.message.reply_to_message && u.message.reply_to_message.text) || '';
  const fix = /@(\d+)/.exec(src);
  const add = /#(\d+)\/(\d{4}-\d{2}-\d{2})/.exec(src);
  if (!fix && !add) return false;
  const chatId = String(u.message.chat.id);
  const hhmm = T.parseHM(u.message.text);
  if (!hhmm) {
    await api('sendMessage', { chat_id: chatId, text: 'Saati anlayamadım. Örnek: 18:30' }, bot);
    return true;
  }
  const who = whoOf(u.message.from);
  const hedef = fix
    ? (db.prepare('SELECT employee_id FROM checkins WHERE id = ?').get(Number(fix[1])) || {}).employee_id
    : Number(add[1]);
  if (isSelf(chatId, bot, hedef)) {
    await api('sendMessage', { chat_id: chatId, text: SELF_ERROR }, bot);
    return true;
  }
  const r = fix ? fixExit(Number(fix[1]), hhmm, who) : addExit(Number(add[1]), add[2], hhmm, who);
  await api('sendMessage', { chat_id: chatId, text: r.ok ? r.msg + ` (${who})` : '⚠️ ' + r.msg, parse_mode: 'HTML' }, bot);
  return true;
}

async function handleUpdate(u, bot = MAIN) {
  if (u.callback_query) return handleCallback(u.callback_query, bot);

  if (u.message && u.message.chat && typeof u.message.text === 'string') {
    const chatId = String(u.message.chat.id);
    const text = u.message.text.trim();
    if (u.message.reply_to_message && (await handleTimeReply(u, bot))) return null;
    const known = db.prepare('SELECT 1 FROM telegram_subs WHERE chat_id = ? AND bot = ?').get(chatId, bot.key);
    if (known) {
      return api(
        'sendMessage',
        { chat_id: chatId, text: 'Kayıtlısınız ✓ Bildirimler otomatik gelir; mesaj yazmanız gerekmez.' },
        bot
      );
    }
    const aday = text.replace(/^\/start\s*/i, '').trim();
    if (JOIN_CODE && (aday === JOIN_CODE || text === JOIN_CODE)) {
      const from = u.message.from || {};
      const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || chatId;
      const yer = bot.location ? ` (${bot.location.name})` : '';
      db.prepare('INSERT OR REPLACE INTO telegram_subs (chat_id, bot, name, created_at) VALUES (?, ?, ?, ?)')
        .run(chatId, bot.key, name, new Date().toISOString());
      logAction('telegram', 'sub_added', `${name} (${chatId}) — bot: ${bot.key}`);
      return api(
        'sendMessage',
        {
          chat_id: chatId,
          text:
            `Kayıt tamam, ${name} ✓\nPDKS bildirimleri${yer} bu sohbete gelecek:\n` +
            `• Sabah yoklaması (gelmeyenler)\n• Geç gelen personel + mücbir sebep butonu\n` +
            `• Erken çıkan personel + saat düzeltme\n• Akşam yoklaması (çıkış okutmayanlar)`
        },
        bot
      );
    }
    return api(
      'sendMessage',
      { chat_id: chatId, text: 'PDKS bildirim botu. Kayıt olmak için erişim kodunu gönderin.' },
      bot
    );
  }
  return null;
}

// --- Uzun sorgulama dongusu ---
// Her bot kendi dongusunde dinlenir; butonlar ve cevaplar geldigi bottan yanitlanir.
async function poll(bot) {
  const r = await api('getUpdates', { timeout: 25, offset: bot.offset, allowed_updates: ['message', 'callback_query'] }, bot);
  if (r && r.ok) {
    for (const u of r.result) {
      bot.offset = u.update_id + 1;
      try { await handleUpdate(u, bot); } catch (e) { console.error('telegram update hatasi:', bot.key, e.message); }
    }
  }
  setTimeout(() => poll(bot), r && r.ok ? 300 : 5000);
}

// --- Sabah yoklamasi: lokasyon basina, mesai baslangici + 3 dk (Merkez 08:33). Lokasyonun calismadigi
// gun (pazar, cumartesi calismayan bina) gitmez; gunde bir kez, tekrar deploy'da mukerrer gondermez ---
const MORNING_DELAY_MIN = 3;

function morningTick() {
  const now = new Date();
  const hm = T.fmtTime(now);
  const day = T.businessDay(now);
  const service = require('./service');
  for (const loc of activeLocations()) {
    if (!T.worksOn(day, loc)) continue;
    const trigger = T.addMinutesHM(loc.shift_start || '08:30', MORNING_DELAY_MIN);
    // Gec acilan konteyner ogleden sonra eski yoklamayi atmasin diye ust sinir
    if (hm < trigger || hm > T.addMinutesHM(trigger, 240)) continue;
    if (reportSent('morning_report', day, loc.id)) continue;
    logAction('telegram', 'morning_report', `${day} #${loc.id}`);
    const text = morningText(service.dayOverview(day, loc.id), loc, trigger);
    broadcast(text, null, loc.id).catch((e) => console.error('yoklama gonderilemedi:', e.message));
  }
}

// Yoklama metni: gelmeyenler (aranacaklar) + izinliler ayri, "izinli" etiketiyle
function morningText(ov, location, trigger = '08:33') {
  const yok = ov.absent.map((r) => r.employee.name);
  const izin = (ov.onLeave || []).map((r) => r.employee.name);
  const baslik = `📋 <b>${trigger} yoklaması</b>${locTag(location)}`;
  let text = yok.length
    ? `${baslik} — henüz gelmeyenler (${yok.length}):\n` + yok.map((n) => '• ' + esc(n)).join('\n')
    : `${baslik} — ${izin.length ? 'izinliler hariç ' : ''}herkes geldi ✅`;
  if (izin.length) {
    text += `\n\n🏖 <b>İzinli</b> (${izin.length}):\n` + izin.map((n) => '• ' + esc(n) + ' — izinli').join('\n');
  }
  return text;
}

// --- Aksam yoklamasi: lokasyon basina mesai bitisi + 5 dk, hala cikis yapmayanlar (gunde bir kez) ---
function eveningTick() {
  const now = new Date();
  const day = T.businessDay(now);
  const hm = T.fmtTime(now);
  const service = require('./service');
  for (const loc of activeLocations()) {
    if (!T.worksOn(day, loc)) continue;
    const end = T.shiftEndFor(day, loc);
    // Lokasyonun kendi aksam yoklama saati varsa o (hafta ici), yoksa mesai bitisi + 5 dk
    const trigger = loc.evening_at && T.weekdayOf(day) !== 6 ? loc.evening_at : T.addMinutesHM(end, 5);
    // Gec baslayan konteyner gece yarisi eski gunun raporunu atmasin diye ust sinir
    if (hm < trigger || hm > T.addMinutesHM(trigger, 180)) continue;
    if (reportSent('evening_report', day, loc.id)) continue;
    logAction('telegram', 'evening_report', `${day} #${loc.id}`);
    eveningSend(service.dayOverview(day, loc.id), day, end, trigger, loc).catch((e) =>
      console.error('aksam yoklamasi gonderilemedi:', e.message)
    );
  }
}

const EVENING_MAX_BUTTONS = 40; // satir basina 2 dugme; Telegram siniri 100 dugme

async function eveningSend(ov, day, end, trigger, location) {
  const locId = location ? location.id : null;
  const baslik = `🌙 <b>${trigger} akşam yoklaması</b>${locTag(location)}`;
  const inside = ov.present;
  const girdi = inside.length + ov.left.length; // bugun giris yapanlar
  if (!girdi) {
    await broadcast(`${baslik} — bugün giriş yapan olmadı`, null, locId);
    return;
  }
  if (!inside.length) {
    await broadcast(`${baslik} — giriş yapan herkes çıkış yaptı ✅ (${girdi} kişi)`, null, locId);
    return;
  }
  const lines = inside.map((r) => `• <b>${esc(r.employee.name)}</b> — giriş ${r.inTime || '—'}`);
  const text =
    `${baslik} — giriş yapan ${girdi} kişiden ${inside.length} kişi çıkış okutmadı:\n` +
    lines.join('\n') +
    `\n\nİsme basınca çıkış <b>${end}</b> olarak kaydedilir; başka saat için ⌨ düğmesini kullanın.`;
  const kb = inside.slice(0, EVENING_MAX_BUTTONS).map((r) => [
    { text: `${r.employee.name} → ${end}`, callback_data: `out:${r.employee.id}:${day}` },
    { text: '⌨', callback_data: `outask:${r.employee.id}:${day}` }
  ]);
  await broadcast(text, kb, locId);
}

function start() {
  const bots = allBots();
  if (!bots.length) {
    console.log('Telegram botu kapali (TELEGRAM_BOT_TOKEN yok).');
    return;
  }
  for (const bot of bots) poll(bot);
  setInterval(morningTick, 30000);
  setInterval(eveningTick, 30000);
  console.log(`Telegram botu aktif (bildirim + mucbir/cikis butonlari): ${bots.map((b) => b.key).join(', ')}`);
}

module.exports = {
  start,
  notifyLate,
  notifyArrivedAfterReport,
  notifyLeftAfterReport,
  notifyReturned,
  handleUpdate,
  eveningSend,
  notifyEarlyExit,
  morningText,
  morningTick,
  eveningTick,
  addExit,
  fixExit,
  notifyDeviceAdded,
  notifyDeviceHeld,
  notifySharedDevice,
  reportSent,
  activeLocations,
  botFor
};
