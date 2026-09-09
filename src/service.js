'use strict';

const { db, logAction } = require('./db');
const T = require('./time');
const { haversineMeters } = require('./util');

const DUPLICATE_WINDOW_MS = 2 * 60 * 1000; // cift okutma koruma penceresi

function shiftStartOf(employee, location) {
  return (employee && employee.shift_start) || (location && location.shift_start) || null;
}

function getLocationBySlug(slug) {
  return db.prepare('SELECT * FROM locations WHERE slug = ?').get(slug);
}

function getLocation(id) {
  return db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
}

function evaluatePosition(location, coords) {
  if (!coords || coords.lat == null || coords.lng == null) {
    return { flagged: 1, flag_reason: 'no_gps', distance: null };
  }
  if (location.lat == null || location.lng == null) {
    // Lokasyon koordinati henuz girilmemis: mesafe dogrulanamaz
    return { flagged: 1, flag_reason: 'no_gps', distance: null };
  }
  const distance = haversineMeters(coords.lat, coords.lng, location.lat, location.lng);
  const radius = location.radius_m || 150;
  if (distance > radius) return { flagged: 1, flag_reason: 'out_of_range', distance };
  return { flagged: 0, flag_reason: null, distance };
}

/**
 * Okutmayi kaydeder.
 * Kayitlar donusumludur: giris → cikis → giris → ... (ayni gun cik-gir desteklenir).
 * Son okutmadan sonraki 2 dk icindeki tekrarlar yok sayilir.
 */
