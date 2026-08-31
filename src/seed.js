'use strict';

const { db } = require('./db');

// Placeholder koordinatlar: gercek degerler admin panelden girilecek.
const SEED_LOCATIONS = [
  { slug: 'umraniye', name: 'Ümraniye', lat: 41.0165, lng: 29.1248 },
  { slug: 'kadikoy', name: 'Kadıköy', lat: 40.9906, lng: 29.0300 },
  { slug: 'manavgat', name: 'Manavgat', lat: 36.7867, lng: 31.4436 },
  { slug: 'cinarcik', name: 'Çınarcık', lat: 40.6444, lng: 29.1233 }
];

function ensureSeed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM locations').get().n;
  if (count > 0) return { seeded: false };
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO locations (slug, name, lat, lng, radius_m, shift_start, active, created_at)
     VALUES (?, ?, ?, ?, 150, '08:30', 1, ?)`
  );
  db.transaction(() => {
    for (const loc of SEED_LOCATIONS) insert.run(loc.slug, loc.name, loc.lat, loc.lng, now);
  })();
  console.log('Seed: 4 lokasyon olusturuldu (placeholder koordinatlar).');
  return { seeded: true };
}

module.exports = { ensureSeed, SEED_LOCATIONS };

if (require.main === module) {
  ensureSeed();
}
