'use strict';
// ik-belge yerel testi: sahte PDKS ile yükleme, red, tekrar, bozuk bilet, görüntüleme.
// Çalıştırma: node test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SECRET = crypto.randomBytes(32).toString('hex');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ikb-'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const PDKS_PORT = PORT + 1000;
const ORIGIN = `http://127.0.0.1:${PDKS_PORT}`;
const b64url = (b) => Buffer.from(b).toString('base64url');
const hmac = (m) => crypto.createHmac('sha256', SECRET).update(m).digest();
const now = () => Math.floor(Date.now() / 1000);

function ticket(over = {}) {
  const p = b64url(JSON.stringify({ v: 1, emp: 13, by: null, s: '2026-11-25', e: '2026-11-27', n: crypto.randomBytes(16).toString('hex'), x: now() + 900, ...over }));
  return p + '.' + b64url(hmac('bilet.' + p));
}
const viewUrl = (id, exp) => `/b/${id}?x=${exp}&s=${b64url(hmac('gor.' + id + '.' + exp))}`;

let pdksMode = 'ok'; const calls = []; let child; let pdks;
before(async () => {
  pdks = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const zaman = req.headers['x-ik-zaman'];
      const ok = req.headers['x-ik-imza'] === crypto.createHmac('sha256', SECRET).update('kayit.' + zaman + '.' + raw).digest('hex');
      calls.push({ url: req.url, ok, body: JSON.parse(raw) });
      if (!ok) { res.writeHead(401); return res.end('{}'); }
      if (pdksMode === 'red') { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Bu tarihler çakışıyor.' })); }
      res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, id: 77 }));
    });
  }).listen(PDKS_PORT);
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, IK_BELGE_SECRET: SECRET, PDKS_URL: ORIGIN, DATA_DIR: DATA, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => child.stdout.once('data', r));
});
after(() => { child.kill(); pdks.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const b = Buffer.concat(chunks); let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, headers: res.headers, json: j, buf: b }); });
    });
    r.on('error', reject); r.end(body);
  });
}
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(5000)]);
const PDF = Buffer.from('%PDF-1.4\n' + 'x'.repeat(2000));

test('sağlık', async () => { assert.equal((await req('GET', '/saglik')).json.ok, true); });

test('CORS ön isteği yalnız PDKS kökenine izin verir', async () => {
  const a = await req('OPTIONS', '/yukle', { headers: { Origin: ORIGIN } });
  assert.equal(a.headers['access-control-allow-origin'], ORIGIN);
  const b = await req('OPTIONS', '/yukle', { headers: { Origin: 'https://kotu.example' } });
  assert.equal(b.headers['access-control-allow-origin'], undefined);
});

let savedId;
test('başarılı yükleme PDKS\'ye imzalı kayıt gönderir, tekrar 409', async () => {
  const t = ticket();
  const r = await req('POST', '/yukle', { headers: { 'X-Bilet': t, 'Content-Type': 'image/jpeg', Origin: ORIGIN }, body: JPG });
  assert.equal(r.status, 201); assert.equal(r.json.id, 77);
  assert.equal(r.headers['access-control-allow-origin'], ORIGIN);
  const c = calls.at(-1); assert.ok(c.ok); assert.equal(c.url, '/api/belge/kayit');
  assert.equal(c.body.bilet, t); assert.match(c.body.belge.id, /^[a-f0-9]{32}$/);
  assert.equal(c.body.belge.tur, 'image/jpeg'); assert.equal(c.body.belge.boyut, JPG.length);
  assert.equal(c.body.belge.sha256, crypto.createHash('sha256').update(JPG).digest('hex'));
  savedId = c.body.belge.id;
  const again = await req('POST', '/yukle', { headers: { 'X-Bilet': t }, body: JPG });
  assert.equal(again.status, 409);
});

test('görüntüleme: doğru imza dosyayı verir, yanlış/süresi dolmuş vermez', async () => {
  const exp = now() + 60;
  const ok = await req('GET', viewUrl(savedId, exp));
  assert.equal(ok.status, 200); assert.equal(ok.headers['content-type'], 'image/jpeg'); assert.ok(ok.buf.equals(JPG));
  assert.equal((await req('GET', viewUrl(savedId, exp).replace(/s=./, 's=A'))).status, 403);
  assert.equal((await req('GET', viewUrl(savedId, now() - 5))).status, 410);
  assert.equal((await req('GET', viewUrl('0'.repeat(32), exp))).status, 404);
});

test('bozuk bilet, süresi dolmuş bilet, yanlış tür, boş ve büyük dosya', async () => {
  const t = ticket(); const bad = t.slice(0, -2) + (t.endsWith('A') ? 'BB' : 'AA');
  assert.equal((await req('POST', '/yukle', { headers: { 'X-Bilet': bad }, body: JPG })).status, 403);
  assert.equal((await req('POST', '/yukle', { body: JPG })).status, 403);
  assert.equal((await req('POST', '/yukle', { headers: { 'X-Bilet': ticket({ x: now() - 700 }) }, body: JPG })).status, 400);
  assert.equal((await req('POST', '/yukle', { headers: { 'X-Bilet': ticket() }, body: Buffer.from('<html>merhaba</html>') })).status, 415);
  assert.equal((await req('POST', '/yukle', { headers: { 'X-Bilet': ticket() }, body: Buffer.alloc(0) })).status, 400);
  assert.equal((await req('POST', '/yukle', { headers: { 'X-Bilet': ticket(), 'Content-Length': String(16 * 1024 * 1024) }, body: Buffer.alloc(0) }).catch(() => ({ status: 413 }))).status, 413);
});

test('PDKS reddederse dosya silinir ve hata personele döner', async () => {
  pdksMode = 'red';
  const before = fs.readdirSync(DATA, { recursive: true }).filter((f) => /\.(pdf|jpg)$/.test(f)).length;
  const r = await req('POST', '/yukle', { headers: { 'X-Bilet': ticket() }, body: PDF });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'Bu tarihler çakışıyor.');
  await new Promise((s) => setTimeout(s, 100));
  const afterN = fs.readdirSync(DATA, { recursive: true }).filter((f) => /\.(pdf|jpg)$/.test(f)).length;
  assert.equal(afterN, before);
  pdksMode = 'ok';
});
