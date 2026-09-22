'use strict';

// Tum kayitlar UTC tutulur; gosterim Europe/Istanbul.
// Gun tanimi: yerel saatle 04:00 - ertesi gun 04:00.

const TZ = 'Europe/Istanbul';
const DAY_START_HOUR = 4;
// Mesai baslangicindan sonraki ilk N dakika gec sayilmaz (env: LATE_TOLERANCE_MIN).
// Tolerans asilirsa gecikme bastan itibaren tam olarak sayilir.
const LATE_TOLERANCE_MIN = Number.isFinite(Number(process.env.LATE_TOLERANCE_MIN))
  ? Number(process.env.LATE_TOLERANCE_MIN)
  : 10;
// Mesai bitisinden onceki son N dakikada okutulan cikis "erken cikis" bildirimi uretmez
// (env: EARLY_EXIT_TOLERANCE_MIN). Tolerans asilirsa erken dakika bastan itibaren tam sayilir.
const EARLY_EXIT_TOLERANCE_MIN = Number.isFinite(Number(process.env.EARLY_EXIT_TOLERANCE_MIN))
  ? Number(process.env.EARLY_EXIT_TOLERANCE_MIN)
  : 5;
// Mesai bitisi (HH:MM). Aksam yoklamasi bunun 5 dk sonrasinda gider, elle cikis girerken
// varsayilan saat budur. Cumartesi is yeri erken kapandigi icin ayri.
const SHIFT_END = /^\d{2}:\d{2}$/.test(process.env.SHIFT_END || '') ? process.env.SHIFT_END : '18:30';
const SHIFT_END_SAT = /^\d{2}:\d{2}$/.test(process.env.SHIFT_END_SAT || '') ? process.env.SHIFT_END_SAT : '17:00';

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

function localParts(date) {
  const p = {};
  for (const part of partsFmt.formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  // Intl bazi ortamlarda gece yarisini "24" olarak verir
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour,
    minute: Number(p.minute),
    second: Number(p.second)
  };
}

// Verilen an icin Europe/Istanbul UTC ofseti (ms)
function tzOffsetMs(date) {
  const p = localParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const whole = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - whole;
}

// Yerel duvar saatini UTC Date'e cevirir
function localToUtc(year, month, day, hour = 0, minute = 0, second = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = tzOffsetMs(new Date(guess));
  let result = new Date(guess - offset);
  // Ofset degisimi (DST) ihtimaline karsi bir kez daha duzelt
  offset = tzOffsetMs(result);
  result = new Date(guess - offset);
  return result;
}

const pad = (n) => String(n).padStart(2, '0');

