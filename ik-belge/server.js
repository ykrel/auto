'use strict';
// ik-belge: PDKS'nin belge sunucusu (CT122, DL380). Bağımlılık yok.
// Tarayıcı raporu doğrudan buraya yükler; dosya Türkiye'de kalır, PDKS'ye (Railway) yalnız kimlik gider.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET = process.env.IK_BELGE_SECRET || '';
const PDKS_URL = (process.env.PDKS_URL || 'https://pdks-qr-production.up.railway.app').replace(/\/+$/, '');
const PDKS_ORIGIN = new URL(PDKS_URL).origin;
const DATA = process.env.DATA_DIR || '/srv/ik-belge/data';
const PORT = Number(process.env.PORT) || 8080;
const MAX_BYTES = 15 * 1024 * 1024;
const TICKET_GRACE_S = 600;

if (SECRET.length < 32) { console.error('IK_BELGE_SECRET eksik'); process.exit(1); }

const dirs = { belge: path.join(DATA, 'belge'), tmp: path.join(DATA, 'tmp'), nonce: path.join(DATA, 'nonce'), log: path.join(DATA, 'log') };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (m) => crypto.createHmac('sha256', SECRET).update(m).digest();
function safeEq(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const now = () => Math.floor(Date.now() / 1000);

function verifyTicket(bilet) {
  if (typeof bilet !== 'string' || bilet.length > 1000) return null;
  const [p, s, extra] = bilet.split('.');
  if (!p || !s || extra !== undefined) return null;
  if (!safeEq(s, b64url(hmac('bilet.' + p)))) return null;
  let t; try { t = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return null; }
  if (!t || t.v !== 1 || !/^[a-f0-9]{32}$/.test(t.n || '') || !Number.isInteger(t.x)) return null;
  return t;
}

function logLine(o) {
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFile(path.join(dirs.log, day + '.log'), JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n', { mode: 0o600 }, () => {});
}

// Dosya türü uzantıya ya da başlığa değil, içeriğin ilk baytlarına göre belirlenir.
function sniff(h) {
  if (h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return ['image/jpeg', 'jpg'];
  if (h.length >= 8 && h.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['image/png', 'png'];
  if (h.length >= 5 && h.slice(0, 5).toString('latin1') === '%PDF-') return ['application/pdf', 'pdf'];
  if (h.length >= 12 && h.slice(0, 4).toString('latin1') === 'RIFF' && h.slice(8, 12).toString('latin1') === 'WEBP') return ['image/webp', 'webp'];
  if (h.length >= 12 && h.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = h.slice(8, 12).toString('latin1');
    if (/^(heic|heix|hevc|hevx|heim|heis)$/.test(brand)) return ['image/heic', 'heic'];
    if (/^(mif1|msf1|avif)$/.test(brand)) return ['image/heif', 'heif'];
  }
  return null;
}

function send(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function cors(req) {
  return req.headers.origin === PDKS_ORIGIN ? {
    'Access-Control-Allow-Origin': PDKS_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Bilet, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  } : {};
}

function callPdks(payload) {
  const raw = JSON.stringify(payload);
  const zaman = String(now());
  const imza = crypto.createHmac('sha256', SECRET).update('kayit.' + zaman + '.' + raw).digest('hex');
  const u = new URL(PDKS_URL + '/api/belge/kayit');
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const rq = lib.request(u, {
      method: 'POST', timeout: 20000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), 'X-Ik-Zaman': zaman, 'X-Ik-Imza': imza }
    }, (rs) => {
      let b = ''; rs.setEncoding('utf8');
      rs.on('data', (c) => { if (b.length < 10000) b += c; });
      rs.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch {} resolve({ status: rs.statusCode, body: j }); });
    });
    rq.on('timeout', () => rq.destroy(new Error('timeout')));
    rq.on('error', reject);
    rq.end(raw);
  });
}

