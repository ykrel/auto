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
 * Gunun ilk okutmasi GIRIS, sonrakiler CIKIS (yeni okutma son cikisi gunceller).
 * Son okutmadan sonraki 2 dk icindeki tekrarlar yok sayilir.
 */
function recordCheckin({ employee, location, coords, source = 'qr', now = new Date() }) {
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

  let type;
  let id;
  if (!last) {
    type = 'in';
    id = db
      .prepare(
        `INSERT INTO checkins
         (employee_id, location_id, type, ts, business_day, lat, lng, accuracy, distance_m, flagged, flag_reason, source, created_at)
         VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        employee.id,
        location.id,
        ts,
        day,
        coords ? coords.lat : null,
        coords ? coords.lng : null,
        coords ? coords.accuracy : null,
        pos.distance,
        pos.flagged,
        pos.flag_reason,
        source,
        ts
      ).lastInsertRowid;
  } else if (last.type === 'out') {
    // Ayni gunde tekrar okutma: son cikisi guncelle
    type = 'out';
    id = last.id;
    db.prepare(
      `UPDATE checkins
         SET ts = ?, location_id = ?, lat = ?, lng = ?, accuracy = ?, distance_m = ?, flagged = ?, flag_reason = ?, source = ?
       WHERE id = ?`
    ).run(
      ts,
      location.id,
      coords ? coords.lat : null,
      coords ? coords.lng : null,
      coords ? coords.accuracy : null,
      pos.distance,
      pos.flagged,
      pos.flag_reason,
      source,
      last.id
    );
  } else {
    type = 'out';
    id = db
      .prepare(
        `INSERT INTO checkins
         (employee_id, location_id, type, ts, business_day, lat, lng, accuracy, distance_m, flagged, flag_reason, source, created_at)
         VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        employee.id,
        location.id,
        ts,
        day,
        coords ? coords.lat : null,
        coords ? coords.lng : null,
        coords ? coords.accuracy : null,
        pos.distance,
        pos.flagged,
        pos.flag_reason,
        source,
        ts
      ).lastInsertRowid;
  }

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

  const rows = employees.map((emp) => {
    const checks = db
      .prepare('SELECT * FROM checkins WHERE employee_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC')
      .all(emp.id, range.start, range.end);
    const first = checks.find((c) => c.type === 'in') || null;
    const last = [...checks].reverse().find((c) => c.type === 'out') || null;
    const shift = emp.shift_start || emp.location_shift || null;
    let lateMinutes = null;
    if (first && shift) {
      const start = T.shiftStartUtc(day, shift);
      if (start) lateMinutes = Math.max(0, T.minutesBetween(start.toISOString(), first.ts));
    }
    const workMinutes = first && last ? T.minutesBetween(first.ts, last.ts) : null;
    return {
      employee: emp,
      shift,
      inCheck: first,
      outCheck: last,
      inTime: first ? T.fmtTime(new Date(first.ts)) : null,
      outTime: last ? T.fmtTime(new Date(last.ts)) : null,
      lateMinutes,
      late: !!(lateMinutes && lateMinutes > 0),
      workMinutes,
      workText: workMinutes != null ? T.fmtDuration(workMinutes) : '',
      flagged: checks.some((c) => c.flagged),
      checks
    };
  });

  return {
    present: rows.filter((r) => r.inCheck && !r.outCheck),
    left: rows.filter((r) => r.inCheck && r.outCheck),
    absent: rows.filter((r) => !r.inCheck),
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
        flagged: false
      });
    }
    const row = map.get(key);
    if (c.type === 'in' && !row.inCheck) row.inCheck = c;
    if (c.type === 'out') row.outCheck = c;
    if (c.flagged) row.flagged = true;
    if (c.location_name) row.locationName = c.location_name;
  }

  const rows = [...map.values()].map((row) => {
    let lateMinutes = 0;
    if (row.inCheck && row.shift) {
      const start = T.shiftStartUtc(row.day, row.shift);
      if (start) lateMinutes = Math.max(0, T.minutesBetween(start.toISOString(), row.inCheck.ts));
    }
    const workMinutes = row.inCheck && row.outCheck ? T.minutesBetween(row.inCheck.ts, row.outCheck.ts) : null;
    return {
      ...row,
      inTime: row.inCheck ? T.fmtTime(new Date(row.inCheck.ts)) : '',
      outTime: row.outCheck ? T.fmtTime(new Date(row.outCheck.ts)) : '',
      lateMinutes,
      workMinutes,
      workText: workMinutes != null ? T.fmtDuration(workMinutes) : '',
      missingOut: !!row.inCheck && !row.outCheck
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
        workMinutes: 0,
        lateCount: 0,
        lateMinutes: 0,
        missingOutCount: 0
      });
    }
    const t = map.get(r.employeeId);
    t.days += 1;
    if (r.workMinutes) t.workMinutes += r.workMinutes;
    if (r.lateMinutes > 0) {
      t.lateCount += 1;
      t.lateMinutes += r.lateMinutes;
    }
    if (r.missingOut) t.missingOutCount += 1;
  }
  return [...map.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName, 'tr'));
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
  pendingRequests,
  approveRequest,
  rejectRequest
};