function recordCheckin({ employee, location, coords, source = 'qr', now = new Date(), device = null }) {
  const ts = now.toISOString();
  const day = T.businessDay(now);
  const range = T.businessDayRange(day);
  const pos = evaluatePosition(location, coords);

  const last = db
    .prepare(
      'SELECT * FROM checkins WHERE employee_id = ? AND ts >= ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1'
    )
    .get(employee.id, range.start, range.end);

  if (last && now.getTime() - new Date(last.ts).getTime() < DUPLICATE_WINDOW_MS) {
    return {
      duplicate: true,
      type: last.type,
      ts: last.ts,
      time: T.fmtTime(new Date(last.ts)),
      flagged: !!last.flagged,
      flag_reason: last.flag_reason,
      day
    };
  }

  // Donusumlu tur: ilk okutma giris; son kayit giris ise cikis, cikis ise yeni giris
  const type = !last ? 'in' : last.type === 'in' ? 'out' : 'in';
  const id = db
    .prepare(
      `INSERT INTO checkins
       (employee_id, location_id, type, ts, business_day, lat, lng, accuracy, distance_m, flagged, flag_reason, source, created_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      employee.id,
      location.id,
      type,
      ts,
      day,
      coords ? coords.lat : null,
      coords ? coords.lng : null,
      coords ? coords.accuracy : null,
      pos.distance,
      pos.flagged,
      pos.flag_reason,
      source,
      ts,
      device ? device.id : null
    ).lastInsertRowid;

  return {
    duplicate: false,
    id,
    type,
    ts,
    time: T.fmtTime(now),
    flagged: !!pos.flagged,
    flag_reason: pos.flag_reason,
    distance: pos.distance,
    day
  };
}

// Ardisik giris→cikis ciftlerinin toplam suresi (dk). Acik kalan giris sureye katilmaz.
function pairedMinutes(checks) {
  let total = 0;
  let openIn = null;
  for (const c of checks) {
    if (c.type === 'in') openIn = c;
    else if (c.type === 'out' && openIn) {
      total += T.minutesBetween(openIn.ts, c.ts);
      openIn = null;
    }
  }
  return { total, inside: !!openIn };
}

// Bir is gunu icin personel bazli ozet (admin "Bugun" ekrani)
function dayOverview(day, locationId = null) {
  const range = T.businessDayRange(day);
  let sql = `SELECT e.*, l.name AS location_name, l.shift_start AS location_shift
             FROM employees e LEFT JOIN locations l ON l.id = e.location_id
             WHERE e.status = 'active'`;
  const params = [];
  if (locationId) {
    sql += ' AND e.location_id = ?';
    params.push(locationId);
  }
  sql += ' ORDER BY e.name COLLATE NOCASE';
  const employees = db.prepare(sql).all(...params);
  const leaveSet = new Set(db.prepare('SELECT employee_id FROM leaves WHERE day = ?').all(day).map((r) => r.employee_id));

  const rows = employees.map((emp) => {
    const checks = db
      .prepare('SELECT * FROM checkins WHERE employee_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC')
      .all(emp.id, range.start, range.end);
    const first = checks.find((c) => c.type === 'in') || null;
    const lastOut = [...checks].reverse().find((c) => c.type === 'out') || null;
    const paired = pairedMinutes(checks);
    const shift = emp.shift_start || emp.location_shift || null;
    let lateMinutes = null;
    if (first && shift && !first.excused) {
      const start = T.shiftStartUtc(day, shift);
      if (start) lateMinutes = Math.max(0, T.minutesBetween(start.toISOString(), first.ts));
    }
    const workMinutes = checks.length ? paired.total : null;
    return {
      employee: emp,
      shift,
      onLeave: leaveSet.has(emp.id),
      inCheck: first,
      outCheck: lastOut,
      inside: paired.inside,
      inTime: first ? T.fmtTime(new Date(first.ts)) : null,
      outTime: lastOut ? T.fmtTime(new Date(lastOut.ts)) : null,
      lateMinutes,
      late: !!(lateMinutes && lateMinutes > 0),
      workMinutes,
      workText: workMinutes != null ? T.fmtDuration(workMinutes) : '',
      flagged: checks.some((c) => c.flagged),
      checks
    };
  });

  return {
    present: rows.filter((r) => r.inside),
    left: rows.filter((r) => r.inCheck && !r.inside),
    absent: rows.filter((r) => !r.inCheck && !r.onLeave),
    onLeave: rows.filter((r) => r.onLeave),
    all: rows
  };
}

// Rapor / kayit listesi icin gun x personel satirlari
function dailyRows(fromDay, toDay, employeeId = null, locationId = null) {
  const range = T.rangeToUtc(fromDay, toDay);
  let sql = `SELECT c.*, e.name AS employee_name, e.shift_start AS emp_shift, e.location_id AS emp_location,
                    l.name AS location_name, l.shift_start AS loc_shift
             FROM checkins c
             JOIN employees e ON e.id = c.employee_id
             LEFT JOIN locations l ON l.id = c.location_id
             WHERE c.ts >= ? AND c.ts < ?`;
  const params = [range.start, range.end];
  if (employeeId) {
    sql += ' AND c.employee_id = ?';
    params.push(employeeId);
  }
  if (locationId) {
    sql += ' AND c.location_id = ?';
    params.push(locationId);
  }
  sql += ' ORDER BY c.ts ASC';
  const checks = db.prepare(sql).all(...params);

  const map = new Map();
  for (const c of checks) {
    const key = `${c.business_day}|${c.employee_id}`;
    if (!map.has(key)) {
      map.set(key, {
        day: c.business_day,
        employeeId: c.employee_id,
        employeeName: c.employee_name,
        locationName: c.location_name,
        shift: c.emp_shift || c.loc_shift || null,
        inCheck: null,
        outCheck: null,
        checks: [],
        flagged: false
      });
    }
    const row = map.get(key);
    row.checks.push(c);
    if (c.type === 'in' && !row.inCheck) row.inCheck = c;
    if (c.type === 'out') row.outCheck = c;
    if (c.flagged) row.flagged = true;
    if (c.location_name) row.locationName = c.location_name;
  }

  // Izin gunleri: kaydi olmayan gune "Izinli" satiri eklenir; kaydi varsa satir izinli olarak isaretlenir
  let lsql = `SELECT lv.*, e.name AS employee_name, e.shift_start AS emp_shift,
                     l.name AS location_name, l.shift_start AS loc_shift
              FROM leaves lv
              JOIN employees e ON e.id = lv.employee_id
              LEFT JOIN locations l ON l.id = e.location_id
              WHERE lv.day >= ? AND lv.day <= ?`;
  const lparams = [fromDay, toDay];
  if (employeeId) {
    lsql += ' AND lv.employee_id = ?';
    lparams.push(employeeId);
  }
  if (locationId) {
    lsql += ' AND e.location_id = ?';
    lparams.push(locationId);
  }
  for (const lv of db.prepare(lsql).all(...lparams)) {
    const key = `${lv.day}|${lv.employee_id}`;
    if (!map.has(key)) {
      map.set(key, {
        day: lv.day,
        employeeId: lv.employee_id,
        employeeName: lv.employee_name,
        locationName: lv.location_name,
        shift: lv.emp_shift || lv.loc_shift || null,
        inCheck: null,
        outCheck: null,
        checks: [],
        flagged: false
      });
    }
    const row = map.get(key);
    row.leave = true;
    row.leaveNote = lv.note || '';
  }

  const rows = [...map.values()].map((row) => {
    let lateMinutes = 0;
    if (row.inCheck && row.shift && !row.inCheck.excused) {
      const start = T.shiftStartUtc(row.day, row.shift);
      if (start) lateMinutes = Math.max(0, T.minutesBetween(start.toISOString(), row.inCheck.ts));
    }
    const paired = pairedMinutes(row.checks);
    const workMinutes = row.checks.length ? paired.total : null;
    return {
      ...row,
      leave: !!row.leave,
      leaveNote: row.leaveNote || '',
      inTime: row.inCheck ? T.fmtTime(new Date(row.inCheck.ts)) : '',
      outTime: row.outCheck ? T.fmtTime(new Date(row.outCheck.ts)) : '',
      lateMinutes,
      workMinutes,
      workText: workMinutes != null ? T.fmtDuration(workMinutes) : '',
      missingOut: paired.inside
    };
  });

  rows.sort((a, b) => (a.day === b.day ? a.employeeName.localeCompare(b.employeeName, 'tr') : a.day.localeCompare(b.day)));
  return rows;
}

function employeeTotals(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.employeeId)) {
      map.set(r.employeeId, {
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        days: 0,
        leaveDays: 0,
        workMinutes: 0,
        lateCount: 0,
        lateMinutes: 0,
        missingOutCount: 0
      });
    }
    const t = map.get(r.employeeId);
    if (r.checks.length) t.days += 1;
    if (r.leave) t.leaveDays += 1;
    if (r.workMinutes) t.workMinutes += r.workMinutes;
    if (r.lateMinutes > 0) {
      t.lateCount += 1;
      t.lateMinutes += r.lateMinutes;
    }
    if (r.missingOut) t.missingOutCount += 1;
  }
  return [...map.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName, 'tr'));
}

// --- Izin gunleri (izinli personel yoklamada "gelmedi" sayilmaz, raporda "Izinli" gorunur) ---
function leavesBetween(fromDay, toDay, employeeId = null) {
  let sql = `SELECT lv.*, e.name AS employee_name, l.name AS location_name
             FROM leaves lv
             JOIN employees e ON e.id = lv.employee_id
             LEFT JOIN locations l ON l.id = e.location_id
             WHERE lv.day >= ? AND lv.day <= ?`;
  const params = [fromDay, toDay];
  if (employeeId) {
    sql += ' AND lv.employee_id = ?';
    params.push(employeeId);
  }
  sql += ' ORDER BY lv.day ASC, e.name COLLATE NOCASE';
  return db.prepare(sql).all(...params);
}

function addLeave({ employeeId, fromDay, toDay, note = '', actor = 'admin' }) {
  const days = T.eachDay(fromDay, toDay);
  const now = new Date().toISOString();
  const ins = db.prepare(
    'INSERT OR IGNORE INTO leaves (employee_id, day, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  let n = 0;
  db.transaction(() => {
    for (const d of days) n += ins.run(employeeId, d, note || null, actor, now).changes;
  })();
  logAction(actor, 'leave_add', `personel #${employeeId} ${fromDay}..${toDay} (${n} gun)${note ? ' - ' + note : ''}`);
  return n;
}

function removeLeave(id, actor = 'admin') {
  const row = db.prepare('SELECT * FROM leaves WHERE id = ?').get(id);
  if (!row) return false;
  db.prepare('DELETE FROM leaves WHERE id = ?').run(id);
  logAction(actor, 'leave_delete', `personel #${row.employee_id} ${row.day}`);
  return true;
}

function pendingRequests() {
  return db
    .prepare(
      `SELECT r.*, e.name AS employee_name, e.status AS employee_status, l.name AS location_name
       FROM device_requests r
       LEFT JOIN employees e ON e.id = r.employee_id
       LEFT JOIN locations l ON l.id = r.location_id
       WHERE r.status = 'pending'
       ORDER BY r.created_at ASC`
    )
    .all();
}

function approveRequest(requestId, actor = 'admin') {
  const req = db.prepare('SELECT * FROM device_requests WHERE id = ?').get(requestId);
  if (!req || req.status !== 'pending') return { ok: false, error: 'Talep bulunamadi' };

  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    if (req.device_id) {
      // Ayni personelin diger cihazlarini iptal et, bu cihazi aktive et
      db.prepare('UPDATE devices SET active = 0, revoked_at = ? WHERE employee_id = ? AND id != ? AND active = 1')
        .run(now, req.employee_id, req.device_id);
      db.prepare('UPDATE devices SET active = 1, revoked_at = NULL WHERE id = ?').run(req.device_id);
    }
    if (req.type === 'new') {
      db.prepare("UPDATE employees SET status = 'active' WHERE id = ? AND status = 'pending'").run(req.employee_id);
    }
    db.prepare("UPDATE device_requests SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?")
      .run(now, actor, requestId);
  });
  tx();
  logAction(actor, 'request_approve', `talep #${requestId} (${req.type}) ${req.name} ${req.phone}`);
  return { ok: true };
}