function upload(req, res) {
  // Gövde okunmadan dönülen hatalarda bağlantı kapanır (yarım gövde sonraki isteğe karışmasın).
  const h = { ...cors(req), Connection: 'close' };
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  const t = verifyTicket(req.headers['x-bilet']);
  if (!t) return send(res, 403, { error: 'Geçersiz yükleme isteği. Sayfayı yenileyip tekrar deneyin.' }, h);
  if (now() > t.x + TICKET_GRACE_S) return send(res, 400, { error: 'Yükleme süresi doldu, tekrar deneyin.' }, h);
  const noncePath = path.join(dirs.nonce, t.n);
  if (fs.existsSync(noncePath)) return send(res, 409, { error: 'Bu yükleme zaten yapıldı.' }, h);
  const len = Number(req.headers['content-length']);
  if (len > MAX_BYTES) return send(res, 413, { error: 'Dosya çok büyük (en çok 15 MB).' }, h);

  const id = crypto.randomBytes(16).toString('hex');
  const tmp = path.join(dirs.tmp, id);
  const out = fs.createWriteStream(tmp, { mode: 0o600 });
  const sha = crypto.createHash('sha256');
  let size = 0; let head = Buffer.alloc(0); let failed = false;
  const fail = (code, msg) => {
    if (failed) return; failed = true;
    req.unpipe(); out.destroy(); fs.rm(tmp, { force: true }, () => {});
    send(res, code, { error: msg }, h);
    req.resume();
  };
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BYTES) return fail(413, 'Dosya çok büyük (en çok 15 MB).');
    if (head.length < 16) head = Buffer.concat([head, c.slice(0, 16)]);
    sha.update(c);
  });
  req.on('aborted', () => fail(400, 'Yükleme yarıda kesildi.'));
  req.pipe(out);
  out.on('error', () => fail(500, 'Dosya kaydedilemedi.'));
  out.on('finish', async () => {
    if (failed) return;
    if (!size) return fail(400, 'Dosya boş.');
    const kind = sniff(head);
    if (!kind) return fail(415, 'Yalnız fotoğraf (JPEG, PNG, HEIC) ya da PDF yüklenebilir.');
    const d = new Date();
    const dir = path.join(dirs.belge, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, id + '.' + kind[1]);
    const meta = { id, tur: kind[0], uzanti: kind[1], boyut: size, sha256: sha.digest('hex'), emp: t.emp, by: t.by, s: t.s, e: t.e, yuklendi: d.toISOString() };
    try {
      fs.renameSync(tmp, file);
      fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(meta), { mode: 0o600 });
    } catch { return fail(500, 'Dosya kaydedilemedi.'); }
    let r;
    try {
      r = await callPdks({ bilet: req.headers['x-bilet'], belge: { id, sha256: meta.sha256, boyut: size, tur: kind[0] } });
    } catch (e) {
      r = { status: 502, body: { error: 'Sunucuya ulaşılamadı, tekrar deneyin.' } };
    }
    if (r.status === 201) {
      fs.writeFileSync(noncePath, String(r.body.id || ''), { mode: 0o600 });
      meta.talep = r.body.id;
      fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(meta), { mode: 0o600 });
      logLine({ olay: 'yukleme', id, talep: r.body.id, emp: t.emp, by: t.by, boyut: size, tur: kind[0], ip });
      return send(res, 201, { ok: true, id: r.body.id }, cors(req));
    }
    // PDKS kabul etmediyse dosya tutulmaz.
    fs.rm(file, { force: true }, () => {});
    fs.rm(path.join(dir, id + '.json'), { force: true }, () => {});
    logLine({ olay: 'red', emp: t.emp, pdks: r.status, ip });
    const code = r.status >= 400 && r.status < 500 ? r.status : 502;
    send(res, code, { error: (r.body && r.body.error) || 'Yükleme başarısız, tekrar deneyin.' }, h);
  });
}

function findFile(id) {
  const base = dirs.belge;
  for (const y of fs.readdirSync(base)) {
    for (const m of fs.readdirSync(path.join(base, y))) {
      const metaPath = path.join(base, y, m, id + '.json');
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        return { meta, file: path.join(base, y, m, id + '.' + meta.uzanti) };
      }
    }
  }
  return null;
}

function view(req, res, id, q) {
  const x = Number(q.get('x'));
  const s = q.get('s') || '';
  const page = (code, msg) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Belge</title><p style="font:16px sans-serif;margin:2em">${msg}</p>`);
  };
  if (!Number.isInteger(x) || !safeEq(s, b64url(hmac('gor.' + id + '.' + x)))) return page(403, 'Bağlantı geçersiz.');
  if (now() > x) return page(410, 'Bağlantının süresi doldu. Paneldeki ya da bottaki güncel bağlantıyı kullanın.');
  const f = findFile(id);
  if (!f || !fs.existsSync(f.file)) return page(404, 'Belge bulunamadı.');
  logLine({ olay: 'goruntuleme', id, ip: req.headers['cf-connecting-ip'] || req.socket.remoteAddress });
  res.writeHead(200, {
    'Content-Type': f.meta.tur,
    'Content-Length': f.meta.boyut,
    'Content-Disposition': `inline; filename="rapor-${f.meta.talep || id}.${f.meta.uzanti}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer',
    // PDF'te CSP sandbox Chrome'un PDF görüntüleyicisini engeller; yalnız resimde.
    ...(f.meta.tur === 'application/pdf' ? {} : { 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" })
  });
  fs.createReadStream(f.file).pipe(res);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/saglik' && req.method === 'GET') return send(res, 200, { ok: true });
    if (u.pathname === '/yukle') {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors(req)); return res.end(); }
      if (req.method === 'POST') return upload(req, res);
      return send(res, 405, { error: 'Yöntem desteklenmiyor.' });
    }
    const m = u.pathname.match(/^\/b\/([a-f0-9]{32})$/);
    if (m && req.method === 'GET') return view(req, res, m[1], u.searchParams);
    send(res, 404, { error: 'Bulunamadı.' }, { 'X-Robots-Tag': 'noindex' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Sunucu hatası.' });
  }
});
server.requestTimeout = 300000;
server.listen(PORT, () => console.log(`ik-belge ${PORT} dinliyor; PDKS ${PDKS_ORIGIN}`));

// Bir günden eski yarım kalmış geçici dosyaları temizle.
setInterval(() => {
  for (const f of fs.readdirSync(dirs.tmp)) {
    const p = path.join(dirs.tmp, f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 86400000) fs.rmSync(p, { force: true }); } catch {}
  }
}, 3600000).unref();
