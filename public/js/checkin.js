/* PDKS personel okutma akışı — sade vanilla JS */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var SLUG = app.getAttribute('data-slug');
  var LS_KEY = 'pdks_token';
  var COOKIE = 'pdks_token';
  var GEO_TIMEOUT = 12000;

  function $(id) { return document.getElementById(id); }

  function show(id) {
    ['s-loading', 's-nostorage', 's-register', 's-change', 's-pending', 's-action', 's-result', 's-confirm', 's-message']
      .forEach(function (s) { $(s).classList.toggle('hidden', s !== id); });
  }

  function setLoading(text) {
    $('loading-text').textContent = text;
    show('s-loading');
  }

  function message(title, body, kind, retry) {
    $('message-title').textContent = title;
    $('message-body').textContent = body;
    $('message-body').className = 'notice notice-' + (kind || 'err');
    $('message-retry').classList.toggle('hidden', !retry);
    show('s-message');
  }

  // --- depolama ---
  function storageOk() {
    try {
      window.localStorage.setItem('pdks_test', '1');
      window.localStorage.removeItem('pdks_test');
      return true;
    } catch (e) {
      return false;
    }
  }

  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split('; ') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (kv[0] === name) return decodeURIComponent(kv.slice(1).join('='));
    }
    return null;
  }

  function writeCookie(name, value) {
    var maxAge = 365 * 24 * 3600;
    var secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = name + '=' + encodeURIComponent(value) + '; path=/; max-age=' + maxAge + '; SameSite=Lax' + secure;
  }

  // Cookie ve localStorage birbirinin yedeği: biri silinirse diğerinden geri yüklenir
  function loadToken() {
    var fromCookie = readCookie(COOKIE);
    var fromLs = null;
    try { fromLs = window.localStorage.getItem(LS_KEY); } catch (e) { fromLs = null; }
    var token = fromCookie || fromLs;
    if (token) saveToken(token);
    return token;
  }

  function saveToken(token) {
    try { window.localStorage.setItem(LS_KEY, token); } catch (e) { /* yoksay */ }
    writeCookie(COOKIE, token);
  }

  function clearToken() {
    try { window.localStorage.removeItem(LS_KEY); } catch (e) { /* yoksay */ }
    document.cookie = COOKIE + '=; path=/; max-age=0; SameSite=Lax';
  }

  function post(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(data || {})
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { status: res.status, body: body };
      });
    });
  }

  // --- konum ---
  function getPosition() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve({ coords: null, reason: 'unsupported' });
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve({ coords: null, reason: 'timeout' }); }
      }, GEO_TIMEOUT + 1500);
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          if (done) return;
          done = true; clearTimeout(timer);
          resolve({
            coords: {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              accuracy: pos.coords.accuracy
            }
          });
        },
        function (err) {
          if (done) return;
          done = true; clearTimeout(timer);
          resolve({ coords: null, reason: err && err.code === 1 ? 'denied' : 'unavailable' });
        },
        { enableHighAccuracy: true, timeout: GEO_TIMEOUT, maximumAge: 0 }
      );
    });
  }

  function geoErrorMessage(reason) {
    if (reason === 'denied') {
      return {
        title: 'Konum izni reddedilmiş',
        body: 'Tarayıcı bu site için konum iznini reddetmiş, bu yüzden soru sorulmuyor. ' +
          'iPhone (Safari): adres çubuğundaki "aA" simgesi → Web Sitesi Ayarları → Konum → İzin Ver. ' +
          'iPhone (Chrome): telefonun Ayarlar → Chrome → Konum → "Uygulamayı Kullanırken" seçin, sonra sayfayı yenileyin. ' +
          'Olmazsa: Ayarlar → Gizlilik ve Güvenlik → Konum Servisleri açık olmalı. ' +
          'Android (Chrome): adres çubuğundaki kilit simgesi → İzinler → Konum → İzin Ver. ' +
          'QR\'ı WhatsApp/Instagram içinde açtıysanız kamerayla okutup normal tarayıcıda açın. ' +
          'Sonra "Tekrar dene"ye basın.'
      };
    }
    return {
      title: 'Konum alınamadı',
      body: 'GPS sinyali alınamadı. Telefonunuzun konum servislerinin açık olduğundan emin olun, ' +
        'mümkünse açık alana geçin ve tekrar deneyin. Giriş-çıkış için konum doğrulaması zorunludur.'
    };
  }

  // --- ekranlar ---
  function renderResult(data) {
    var isIn = data.type === 'in';
    var box = $('result-box');
    box.className = 'big-result ' + (isIn ? 'in' : 'out');
    $('result-type').textContent = isIn ? 'GİRİŞ' : 'ÇIKIŞ';
    $('result-time').textContent = data.time;
    $('result-name').textContent = data.name;
    $('result-location').textContent = data.location;
    var flagBox = $('result-flag');
    var flagText = '';
    if (data.flagged) {
      flagText = data.flag_reason === 'out_of_range'
        ? 'Kaydedildi, konum doğrulanamadı (lokasyon dışındasınız).'
        : 'Kaydedildi, konum doğrulanamadı.';
    } else if (data.late && data.type === 'in') {
      flagText = '⏰ Geç giriş kaydedildi — mesai başlangıcı ' + (data.shiftStart || '08:30') + '. Lütfen zamanında gelmeye özen gösterin.';
    }
    flagBox.classList.toggle('hidden', !flagText);
    if (flagText) flagBox.textContent = flagText;
    $('result-dup').classList.toggle('hidden', !data.duplicate);
    var today = data.today || [];
    $('today-list').textContent = today.length
      ? 'Bugün: ' + today.map(function (c) {
          return (c.type === 'in' ? 'giriş ' : 'çıkış ') + c.time;
        }).join(' · ')
      : '';
    show('s-result');
  }

  function renderPending(name, type) {
    $('pending-name').textContent = name ? name + ' — ' + (type === 'change' ? 'cihaz değişikliği talebi' : 'yeni kayıt talebi') : '';
    show('s-pending');
  }

  // Sayfa açılınca otomatik işlem YAPILMAZ: duruma göre tek buton gösterilir.
  function renderAction(body, token) {
    var today = body.today || [];
    var next = today.length ? 'out' : 'in';
    var btn = $('action-btn');
    btn.textContent = next === 'in' ? 'GİRİŞ YAP' : 'ÇIKIŞ YAP';
    btn.style.background = next === 'in' ? '#16a34a' : '#ea580c';
    btn.onclick = function () { doCheckin(token); };
    $('action-name').textContent = body.name || '';
    $('action-today').textContent = today.length
      ? 'Bugün: ' + today.map(function (c) {
          return (c.type === 'in' ? 'giriş ' : 'çıkış ') + c.time;
        }).join(' · ')
      : '';
    show('s-action');
  }

  // --- akış ---
  function sendCheckin(token, coords, confirm) {
    return post('/api/checkin', {
      token: token,
      slug: SLUG,
      lat: coords.lat,
      lng: coords.lng,
      accuracy: coords.accuracy,
      confirm: confirm === true
    });
  }

  function doCheckin(token) {
    setLoading('Konum alınıyor…');
    getPosition().then(function (geo) {
      var coords = geo && geo.coords;
      if (!coords) {
        var m = geoErrorMessage(geo && geo.reason);
        message(m.title, m.body, 'err', true);
        return null;
      }
      setLoading('Kaydediliyor…');
      return sendCheckin(token, coords, false).then(function (res) {
        return { res: res, coords: coords };
      });
    }).then(function (wrap) {
      if (!wrap) return;
      var res = wrap.res;
      var coords = wrap.coords;
      var body = res.body || {};
      if (res.status === 200) return renderResult(body);
      if (body.state === 'confirm_required') {
        $('confirm-body').textContent =
          'Mesai bitiminden önce çıkış yapıyorsunuz (saat ' + (body.nowTime || '') + '). Çıkışı onaylıyor musunuz?';
        $('confirm-yes').onclick = function () {
          setLoading('Kaydediliyor…');
          sendCheckin(token, coords, true).then(function (res2) {
            var b2 = res2.body || {};
            if (res2.status === 200) return renderResult(b2);
            return message('Kayıt alınamadı', b2.error || 'Beklenmeyen bir hata oluştu.', 'err', true);
          }).catch(function () {
            message('Bağlantı hatası', 'İnternet bağlantınızı kontrol edip tekrar deneyin.', 'err', true);
          });
        };
        $('confirm-no').onclick = function () { boot(); }; // vazgeçince butona geri dön
        return show('s-confirm');
      }
      if (body.state === 'location_rejected') {
        return message(
          body.reason === 'out_of_range' ? 'İş yerinde değilsiniz' : 'Konum alınamadı',
          body.error || 'Konum doğrulanamadı. Kayıt alınmadı.',
          'err',
          true
        );
      }
      if (body.state === 'pending') return renderPending(body.name);
      if (body.state === 'unknown') { clearToken(); return startRegister(); }
      if (body.state === 'revoked' || body.state === 'rejected') {
        clearToken();
        return message(
          'Cihaz kaydı geçersiz',
          'Bu cihazın kaydı iptal edilmiş. Lütfen yeniden kayıt olun.',
          'err',
          true
        );
      }
      if (body.state === 'passive') {
        return message('Kayıt pasif', 'Kaydınız pasif durumda. Lütfen yöneticinizle görüşün.', 'err', false);
      }
      if (res.status === 429) {
        return message('Çok fazla deneme', body.message || 'Lütfen biraz bekleyip tekrar deneyin.', 'warn', true);
      }
      return message('Kayıt alınamadı', body.error || 'Beklenmeyen bir hata oluştu.', 'err', true);
    }).catch(function () {
      message('Bağlantı hatası', 'İnternet bağlantınızı kontrol edip tekrar deneyin.', 'err', true);
    });
  }

  function startRegister() { show('s-register'); }
  function startChange() { show('s-change'); }

  function boot() {
    if (!storageOk()) return show('s-nostorage');
    var token = loadToken();
    if (!token) return startRegister();

    setLoading('Kimlik doğrulanıyor…');
    post('/api/identify', { token: token }).then(function (res) {
      var body = res.body || {};
      if (body.state === 'ok') return renderAction(body, token);
      if (body.state === 'pending') return renderPending(body.name);
      if (body.state === 'passive') {
        return message('Kayıt pasif', 'Kaydınız pasif durumda. Lütfen yöneticinizle görüşün.', 'err', false);
      }
      if (body.state === 'revoked' || body.state === 'rejected') {
        clearToken();
        return message('Cihaz kaydı geçersiz', 'Bu cihazın kaydı iptal edilmiş. Lütfen yeniden kayıt olun.', 'err', true);
      }
      clearToken();
      return startRegister();
    }).catch(function () {
      message('Bağlantı hatası', 'İnternet bağlantınızı kontrol edip tekrar deneyin.', 'err', true);
    });
  }

  // --- form olayları ---
  $('register-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var err = $('register-error');
    err.classList.add('hidden');
    var btn = $('register-submit');
    btn.disabled = true;
    post('/api/register', {
      slug: SLUG,
      name: $('name').value,
      phone: $('phone').value,
      kvkk: $('kvkk').checked
    }).then(function (res) {
      btn.disabled = false;
      var body = res.body || {};
      if (res.status === 200 && body.token) {
        saveToken(body.token);
        return renderPending(body.name, 'new');
      }
      if (body.code === 'already_registered') {
        $('change-phone').value = $('phone').value;
        startChange();
        var cerr = $('change-error');
        cerr.textContent = body.error;
        cerr.classList.remove('hidden');
        return;
      }
      err.textContent = body.error || body.message || 'Kayıt gönderilemedi.';
      err.classList.remove('hidden');
    }).catch(function () {
      btn.disabled = false;
      err.textContent = 'Bağlantı hatası. Tekrar deneyin.';
      err.classList.remove('hidden');
    });
  });

  $('change-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var err = $('change-error');
    err.classList.add('hidden');
    var btn = $('change-submit');
    btn.disabled = true;
    post('/api/device-change', { slug: SLUG, phone: $('change-phone').value }).then(function (res) {
      btn.disabled = false;
      var body = res.body || {};
      if (res.status === 200 && body.token) {
        saveToken(body.token);
        return renderPending(body.name, 'change');
      }
      err.textContent = body.error || body.message || 'Talep gönderilemedi.';
      err.classList.remove('hidden');
    }).catch(function () {
      btn.disabled = false;
      err.textContent = 'Bağlantı hatası. Tekrar deneyin.';
      err.classList.remove('hidden');
    });
  });

  $('link-change').addEventListener('click', function (ev) { ev.preventDefault(); startChange(); });
  $('link-register').addEventListener('click', function (ev) { ev.preventDefault(); startRegister(); });
  $('message-retry').addEventListener('click', function () { boot(); });

  boot();
})();