// --- Cihaz yardimcilari (otomatik cihaz onayi + ortak telefon tespiti, 2026-09-09) ---
const AUTO_DEVICE_MAX_PER_WEEK = 3; // 7 gunde bu kadar talepten sonrasi elle onaya duser

function activeDeviceCount(employeeId) {
  return db.prepare('SELECT COUNT(*) AS n FROM devices WHERE employee_id = ? AND active = 1').get(employeeId).n;
}

function recentDeviceRequestCount(employeeId, days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return db
    .prepare('SELECT COUNT(*) AS n FROM device_requests WHERE employee_id = ? AND created_at >= ?')
    .get(employeeId, since).n;
}

// Ayni tarayici kimligi (ayni telefon) baska bir aktif personelin aktif cihazinda kayitli mi?
function browserIdOtherOwners(browserId, employeeId) {
  if (!browserId) return [];
  return db
    .prepare(
      `SELECT DISTINCT e.id, e.name FROM devices d JOIN employees e ON e.id = d.employee_id
       WHERE d.browser_id = ? AND d.active = 1 AND d.employee_id != ? AND e.status = 'active'
       ORDER BY e.name COLLATE NOCASE`
    )
    .all(browserId, employeeId);
}

/**
 * Aktif personelin "Daha once kayitliyim" talebi: guvenli gorunuyorsa cihaz aninda aktif edilir
 * (eski cihazlar KAPATILMAZ; Safari + uygulama ici tarayici birlikte calisabilsin).
 * Elle onaya dusme sebepleri: haftalik talep siniri asildi, ya da ayni telefon baska personele kayitli.
 */
