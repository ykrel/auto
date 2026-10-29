'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const dbFile = path.join(DATA_DIR, 'pdks.sqlite');
const db = new Database(dbFile);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  lat REAL,
  lng REAL,
  radius_m INTEGER NOT NULL DEFAULT 150,
  shift_start TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  location_id INTEGER REFERENCES locations(id),
  status TEXT NOT NULL DEFAULT 'pending',
  shift_start TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id),
  type TEXT NOT NULL,
  ts TEXT NOT NULL,
  business_day TEXT NOT NULL,
  lat REAL,
  lng REAL,
  accuracy REAL,
  distance_m REAL,
  flagged INTEGER NOT NULL DEFAULT 0,
  flag_reason TEXT,
  source TEXT NOT NULL DEFAULT 'qr',
  created_at TEXT NOT NULL,
  edited_by TEXT,
  edited_at TEXT
);

CREATE TABLE IF NOT EXISTS device_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_subs (
  chat_id TEXT PRIMARY KEY,
  name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(employee_id, day)
);

CREATE INDEX IF NOT EXISTS idx_checkins_emp_day ON checkins(employee_id, business_day);
CREATE INDEX IF NOT EXISTS idx_leaves_day ON leaves(day);
CREATE INDEX IF NOT EXISTS idx_checkins_ts ON checkins(ts);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token);
CREATE INDEX IF NOT EXISTS idx_requests_status ON device_requests(status);
`);

// Sonradan eklenen kolonlar (mevcut veritabanini migrate eder)
const checkinCols = db.prepare('PRAGMA table_info(checkins)').all().map((c) => c.name);
if (!checkinCols.includes('excused')) db.exec('ALTER TABLE checkins ADD COLUMN excused INTEGER NOT NULL DEFAULT 0');
if (!checkinCols.includes('excused_by')) db.exec('ALTER TABLE checkins ADD COLUMN excused_by TEXT');
// 2026-09-09: kayitlara cihaz bilgisi + cihazlara tarayici kimligi (ortak telefon tespiti)
if (!checkinCols.includes('device_id')) db.exec('ALTER TABLE checkins ADD COLUMN device_id INTEGER REFERENCES devices(id)');
const deviceCols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
if (!deviceCols.includes('browser_id')) db.exec('ALTER TABLE devices ADD COLUMN browser_id TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_devices_browser ON devices(browser_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_checkins_device ON checkins(device_id)');
// 2026-10-22: lokasyona ozel mesai bitisi (bossa SHIFT_END) ve cumartesi calisma bilgisi (Uretim binasi)
const locationCols = db.prepare('PRAGMA table_info(locations)').all().map((c) => c.name);
if (!locationCols.includes('shift_end')) db.exec('ALTER TABLE locations ADD COLUMN shift_end TEXT');
if (!locationCols.includes('saturday')) db.exec('ALTER TABLE locations ADD COLUMN saturday INTEGER NOT NULL DEFAULT 1');
// Aksam yoklamasi saati (bossa mesai bitisi + 5 dk). Uretim 18:50 (Kagan 24.10: 18:45'te henuz cikmayanlar oluyor)
if (!locationCols.includes('evening_at')) db.exec('ALTER TABLE locations ADD COLUMN evening_at TEXT');
// Lokasyona ozel Telegram botu (Uretim): ayni kisi iki botta da abone olabilsin diye anahtar (chat_id, bot).
// Mevcut aboneler 'main' (ana PDKS botu) olarak tasinir.
const subCols = db.prepare('PRAGMA table_info(telegram_subs)').all().map((c) => c.name);
if (!subCols.includes('bot')) {
  db.transaction(() => {
    db.exec(`CREATE TABLE telegram_subs_yeni (
      chat_id TEXT NOT NULL,
      bot TEXT NOT NULL DEFAULT 'main',
      name TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, bot)
    )`);
    db.exec("INSERT INTO telegram_subs_yeni (chat_id, bot, name, created_at) SELECT chat_id, 'main', name, created_at FROM telegram_subs");
    db.exec('DROP TABLE telegram_subs');
    db.exec('ALTER TABLE telegram_subs_yeni RENAME TO telegram_subs');
  })();
}
// Abone ayni zamanda personelse (orn. bina sefi) kendi kaydi icin buton islemi yapamaz (Kagan 24.10)
const subCols2 = db.prepare('PRAGMA table_info(telegram_subs)').all().map((c) => c.name);
if (!subCols2.includes('employee_id')) db.exec('ALTER TABLE telegram_subs ADD COLUMN employee_id INTEGER REFERENCES employees(id)');

function logAction(actor, action, detail) {
  db.prepare('INSERT INTO audit_log (actor, action, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(actor, action, detail == null ? null : String(detail), new Date().toISOString());
}

module.exports = { db, dbFile, DATA_DIR, logAction };
