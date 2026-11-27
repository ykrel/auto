// Kullanim: NODE_PATH=<repo>/node_modules node test-rapor.js <repo>
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

test('PDKS rapor yükleme', async (t) => {
  const repo = path.resolve(process.argv[2] || __dirname);
  const dir = fs.mkdtempSync(path.join(repo, '.test-rapor-'));
  const secret = 'da1f'.repeat(16);
  const url = 'https://ik.example.test';
  Object.assign(process.env, {
    DATA_DIR: dir, NODE_ENV: 'test', ADMIN_PASSWORD: 'test', SESSION_SECRET: 'rapor-test',
    IZIN_SEFLER: '24', IZIN_ONAYCILAR: '101', TELEGRAM_BOT_TOKEN: 'test-main',
    TELEGRAM_BOT_TOKEN_URETIM: 'test-uretim', IK_BELGE_SECRET: secret, IK_BELGE_URL: url
  });

  const RealDate = Date;
  const realFetch = global.fetch;
  let clock = Date.parse('2026-11-27T09:00:00Z');
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  };
  const { db } = require(path.join(repo, 'src/db'));
  const belge = require(path.join(repo, 'src/belge'));
  const panel = require(path.join(repo, 'src/panel-auth'));
  const app = require(path.join(repo, 'src/server'));
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((done) => server.close(done));
    db.close();
    global.Date = RealDate;
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  process.env.BASE_URL = base;
  const calls = [];
  global.fetch = async (target, options) => {
    const address = new URL(target);
    if (address.origin === base) return realFetch(target, options);
    assert.equal(address.origin, 'https://api.telegram.org');
    calls.push({ method: address.pathname.split('/').pop(), ...JSON.parse(options.body) });
    return { json: async () => ({ ok: true, result: { message_id: calls.length } }) };
  };

  db.exec("INSERT INTO locations(id,slug,name,saturday,created_at) VALUES (1,'uretim','Üretim',0,'2026-01-01'),(2,'merkez','Merkez',1,'2026-01-01')");
  for (const [id, loc] of [[1, 1], [2, 2], [24, 1]]) {
    db.prepare("INSERT INTO employees(id,name,phone,status,location_id,created_at) VALUES (?,?,?,'active',?,?)")
      .run(id, 'Kişi ' + id, '0555' + id, loc, new Date().toISOString());
    db.prepare('INSERT INTO devices(employee_id,token,active,created_at) VALUES (?,?,1,?)').run(id, 'tok' + id, new Date().toISOString());
  }

  const file = { id: 'c'.repeat(32), sha256: 'd'.repeat(64), boyut: 15 * 1024 * 1024, tur: 'application/pdf' };
  const now = () => Math.floor(Date.now() / 1000);
  const mac = (value, format) => crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(value).digest(format);
  async function api(route, options) {
    const response = await fetch(base + route, options);
    return { status: response.status, body: await response.json() };
  }
  function post(route, data, token = 'tok1') {
    return api(route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PDKS-Token': token }, body: JSON.stringify(data) });
  }
  function ticket(start = '2026-11-27', end = start, token, employee_id) {
    return post('/api/izin/rapor-bilet', { start, end, employee_id }, token);
  }
  function callback(raw, zaman = now(), imza = mac('kayit.' + zaman + '.' + raw, 'hex')) {
    return api('/api/belge/kayit', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Ik-Zaman': String(zaman), 'X-Ik-Imza': imza
    }, body: raw });
  }
  function message(bilet, metadata = file) { return JSON.stringify({ bilet, belge: metadata }, null, 2); }
  function viewLink(ttl) {
    const exp = now() + ttl;
    return url + '/b/' + file.id + '?x=' + exp + '&s=' + mac('gor.' + file.id + '.' + exp, 'base64url');
  }
  async function panelHtml() {
    const link = await fetch(panel.issueLink('101', 'Kağan'), { redirect: 'manual' });
    const cookie = link.headers.getSetCookie()[0].split(';')[0];
    return (await fetch(base + '/yonetim', { headers: { cookie } })).text();
  }
  const freshWindow = () => { clock += 61000; };
  const list = () => api('/api/izin', { headers: { 'X-PDKS-Token': 'tok1' } });
  const counts = () => db.prepare('SELECT (SELECT count(*) FROM belge_nonces) nonces, (SELECT count(*) FROM leave_requests) requests').get();

  await t.test('Özelliği açmak için iki ayar gerekir', async () => {
    for (const key of ['IK_BELGE_SECRET', 'IK_BELGE_URL']) {
      const value = process.env[key];
      delete process.env[key];
      assert.equal((await list()).body.rapor, false);
      assert.deepEqual(await ticket(), { status: 503, body: { error: 'Rapor yükleme şu an kapalı.' } });
      assert.equal((await callback('{}')).status, 503);
      process.env[key] = value;
    }
    assert.equal((await list()).body.rapor, true);
    assert.equal((await ticket(undefined, undefined, 'geçersiz')).status, 401);
  });

  await t.test('Rapor ve izin tarih sınırları, iş günü ve dosyasız rapor reddi', async () => {
    freshWindow();
    assert.equal((await ticket('2026-10-28')).status, 200);
    assert.match((await ticket('2026-10-27')).body.error, /30 gün/);
    assert.equal((await ticket('2026-11-30', '2026-12-30')).status, 200);
    assert.match((await ticket('2026-12-01')).body.error, /3 gün/);
    assert.match((await ticket('2026-11-30', '2026-12-31')).body.error, /31 takvim/);
    assert.equal((await ticket()).status, 429);
    freshWindow();
    assert.match((await ticket('2026-11-28')).body.error, /iş günü/);
    for (const start of ['2026-11-23', '2026-10-28']) {
      assert.match((await post('/api/izin', { type: 'yillik', start, end: start })).body.error, /3 gün/);
    }
    assert.equal((await post('/api/izin', { type: 'rapor', start: '2026-11-27', end: '2026-11-27', file_ref: file.id })).status, 400);
    assert.deepEqual(counts(), { nonces: 0, requests: 0 });
  });

  await t.test('İmzalar, ham JSON, zaman ve belge alanları', async () => {
    freshWindow();
    const issued = await ticket(undefined, undefined, 'tok1', 2);
    assert.equal(issued.status, 200);
    assert.equal(issued.body.url, url + '/yukle');
    const token = issued.body.bilet;
    const [p, s] = token.split('.');
    assert.equal(s, mac('bilet.' + p, 'base64url'));
    const payload = belge.verifyTicket(token);
    assert.match(payload.n, /^[a-f0-9]{32}$/);
    assert.deepEqual(payload, { v: 1, emp: 1, by: null, s: '2026-11-27', e: '2026-11-27', n: payload.n, x: now() + 900 });
    assert.equal(p, Buffer.from(JSON.stringify(payload)).toString('base64url'));
    assert.notEqual(belge.verifyTicket((await ticket()).body.bilet).n, payload.n);
    const raw = message(token);
    assert.equal((await callback(raw, now(), '0'.repeat(64))).status, 401);
    assert.equal((await callback(raw + ' ', now(), mac('kayit.' + now() + '.' + raw, 'hex'))).status, 401);
    for (const delta of [-301, 301]) assert.equal((await callback(raw, now() + delta)).status, 401);
    for (const delta of [-300, 300]) assert.equal((await callback('{', now() + delta)).status, 400);
    const badTicket = p + '.' + (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    assert.equal(belge.verifyTicket(badTicket), null);
    assert.equal((await callback(message(badTicket))).status, 400);
    assert.equal((await callback(' '.repeat(10241))).status, 413);
    for (const invalid of [{ id: '0' }, { sha256: 'f' }, { boyut: 0 }, { boyut: 1.5 }, { boyut: file.boyut + 1 },
      { boyut: '5' }, { tur: 'text/html' }]) {
      assert.equal((await callback(message(token, { ...file, ...invalid }))).status, 400);
    }
    clock += 1501000;
    assert.deepEqual(await callback(raw), { status: 400, body: { error: 'Yükleme süresi doldu, tekrar deneyin.' } });
    assert.deepEqual(counts(), { nonces: 0, requests: 0 });
  });

  await t.test('Ek sürenin son saniyesinde eşzamanlı kayıt, Telegram ve panel bağlantıları', async () => {
    const { bilet } = (await ticket()).body;
    clock += 1500000;
    const results = await Promise.all([callback(message(bilet)), callback(message(bilet))]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const { id } = results.find((r) => r.status === 201).body;
    assert.deepEqual(db.prepare('SELECT kind,leave_type,file_ref,opened_by,status FROM leave_requests WHERE id=?').get(id),
      { kind: 'rapor', leave_type: 'rapor', file_ref: file.id, opened_by: null, status: 'pending' });
    assert.deepEqual(counts(), { nonces: 1, requests: 1 });
    assert.deepEqual(db.prepare("SELECT actor, detail FROM audit_log WHERE action='report_upload'").all(), [{ actor: 'ik-belge', detail: 'talep #' + id }]);
    assert.equal(calls.length, 1);
    const sent = calls[0];
    assert.match(sent.text, /\n📎 Rapor ekli/);
    assert.doesNotMatch(sent.text, /maaş|kesinti|bordro/i);
    const button = { text: '📎 Raporu aç', url: viewLink(30 * 24 * 3600) };
    assert.deepEqual(sent.reply_markup.inline_keyboard, [[button],
      [{ text: '✅ Onayla', callback_data: 'izin:onay:' + id }, { text: '❌ Reddet', callback_data: 'izin:red:' + id }]]);
    const anchor = 'href="' + viewLink(3600).replace('&', '&amp;') + '" target="_blank" rel="noopener">📎 Rapor</a>';
    assert.ok((await panelHtml()).split('Son kararlar')[0].includes(anchor));
    assert.equal((await post('/api/izin/' + id + '/iptal', {})).status, 200);
    assert.equal(calls.at(-1).method, 'editMessageText');
    assert.deepEqual(calls.at(-1).reply_markup.inline_keyboard, [[button]]);
    assert.ok((await panelHtml()).split('Son kararlar')[1].includes(anchor));
  });

  await t.test('Şefin yetkisi, personelin durumu ve lokasyon kayıtta yeniden doğrulanır', async () => {
    const delegated = (id) => ticket('2026-11-26', '2026-11-26', 'tok24', id);
    assert.equal((await delegated(24)).body.error, "Kendi raporunuz için Kağan Bey'e başvurun.");
    assert.equal((await delegated(2)).status, 400);
    const { bilet } = (await delegated(1)).body;
    const raw = message(bilet, { ...file, tur: 'image/heic', boyut: 1 });
    assert.equal(belge.verifyTicket(bilet).by, 24);
    process.env.IZIN_SEFLER = '';
    assert.equal((await callback(raw)).status, 400);
    process.env.IZIN_SEFLER = '24';
    for (const [id, column, value, restored] of [[1, 'location_id', 2, 1], [1, 'status', 'passive', 'active'], [24, 'status', 'passive', 'active']]) {
      const update = db.prepare('UPDATE employees SET ' + column + '=? WHERE id=?');
      update.run(value, id);
      assert.equal((await callback(raw)).status, 400);
      update.run(restored, id);
    }
    const response = await callback(raw);
    assert.equal(response.status, 201);
    assert.deepEqual(db.prepare('SELECT employee_id, opened_by FROM leave_requests WHERE id=?').get(response.body.id), { employee_id: 1, opened_by: 24 });
    assert.match(calls.at(-1).text, /Açan: Kişi 24/);
    const tg = require(path.join(repo, 'src/telegram'));
    await tg.handleUpdate({ callback_query: { id: 'onay', data: 'izin:onay:' + response.body.id, from: { id: 101 },
      message: { chat: { id: 101 }, message_id: 1 } } }, tg.botFor(1));
    const edit = calls.filter((call) => call.method === 'editMessageText').at(-1);
    assert.match(edit.text, /Onaylandı/);
    assert.deepEqual(edit.reply_markup.inline_keyboard, [[{ text: '📎 Raporu aç', url: viewLink(30 * 24 * 3600) }]]);
  });

  await t.test('Biletten sonra oluşan çakışma ve bekleyen talep sınırı kaydı engeller', async () => {
    freshWindow();
    const { bilet } = (await ticket()).body;
    const leave = (start) => post('/api/izin', { type: 'yillik', start, end: start });
    const overlap = await leave('2026-11-27');
    assert.equal(overlap.status, 201);
    assert.match((await callback(message(bilet))).body.error, /çakış/);
    assert.match((await ticket()).body.error, /çakış/);
    const other = (await ticket('2026-11-25')).body.bilet;
    freshWindow();
    for (const day of ['2026-11-30', '2026-12-01']) assert.equal((await leave(day)).status, 201);
    assert.match((await callback(message(other))).body.error, /3 bekleyen/);
    assert.match((await ticket('2026-11-25')).body.error, /3 bekleyen/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM belge_nonces').get().n, 2);
    assert.equal((await post('/api/izin', { type: 'yillik', start: '2026-11-24', end: '2026-11-24' }, 'tok2')).status, 201);
  });
});