function autoDeviceDecision(employee, browserId) {
  if (employee.status !== 'active') return { auto: false, reason: 'personel aktif değil' };
  const recent = recentDeviceRequestCount(employee.id, 7);
  if (recent >= AUTO_DEVICE_MAX_PER_WEEK) {
    return { auto: false, reason: `7 günde ${recent + 1}. cihaz talebi` };
  }
  const others = browserIdOtherOwners(browserId, employee.id);
  if (others.length) {
    return { auto: false, reason: `aynı telefon ${others.map((o) => o.name).join(', ')} adına kayıtlı`, others };
  }
  return { auto: true };
}

function rejectRequest(requestId, actor = 'admin') {
  const req = db.prepare('SELECT * FROM device_requests WHERE id = ?').get(requestId);
  if (!req || req.status !== 'pending') return { ok: false, error: 'Talep bulunamadi' };
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare("UPDATE device_requests SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?")
      .run(now, actor, requestId);
    if (req.device_id) {
      db.prepare('UPDATE devices SET active = 0, revoked_at = ? WHERE id = ?').run(now, req.device_id);
    }
    if (req.type === 'new') {
      const other = db
        .prepare("SELECT COUNT(*) AS n FROM checkins WHERE employee_id = ?")
        .get(req.employee_id);
      if (other.n === 0) {
        db.prepare("UPDATE employees SET status = 'passive' WHERE id = ? AND status = 'pending'").run(req.employee_id);
      }
    }
  });
  tx();
  logAction(actor, 'request_reject', `talep #${requestId} (${req.type}) ${req.name} ${req.phone}`);
  return { ok: true };
}

module.exports = {
  DUPLICATE_WINDOW_MS,
  shiftStartOf,
  getLocation,
  getLocationBySlug,
  evaluatePosition,
  recordCheckin,
  dayOverview,
  dailyRows,
  employeeTotals,
  leavesBetween,
  addLeave,
  removeLeave,
  pendingRequests,
  approveRequest,
  rejectRequest,
  activeDeviceCount,
  browserIdOtherOwners,
  autoDeviceDecision
};
