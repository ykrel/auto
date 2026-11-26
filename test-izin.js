// Kullanim: NODE_PATH=<repo>/node_modules node test-izin.js <repo>
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

test('PDKS izin işlemleri', async (t) => {
  const repo = path.resolve(process.argv[2] || __dirname);
  const dir = fs.mkdtempSync(path.join(repo, '.test-izin-'));
  let db, server;
  const realFetch = global.fetch;
  const RealDate = Date;
  t.after(async () => {
    if (server?.listening) await new Promise((done) => server.close(done));
    if (db?.open) db.close();
    global.Date = RealDate;
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  Object.assign(process.env, {
    DATA_DIR: dir, SESSION_SECRET: 'izin-test-oturumu', ADMIN_PASSWORD: 'izin-test',
    IZIN_ONAYCILAR: '101, 202, 101', TELEGRAM_BOT_TOKEN: 'test-main',
    TELEGRAM_BOT_TOKEN_URETIM: 'test-uretim', NODE_ENV: 'test'
  });
  let clock = RealDate.parse('2026-11-26T09:00:00Z');
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  };
  const now = new Date().toISOString();

  // Goc oncesi kayitlar gercek eski kolonlarla olusturulur.
  const Database = require(path.join(repo, 'node_modules/better-sqlite3'));
  const old = new Database(path.join(dir, 'pdks.sqlite'));
  old.exec(`CREATE TABLE locations (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    lat REAL, lng REAL, radius_m INTEGER NOT NULL DEFAULT 150, shift_start TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL);
    CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
    location_id INTEGER REFERENCES locations(id), status TEXT NOT NULL DEFAULT 'pending', shift_start TEXT, created_at TEXT NOT NULL);
    CREATE TABLE leaves (id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id), day TEXT NOT NULL,
      note TEXT, created_by TEXT, created_at TEXT NOT NULL, UNIQUE(employee_id, day));
    INSERT INTO employees VALUES (1,'Ayşe Yılmaz','05551111111',NULL,'active',NULL,'2026-01-01');
    INSERT INTO leaves VALUES (1,1,'2026-12-02','Eski kayıt','admin','2026-11-01');`);
  old.close();

  db = require(path.join(repo, 'src/db')).db;
  const T = require(path.join(repo, 'src/time'));
  const service = require(path.join(repo, 'src/service'));
  const tg = require(path.join(repo, 'src/telegram'));
  const app = require(path.join(repo, 'src/server'));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  process.env.BASE_URL = base;
  const calls = [];
  let delaySend;
  global.fetch = async (url, options) => {
    const target = new URL(url);
    if (target.origin === base) return realFetch(url, options);
    assert.equal(target.origin, 'https://api.telegram.org');
    const [, bot, method] = target.pathname.split('/');
    const call = { bot, method, ...JSON.parse(options.body) };
    calls.push(call);
    const message_id = calls.length;
    if (delaySend && method === 'sendMessage') await delaySend(call);
    return { json: async () => ({ ok: true, result: { message_id } }) };
  };

  await t.test('Eski şema taşınır, eski izin korunur', () => {
    assert.deepEqual(db.prepare('SELECT note,type,request_id FROM leaves').get(), { note: 'Eski kayıt', type: null, request_id: null });
    assert.equal(db.prepare('SELECT hire_date FROM employees').get().hire_date, null);
    assert.deepEqual(db.prepare('PRAGMA index_info(idx_leave_requests_emp_status)').all().map((r) => r.name), ['employee_id', 'status']);
    for (const table of ['leave_requests', 'panel_links']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table));
  });

  db.prepare("INSERT INTO locations (id,slug,name,saturday,created_at) VALUES (1,'uretim','Üretim',0,?), (2,'merkez','Merkez',1,?)").run(now, now);
  db.prepare("UPDATE employees SET location_id=1, hire_date='2021-11-26' WHERE id=1").run();
  db.prepare("INSERT INTO employees(id,name,phone,location_id,status,created_at) VALUES (2,'Can Kaya','05552222222',2,'active',?)").run(now);
  const device = db.prepare('INSERT INTO devices(employee_id,token,active,created_at) VALUES (?,?,?,?)');
  device.run(1, 'ayse', 1, now);
  device.run(1, 'kapali', 0, now);
  device.run(2, 'can', 1, now);
  const sub = db.prepare('INSERT INTO telegram_subs(chat_id,bot,name,created_at) VALUES (?,?,?,?)');
  sub.run('101', 'uretim', 'Kağan', now);
  sub.run('202', 'main', 'Umut', now);
  sub.run('303', 'uretim', 'Abone', now);
  service.addHoliday({ fromDay: '2026-11-30', toDay: '2026-11-30', locationId: 1 });
  service.addHoliday({ fromDay: '2026-12-01', toDay: '2026-12-01', shiftEnd: '13:00' });

  const http = (route, opts = {}) => fetch(base + route, { redirect: 'manual', ...opts });
  const form = (data, cookie = '') => ({ method: 'POST', headers: { cookie }, body: new URLSearchParams(data) });
  async function api(route, data) {
    // GET listesinde token URL'de degil X-PDKS-Token basliginda (?token= yalniz testte kisayol)
    const q = /\?token=([^&]+)$/.exec(route);
    if (q) return http(route.replace(q[0], ''), { headers: { 'x-pdks-token': q[1] } }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const response = await http(route, data && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  }
  const request = (start, end = start, extra = {}) => api('/api/izin', { token: 'ayse', start, end, type: 'yillik', ...extra });
  const byId = (id) => db.prepare('SELECT * FROM leave_requests WHERE id=?').get(id);
  const newWindow = () => { clock += 61000; };
  const bot = tg.botFor(1);
  const callback = (chat, data, from = chat) => tg.handleUpdate({ callback_query: {
    id: 'test', data, from: { id: from }, message: { chat: { id: chat }, message_id: 1 }
  } }, bot);
  const panelCommand = async (chat) => {
    await tg.handleUpdate({ message: { from: { id: chat }, chat: { id: chat }, text: '/panel' } }, bot);
    return calls.at(-1).text;
  };
  async function newLink(chat = 101) {
    const text = await panelCommand(chat);
    const url = new URL(text.split('\n').at(-1));
    assert.equal(url.origin, base);
    assert.match(url.searchParams.get('t'), /^[0-9a-f]{64}$/);
    return url.pathname + url.search;
  }

  await t.test('Personel ekranı, token ve aktif kayıt kontrolü', async () => {
    const html = await (await http('/c/uretim')).text();
    assert.match(html, /id="action-btn"[\s\S]*id="leave-open"/);
    assert.match(html, /id="leave-start"[^>]*value="2026-11-27"/);
    assert.match(html, /Taleplerim/);
    assert.equal((await api('/api/izin')).status, 401);
    assert.equal((await api('/api/izin?token=kapali')).status, 403);
    assert.deepEqual((await api('/api/izin?token=ayse')).body, { talepler: [], turler: ['yillik', 'mazeret', 'ucretsiz'] });
    assert.equal((await http('/api/izin', { headers: { cookie: 'pdks_token=ayse' } })).status, 200);
    assert.equal((await http('/api/izin?token=ayse')).status, 401); // token URL'den kabul edilmez
  });

  await t.test('Tarih sınırları, lokasyona özel mesai, izin türü ve açıklama', async () => {
    const invalid = [
      ['2026-11-22', '2026-11-26', {}, /3 gün/],
      ['2026-12-03', '2026-12-02', {}, /önce/],
      ['2026-12-01', '2027-01-01', {}, /31/],
      ['2026-11-26', T.addDays('2026-11-26', 181), {}, /180/],
      ['2026-02-30', '2026-02-30', {}, /Geçerli/],
      ['2026-11-28', '2026-11-30', {}, /iş günü yok/],
      ['2026-11-26', '2026-11-26', { type: 'rapor' }, /türü/],
      ['2026-11-26', '2026-11-26', { note: 'a'.repeat(301) }, /300/]
    ];
    for (const [start, end, extra, msg] of invalid) {
      newWindow();
      const result = await request(start, end, extra);
      assert.equal(result.status, 400);
      assert.match(result.body.error, msg);
    }
    assert.equal(db.prepare('SELECT count(*) n FROM leave_requests').get().n, 0);
  });

  let first, second, third, approveButton, rejectButton;
  await t.test('Oluşturma, lokasyon botu, onaycı kopyaları ve bekleyen talep sınırı', async () => {
    newWindow();
    const r = await request('2026-11-27', '2026-12-02', { note: 'Aile ziyareti' });
    assert.equal(r.status, 201);
    first = r.body.id;
    assert.equal(byId(first).work_days, 3);
    assert.equal(byId(first).file_ref, null);
    const copies = JSON.parse(byId(first).tg_msgs);
    assert.deepEqual(copies.map((c) => c.chat_id).sort(), ['101', '202']);
    for (const copy of copies) {
      assert.equal(copy.bot, 'uretim');
      const sent = calls[copy.message_id - 1];
      assert.equal(sent.chat_id, copy.chat_id);
      assert.equal(sent.bot, 'bottest-uretim');
      assert.match(sent.text, /Ayşe Yılmaz · Üretim\n27\.11 Cum – 02\.12 Çar \(3 iş günü\)\nYıllık izin\nNot: Aile ziyareti/);
      const [yes, no] = sent.reply_markup.inline_keyboard[0];
      assert.deepEqual([yes.text, no.text], ['✅ Onayla', '❌ Reddet']);
      approveButton = yes.callback_data;
      rejectButton = no.callback_data;
    }
    assert.match((await request('2026-12-02')).body.error, /çakış/);
    second = (await request('2026-12-03')).body.id;
    third = (await request('2026-12-04')).body.id;
    assert.match((await request('2026-12-07')).body.error, /3 bekleyen/);
    assert.equal((await request('2026-12-08')).status, 429);
  });

  await t.test('Personel sadece kendi bekleyen talebini iptal eder', async () => {
    newWindow();
    assert.equal((await api('/api/izin/' + second + '/iptal', { token: 'can' })).status, 409);
    const begin = calls.length;
    assert.equal((await api('/api/izin/' + second + '/iptal', { token: 'ayse' })).status, 200);
    assert.equal(byId(second).status, 'cancelled');
    const edits = calls.slice(begin);
    assert.equal(edits.length, 2);
    for (const c of edits) {
      assert.equal(c.method, 'editMessageText');
      assert.match(c.text, /🚫 Personel iptal etti$/);
      assert.deepEqual(c.reply_markup.inline_keyboard, []);
    }
    assert.equal((await api('/api/izin/' + second + '/iptal', { token: 'ayse' })).status, 409);
  });

  await t.test('Telegram yetkisi, ilk karar, tatil ve mevcut izin gününün korunması', async () => {
    await callback(303, approveButton);
    assert.equal(calls.at(-1).text, 'Bu işlem için yetkiniz yok');
    assert.equal(byId(first).status, 'pending');
    const begin = calls.length;
    await Promise.all([callback(101, approveButton), callback(202, rejectButton)]);
    assert.equal(byId(first).decided_by, 'Kağan');
    assert.equal(byId(first).status, 'approved');
    const edits = calls.slice(begin).filter((c) => c.method === 'editMessageText');
    assert.equal(edits.length, 2);
    for (const c of edits) {
      assert.match(c.text, /✅ Onaylandı — Kağan 26\.11 \d\d:\d\d$/);
      assert.deepEqual(c.reply_markup.inline_keyboard, []);
    }
    assert.ok(calls.slice(begin).some((c) => c.text === 'Bu talebe zaten karar verildi — Kağan'));
    assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE action='leave_request_approve'").get().n, 1);
    assert.deepEqual(db.prepare('SELECT day,type,note,created_by FROM leaves WHERE request_id=? ORDER BY day').all(first),
      ['2026-11-27', '2026-12-01'].map((day) => ({ day, type: 'yillik', note: 'talep #' + first, created_by: 'telegram:Kağan' })));
    assert.equal(db.prepare("SELECT note FROM leaves WHERE day='2026-12-02'").get().note, 'Eski kayıt');
    assert.match((await request('2026-12-01')).body.error, /çakış/);
    assert.equal((await api('/api/izin/' + first + '/iptal', { token: 'ayse' })).status, 409);
    const no = calls.find((c) => c.method === 'sendMessage' && c.text.startsWith('📝 İzin talebi #' + third + '\n')).reply_markup.inline_keyboard[0][1];
    await callback(202, no.callback_data);
    assert.equal(byId(third).status, 'rejected');
    assert.equal(byId(third).decided_by, 'Umut');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM leaves WHERE request_id=?').get(third).n, 0);
    assert.ok(calls.some((c) => c.method === 'editMessageText' && c.text.includes('❌ Reddedildi — Umut')));
    assert.match(tg.morningText(service.dayOverview('2026-11-27', 1), service.getLocation(1)), /Ayşe Yılmaz — yıllık izin/);
  });

  let cookie, csrf;
  const panel = (route, data) => http('/yonetim' + route, data ? form({ csrf, ...data }, cookie) : { headers: { cookie } });
  await t.test('Panel bağlantısı süreli, tek kullanımlık ve onaycıya özel', async () => {
    assert.equal(await panelCommand(303), 'Bu komut yalnız yöneticiler için');
    const expired = await newLink();
    clock += 10 * 60 * 1000;
    assert.equal((await http(expired)).status, 401);
    const denied = await newLink();
    process.env.IZIN_ONAYCILAR = '202';
    assert.equal((await http(denied)).status, 401);
    process.env.IZIN_ONAYCILAR = '101,202';
    const link = await newLink();
    const pair = await Promise.all([http(link), http(link)]);
    assert.deepEqual(pair.map((r) => r.status).sort(), [302, 401]);
    const issued = pair.find((r) => r.status === 302).headers.getSetCookie()[0];
    for (const flag of ['HttpOnly', 'SameSite=Lax', 'Max-Age=2592000']) assert.ok(issued.includes(flag));
    cookie = issued.split(';')[0];
    const page = await panel('/');
    assert.equal(page.status, 200);
    csrf = (await page.text()).match(/name="csrf" value="([a-f0-9]+)"/)[1];
    process.env.IZIN_ONAYCILAR = '202';
    assert.equal((await panel('/')).status, 401);
    process.env.IZIN_ONAYCILAR = '101,202';
  });

  await t.test('Panelden onay, red, doğrudan rapor ve tüm POST işlemlerinde CSRF', async () => {
    newWindow();
    const a = (await request('2026-12-07')).body.id;
    const b = (await request('2026-12-08')).body.id;
    const direct = { employee_id: '1', start: '2026-12-11', end: '2026-12-14', type: 'rapor', note: 'Kontrol' };
    for (const route of ['/talep/' + a + '/onayla', '/talep/' + b + '/reddet', '/izin-ekle', '/cikis']) {
      assert.equal((await http('/yonetim' + route, form(direct, cookie))).status, 403);
    }
    assert.equal(byId(a).status, 'pending');
    let html = await (await panel('/')).text();
    assert.match(html, /Bekleyen talepler \(2\)/);
    const begin = calls.length;
    assert.equal((await panel('/talep/' + a + '/onayla', {})).status, 302);
    assert.equal((await panel('/talep/' + b + '/reddet', {})).status, 302);
    assert.equal(byId(a).status, 'approved');
    assert.equal(byId(b).status, 'rejected');
    assert.equal(calls.slice(begin).filter((c) => c.method === 'editMessageText').length, 4);
    assert.equal((await panel('/izin-ekle')).status, 200);
    assert.equal((await panel('/izin-ekle', direct)).status, 302);
    const reports = db.prepare("SELECT day,created_by,request_id FROM leaves WHERE type='rapor' ORDER BY day").all();
    assert.deepEqual(reports.map((r) => r.day), ['2026-12-11', '2026-12-14']);
    assert.ok(reports.every((r) => r.created_by === 'panel:Kağan'));
    assert.equal(byId(reports[0].request_id).kind, 'rapor');
    html = await (await panel('/takvim?ay=2026-12')).text();
    assert.match(html, /11\.12\.2026/);
    assert.match(html, /Rapor 2 gün/);
    assert.match(html, /Tür belirtilmemiş 1 gün/);
    for (const [day, label] of [['2026-12-11', 'raporlu'], ['2026-12-02', 'izinli']]) {
      assert.ok(tg.morningText(service.dayOverview(day, 1), service.getLocation(1)).includes('Ayşe Yılmaz — ' + label));
    }
    assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE actor='panel:Kağan' AND action='leave_request_reject'").get().n, 1);
  });

  await t.test('Kişiler ekranında kıdem eşikleri, yıl ve yıldönümü hesapları', async () => {
    for (const day of ['2025-12-02', '2026-01-05', '2026-11-26']) service.addLeave({ employeeId: 1, fromDay: day, toDay: day, type: 'yillik' });
    let html = await (await panel('/kisiler')).text();
    assert.match(html, /Yıllık izin 2 gün/);
    assert.match(html, /Kıdem 5 yıl/);
    assert.match(html, /Yıllık izin hakkı 14 gün · Son yıldönümünden beri kullanılan 1 gün · Kalan 13 gün/);
    assert.match(html, /İşe giriş tarihi girilmemiş/);
    for (const [hire, years, granted] of [['2026-11-25', 0, 0], ['2025-11-26', 1, 14], ['2020-11-26', 6, 20], ['2011-11-26', 15, 26]]) {
      db.prepare('UPDATE employees SET hire_date=? WHERE id=1').run(hire);
      html = await (await panel('/kisiler')).text();
      assert.ok(html.includes('Kıdem ' + years + ' yıl'));
      assert.ok(html.includes('Yıllık izin hakkı ' + granted + ' gün'));
    }
  });

  await t.test('Onaycısız talep panelde görünür, liste son 10 kayıtla sınırlıdır', async () => {
    newWindow();
    process.env.IZIN_ONAYCILAR = '';
    const begin = calls.length;
    const result = await request('2026-11-28', '2026-11-28', { token: 'can', type: 'ucretsiz' });
    assert.equal(result.status, 201);
    assert.deepEqual(JSON.parse(byId(result.body.id).tg_msgs), []);
    assert.equal(calls.length, begin);
    process.env.IZIN_ONAYCILAR = '101,202';
    assert.match(await (await panel('/')).text(), /Can Kaya/);
    const ids = [];
    for (let i = 0; i < 11; i++) {
      newWindow();
      const r = await request('2026-12-21', '2026-12-21', { token: 'can' });
      ids.unshift(r.body.id);
      assert.equal((await api('/api/izin/' + r.body.id + '/iptal', { token: 'can' })).status, 200);
    }
    const list = (await api('/api/izin?token=can')).body.talepler;
    assert.deepEqual(list.map((r) => r.id), ids.slice(0, 10));
    assert.ok(list.every((r) => r.durum === 'İptal edildi'));
    assert.ok(calls.slice(begin).filter((c) => c.method === 'sendMessage').every((c) => c.bot === 'bottest-main'));
  });

  await t.test('Karardan sonra ulaşan Telegram kopyası da güncellenir', async () => {
    newWindow();
    let release, started;
    const waiting = new Promise((done) => { started = done; });
    const gate = new Promise((done) => { release = done; });
    delaySend = async (call) => { if (call.chat_id === '202') { started(call); await gate; } };
    const pending = request('2026-12-22');
    const slow = await waiting;
    try {
      await callback(101, slow.reply_markup.inline_keyboard[0][0].callback_data);
    } finally {
      delaySend = null;
      release();
    }
    const { body } = await pending;
    for (const copy of JSON.parse(byId(body.id).tg_msgs)) {
      assert.ok(calls.some((c) => c.method === 'editMessageText' && c.chat_id === copy.chat_id &&
        c.message_id === copy.message_id && c.text.includes('✅ Onaylandı')));
    }
  });

  await t.test('Admin düzenleme, tür etiketleri ve Excel toplamları', async () => {
    const login = await http('/admin/giris', form({ password: 'izin-test' }));
    const admin = login.headers.getSetCookie()[0].split(';')[0];
    const options = { headers: { cookie: admin } };
    assert.match(await (await http('/admin/personel', options)).text(), /name="hire_date"/);
    const edit = { name: 'Can Kaya', phone: '05552222222', location_id: '2', status: 'active', hire_date: '2010-01-01' };
    await http('/admin/personel/2/guncelle', form(edit, admin));
    assert.equal(db.prepare('SELECT hire_date FROM employees WHERE id=2').get().hire_date, edit.hire_date);
    await http('/admin/izinler/ekle', form({ employee_id: '2', baslangic: '2026-12-11', bitis: '2026-12-11', type: 'mazeret' }, admin));
    const range = '?baslangic=2026-12-11&bitis=2026-12-14';
    assert.match(await (await http('/admin/izinler' + range, options)).text(), /Mazeret izni/);
    assert.match(tg.morningText(service.dayOverview('2026-12-11', 2), service.getLocation(2)), /Can Kaya — mazeret izni/);
    const html = await (await http('/admin/rapor' + range, options)).text();
    for (const label of ['İzinli (rapor)', 'İzinli (mazeret)', 'Rapor (gün)', 'İzin (gün)']) assert.ok(html.includes(label));
    const Excel = require(path.join(repo, 'node_modules/exceljs'));
    const book = new Excel.Workbook();
    await book.xlsx.load(Buffer.from(await (await http('/admin/rapor/xlsx' + range, options)).arrayBuffer()));
    assert.ok(book.getWorksheet('Günlük').getColumn(8).values.some((n) => n && n.includes('İzinli (rapor)')));
    const sheet = book.getWorksheet('Personel Toplamları');
    const headers = sheet.getRow(1).values;
    const person = sheet.getRow(2).values;
    assert.equal(person[1], 'Ayşe Yılmaz');
    assert.equal(person[headers.indexOf('Rapor (gün)')], 2);
    assert.equal(person[headers.indexOf('İzin Günü')], 2);
  });

  await t.test('Panelden çıkış ve 30 günlük oturum süresi', async () => {
    const out = await panel('/cikis', {});
    assert.ok(out.headers.getSetCookie().some((s) => s.startsWith('yonetim=;')));
    assert.equal((await http('/yonetim')).status, 401);
    clock += 30 * 24 * 60 * 60 * 1000;
    assert.equal((await panel('/')).status, 401);
  });
});
