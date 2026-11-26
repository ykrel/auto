// Yaklasik konum reddi testi: node test-coarse.js <repo>
const path = require('path');
const fs = require('fs');
const os = require('os');
const repo = path.resolve(process.argv[2]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdks-coarse-'));
process.env.DATA_DIR = dir;
process.env.PORT = '3917';
process.env.ADMIN_PASSWORD = 'test';
process.env.SESSION_SECRET = 'testsecret';
process.env.BASE_URL = 'http://localhost:3917';
delete process.env.TELEGRAM_BOT_TOKEN;
const { db } = require(path.join(repo, 'src/db'));
require(path.join(repo, 'src/seed')).ensureSeed();
const { qrContent } = require(path.join(repo, 'src/qr'));
require(path.join(repo, 'src/server')).listen(3917);
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL', m); } };
setTimeout(async () => {
  try {
    const loc = db.prepare("SELECT * FROM locations WHERE slug='umraniye'").get();
    if (!loc.lat) db.prepare('UPDATE locations SET lat=41.0208,lng=29.1094,radius_m=350 WHERE id=?').run(loc.id);
    const L = db.prepare('SELECT * FROM locations WHERE id=?').get(loc.id);
    const now = new Date().toISOString();
    const e = db.prepare("INSERT INTO employees (name, phone, location_id, status, created_at) VALUES ('Deneme Kişi','05000000000',?, 'active', ?)").run(L.id, now);
    for (let k = 1; k <= 9; k++) db.prepare("INSERT INTO devices (employee_id, token, active, user_agent, created_at) VALUES (?, ?, 1, 'test', ?)").run(e.lastInsertRowid, 'tok' + k, now);
    let n = 0;
    const qr = qrContent(L.slug);
    const post = (body) => fetch('http://localhost:3917/api/checkin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'tok' + (++n), qr, slug: L.slug, ...body }) }).then(async r => ({ s: r.status, b: await r.json() }));
    // 1,4 km uzak, dogruluk 2000 m -> coarse_location
    const far = { lat: L.lat + 0.0126, lng: L.lng };
    let r = await post({ ...far, accuracy: 2000 });
    ok(r.s === 403 && r.b.reason === 'coarse_location' && r.b.state === 'location_rejected', 'coarse 2000: ' + JSON.stringify(r.b));
    ok(/Hassas konum/.test(r.b.error) && /±2\.0 km/.test(r.b.error), 'coarse metni: ' + r.b.error);
    console.log('  mesaj:', r.b.error);
    // 1,4 km uzak, dogruluk 20 m -> out_of_range (eski metin)
    r = await post({ ...far, accuracy: 20 });
    ok(r.s === 403 && r.b.reason === 'out_of_range' && /km uzaktasınız/.test(r.b.error), 'oor 20: ' + JSON.stringify(r.b));
    // dogruluk yok -> out_of_range
    r = await post({ ...far });
    ok(r.s === 403 && r.b.reason === 'out_of_range', 'oor accuracy yok: ' + JSON.stringify(r.b));
    // 600 m dogruluk -> coarse, metin metre
    r = await post({ ...far, accuracy: 600 });
    ok(r.b.reason === 'coarse_location' && /±600 m/.test(r.b.error), 'coarse 600: ' + r.b.error);
    // 499 m -> out_of_range
    r = await post({ ...far, accuracy: 499 });
    ok(r.b.reason === 'out_of_range', 'oor 499');
    // konumsuz -> no_gps
    r = await post({});
    ok(r.s === 403 && r.b.reason === 'no_gps', 'no_gps');
    // yaricap icinde ama dogruluk 2000 -> kayit alinir (dogruluk yalniz reddedilende bakilir)
    r = await post({ lat: L.lat + 0.0005, lng: L.lng, accuracy: 2000 });
    ok(r.s === 200, 'icerde kayit: ' + r.s + ' ' + JSON.stringify(r.b));
    const logs = db.prepare("SELECT detail FROM audit_log WHERE action='checkin_rejected' ORDER BY id").all().map(x => x.detail);
    console.log('  log:', logs);
    ok(logs[0].includes('coarse_location') && logs[0].includes('±2000m'), 'log coarse');
    ok(logs[1].includes('out_of_range') && logs[1].includes('±20m'), 'log oor acc');
    ok(logs[2].includes('out_of_range') && !logs[2].includes('±'), 'log oor accsiz');
  } catch (err) { fail++; console.log('HATA', err); }
  console.log(`gecti ${pass}, kaldi ${fail}`);
  process.exit(fail ? 1 : 0);
}, 800);