function fmtDate(date) {
  const p = localParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function fmtTime(date) {
  const p = localParts(date);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

function fmtDateTime(date) {
  return `${fmtDate(date)} ${fmtTime(date)}`;
}

function fmtDateTR(dayStr) {
  if (!dayStr) return '';
  const [y, m, d] = dayStr.split('-');
  return `${d}.${m}.${y}`;
}

// datetime-local input degeri (yerel saat)
function fmtInputDateTime(date) {
  const p = localParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// Bir anin ait oldugu is gunu (YYYY-MM-DD). 04:00 oncesi onceki gune sayilir.
function businessDay(date) {
  const shifted = new Date(date.getTime() - DAY_START_HOUR * 3600 * 1000);
  return fmtDate(shifted);
}

function todayBusinessDay(now = new Date()) {
  return businessDay(now);
}

// Is gununun UTC araligi [start, end)
function businessDayRange(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const start = localToUtc(y, m, d, DAY_START_HOUR, 0, 0);
  const end = new Date(start.getTime());
  // Ertesi gunun 04:00'i (DST guvenli)
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const nextParts = { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() };
  const endUtc = localToUtc(nextParts.y, nextParts.m, nextParts.d, DAY_START_HOUR, 0, 0);
  end.setTime(endUtc.getTime());
  return { start: start.toISOString(), end: end.toISOString() };
}

// Tarih araligi (gun bazli, is gunu mantigiyla) -> UTC araligi
function rangeToUtc(fromDay, toDay) {
  const a = businessDayRange(fromDay);
  const b = businessDayRange(toDay);
  return { start: a.start, end: b.end };
}

function addDays(dayStr, n) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// 0 pazar ... 6 cumartesi
function weekdayOf(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function shiftEndFor(dayStr) {
  return weekdayOf(dayStr) === 6 ? SHIFT_END_SAT : SHIFT_END;
}

// "HH:MM" + n dakika (gun icinde doner)
function addMinutesHM(hhmm, n) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = (((h * 60 + m + n) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

// Kullanicinin yazdigi saati "HH:MM"e cevirir: "18:30", "1830", "18.30", "18,30", "18"
function parseHM(text) {
  const s = String(text == null ? '' : text).trim();
  let hh = null;
  let mm = null;
  let m = /^(\d{1,2})\s*[:.,\s-]\s*(\d{1,2})$/.exec(s);
  if (m) {
    hh = Number(m[1]);
    mm = Number(m[2]);
  } else if ((m = /^(\d{3,4})$/.exec(s))) {
    hh = Number(m[1].slice(0, m[1].length - 2));
    mm = Number(m[1].slice(-2));
  } else if ((m = /^(\d{1,2})$/.exec(s))) {
    hh = Number(m[1]);
    mm = 0;
  }
  if (hh == null || hh > 23 || mm > 59) return null;
  return `${pad(hh)}:${pad(mm)}`;
}

function eachDay(fromDay, toDay) {
  const days = [];
  let cur = fromDay;
  let guard = 0;
  while (cur <= toDay && guard < 1000) {
    days.push(cur);
    cur = addDays(cur, 1);
    guard++;
  }
  return days;
}

// "HH:MM" mesai baslangicini o is gununde UTC ana cevirir.
// 04:00'ten kucuk saatler ertesi takvim gunune denk gelir (gece vardiyasi).
function shiftStartUtc(dayStr, hhmm) {
  if (!hhmm) return null;
  const [hh, mm] = hhmm.split(':').map(Number);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  const target = hh < DAY_START_HOUR ? addDays(dayStr, 1) : dayStr;
  const [y, m, d] = target.split('-').map(Number);
  return localToUtc(y, m, d, hh, mm, 0);
}

// Bir girisin gec kalma dakikasi (tolerans icinde 0).
function lateMinutesFor(dayStr, hhmm, tsIso) {
  const start = shiftStartUtc(dayStr, hhmm);
  if (!start) return 0;
  const diff = minutesBetween(start.toISOString(), tsIso);
  return diff > LATE_TOLERANCE_MIN ? diff : 0;
}

// Bir cikisin mesai bitisinden kac dakika erken oldugu (tolerans icinde ya da mesai sonrasi 0).
// Mesai bitisi verilmezse o gunun bitisi (shiftEndFor) kullanilir.
function earlyMinutesFor(dayStr, tsIso, hhmm) {
  const end = shiftStartUtc(dayStr, hhmm || shiftEndFor(dayStr));
  if (!end) return 0;
  const diff = minutesBetween(tsIso, end.toISOString());
  return diff > EARLY_EXIT_TOLERANCE_MIN ? diff : 0;
}

function minutesBetween(aIso, bIso) {
  return Math.round((new Date(bIso).getTime() - new Date(aIso).getTime()) / 60000);
}

function fmtDuration(minutes) {
  if (minutes == null) return '';
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(abs / 60)}:${pad(abs % 60)}`;
}

module.exports = {
  TZ,
  DAY_START_HOUR,
  LATE_TOLERANCE_MIN,
  EARLY_EXIT_TOLERANCE_MIN,
  SHIFT_END,
  SHIFT_END_SAT,
  lateMinutesFor,
  earlyMinutesFor,
  weekdayOf,
  shiftEndFor,
  addMinutesHM,
  parseHM,
  localParts,
  localToUtc,
  fmtDate,
  fmtTime,
  fmtDateTime,
  fmtDateTR,
  fmtInputDateTime,
  businessDay,
  todayBusinessDay,
  businessDayRange,
  rangeToUtc,
  addDays,
  eachDay,
  shiftStartUtc,
  dayTimeUtc: shiftStartUtc,
  minutesBetween,
  fmtDuration
};
