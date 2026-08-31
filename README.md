# QR ile Personel Giriş-Çıkış Takip Sistemi (PDKS)

Personel, lokasyondaki basılı QR kodu telefon kamerasıyla okutur; tarayıcıda açılan sayfa
giriş veya çıkış kaydını oluşturur. **Uygulama kurulumu yoktur.** Cihaz kimliği kalıcı bir
token ile, konum ise telefonun GPS'i ile doğrulanır.

- Node.js + Express + SQLite (better-sqlite3), sunucu tarafı render (EJS), sade vanilla JS
- Tamamen Türkçe, mobil öncelikli arayüz
- Kayıtlar UTC tutulur, ekranda Europe/Istanbul saatiyle gösterilir
- Gün tanımı **04:00 – ertesi gün 04:00**
- Railway'e tek servis olarak deploy edilir

---

## 1. Hızlı başlangıç (yerel)

```bash
npm install
ADMIN_PASSWORD=gizli-sifre BASE_URL=http://localhost:3000 npm start
```

- Personel ekranı: `http://localhost:3000/c/umraniye`
- Yönetici paneli: `http://localhost:3000/admin` (şifre: `ADMIN_PASSWORD`)

İlk açılışta 4 lokasyon **placeholder koordinatlarla** otomatik oluşturulur:
Ümraniye, Kadıköy, Manavgat, Çınarcık. Gerçek koordinatları admin panelinden girin.

### Ortam değişkenleri

| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `ADMIN_PASSWORD` | evet | Yönetici paneli şifresi |
| `BASE_URL` | evet | QR içeriğinde kullanılan genel adres, örn. `https://pdks.sirket.com` (sonunda `/` olmadan) |
| `PORT` | hayır | Railway otomatik verir; yerelde varsayılan 3000 |
| `DATA_DIR` | evet (Railway) | SQLite dosyasının tutulduğu klasör, örn. `/data` |
| `SESSION_SECRET` | hayır | Admin oturum imzalama anahtarı; verilmezse `ADMIN_PASSWORD`'dan türetilir |

Örnek dosya: `.env.example`

---

## 2. Railway'e deploy

1. **Projeyi bağlayın.** Railway → *New Project* → *Deploy from GitHub repo* → bu depoyu ve
   ilgili dalı seçin. Nixpacks `package.json`'ı görüp `npm start` ile başlatır
   (`railway.json` içinde tanımlı, sağlık kontrolü `/saglik`).

2. **Volume ekleyin (önemli — SQLite verisi burada durur).**
   Servis → *Variables* yanındaki *Settings* → **Volumes** → *New Volume* →
   Mount path: `/data`. Volume olmadan her deploy'da veritabanı sıfırlanır.

3. **Değişkenleri girin.** Servis → *Variables*:
   ```
   ADMIN_PASSWORD=guclu-bir-sifre
   DATA_DIR=/data
   BASE_URL=https://<railway-domaininiz>
   ```
   `PORT` Railway tarafından otomatik verilir, elle eklemeyin.

4. **Domain alın.** Servis → *Settings* → *Networking* → **Generate Domain**
   (veya kendi alan adınızı bağlayın). Aldığınız adresi `BASE_URL`'e yazıp
   servisi yeniden deploy edin — QR kodları bu adresi içerecek.

5. **Kontrol.** `https://<domain>/saglik` → `{"ok":true,...}` dönmeli.
   `https://<domain>/admin` → yönetici girişi.

> Not: QR sayfası konum izni ister; tarayıcılar konumu yalnızca **HTTPS** üzerinde verir.
> Railway domaini zaten HTTPS'tir.

---

## 3. Lokasyon koordinatı girme ve QR basma

1. `/admin` → **Lokasyonlar**.
2. İlgili satırda **Düzenle**:
   - **Enlem (lat) / Boylam (lng):** Google Haritalar'da lokasyonun tam noktasına sağ tıklayın;
     en üstte çıkan `41.016500, 29.124800` değerini kopyalayıp iki alana ayrı ayrı yazın
     (ondalık ayracı **nokta**).
   - **Yarıçap (m):** varsayılan 150. Bina büyük veya GPS zayıfsa 200–300 yapabilirsiniz.
   - **Mesai başlangıcı:** örn. `08:30`. Geç kalma bu saate göre hesaplanır.
3. **Kaydet**.
4. Aynı satırda **PNG** düğmesi QR görselini indirir (**Göster** önizler).
   QR içeriği: `BASE_URL/c/<slug>`.
5. QR'ı A4/A5 basıp girişe asın. Öneri: en az 10×10 cm, mat kağıt, göz hizası.
   Altına "Giriş-çıkış için okutun" notu ekleyin.

Yeni bir lokasyon açmak için aynı sayfadaki **Lokasyon ekle** formunu kullanın; slug boş
bırakılırsa addan otomatik üretilir. `BASE_URL` değişirse QR'ları yeniden basmanız gerekir.

---

## 4. İlk personel onay akışı

1. Personel QR'ı okutur → **Ad Soyad + Telefon + KVKK onayı** formu çıkar.
2. Kayıt yöneticiye düşer; personelin ekranında "Onay bekleniyor" görünür.
3. `/admin` → **Personel** → *Onay bekleyenler* → **Onayla**.
4. Personel QR'ı tekrar okutur: cihaza 1 yıllık kalıcı token verilir (hem cookie hem
   localStorage'da tutulur, biri silinirse diğerinden geri yüklenir) ve **GİRİŞ** kaydı oluşur.
5. Personel sayfasında lokasyon ataması, kişiye özel mesai başlangıcı (boşsa lokasyonunki
   geçerlidir) ve aktif/pasif durumu düzenlenebilir.

### Telefon / cihaz değişikliği
Kayıt ekranındaki **"Daha önce kayıtlıyım"** → telefon numarası → eşleşirse yöneticiye
"cihaz değişikliği" talebi düşer. Onaylandığında yeni cihaz aktifleşir, eski cihazın
token'ı iptal edilir.

---

## 5. Günlük kullanım

**Okutma kuralları**
- Günün ilk okutması **GİRİŞ**, sonraki okutmalar **ÇIKIŞ**'tır; yeni okutma o günün
  son çıkışını günceller.
- Son okutmadan sonraki **2 dakika** içindeki tekrarlar yok sayılır (çift okutma koruması).
- Gün 04:00'te başlar; gece 23:00 ve 01:00 okutmaları aynı iş gününe yazılır.
- Saat her zaman sunucudan alınır, telefon saatine güvenilmez.

**Konum doğrulanamazsa**
Konum izni verilmezse, konum alınamazsa veya personel yarıçapın dışındaysa kayıt yine
oluşur; ekranda sarı "Kaydedildi, konum doğrulanamadı" uyarısı görünür, kayıt admin
panelinde ⚠ ile işaretlenir (`no_gps` / `out_of_range`). Kayıt hiçbir zaman engellenmez.

**Gizli sekme**
Gizli/özel sekmede cihaz kimliği saklanamaz; ekranda "Lütfen normal tarayıcı sekmesinde
açın" uyarısı çıkar ve kayıt alınmaz.

**Panel sekmeleri**
- **Bugün:** lokasyon filtresi; gelenler (mesai saatini geçen giriş kırmızı), henüz
  gelmeyenler, çıkış yapanlar, ⚠ işaretli kayıtlar.
- **Personel:** onay bekleyen talepler, aktif/pasif, lokasyon ataması, kişiye özel mesai.
- **Lokasyonlar:** ekle/düzenle, QR indirme.
- **Kayıtlar:** tarih aralığı + personel filtresi, manuel giriş/çıkış ekleme ve düzeltme.
- **Rapor:** tarih aralığı → **xlsx** indir.
  Sayfa 1 *Günlük*: gün × personel — giriş, çıkış, çalışma süresi, geç kalma dakikası.
  Sayfa 2 *Personel Toplam*: toplam çalışma, geç gelme sayısı, eksik çıkış sayısı.
- **Günlük (log):** onaylar, manuel eklemeler ve düzeltmeler — kim, ne zaman.

---

## 6. Güvenlik

- Tüm okutma uçları cihaz token'ı doğrular; admin uçları imzalı (HMAC-SHA256) session
  cookie'si ister.
- Rate limit: token (yoksa IP) başına dakikada 5 yazma isteği; admin girişinde IP başına
  dakikada 5 deneme.
- Manuel kayıt ekleme/düzeltme işlemleri `audit_log` tablosuna yazılır.
- KVKK: kayıt ekranında kısa aydınlatma metni ve açık onay kutusu vardır; ad, telefon,
  giriş-çıkış saati ve konum yalnızca devam takibi amacıyla işlenir.

---

## 7. Veri modeli

| Tablo | Alanlar |
|---|---|
| `employees` | id, name, phone (unique), location_id, status (pending/active/passive), shift_start, created_at |
| `devices` | id, employee_id, token (unique), active, user_agent, created_at, revoked_at |
| `locations` | id, slug (unique), name, lat, lng, radius_m, shift_start, active, created_at |
| `checkins` | id, employee_id, location_id, type (in/out), ts (UTC), business_day, lat, lng, accuracy, distance_m, flagged, flag_reason, source, edited_by, edited_at |
| `device_requests` | id, employee_id, device_id, location_id, name, phone, type (new/change), status, created_at, decided_at, decided_by |
| `audit_log` | id, actor, action, detail, created_at |

## 8. Dosya düzeni

```
src/server.js    Express uygulaması ve personel uçları (/c/:slug, /api/*)
src/admin.js     Yönetici paneli rotaları, QR ve xlsx üretimi
src/service.js   Okutma kuralları, günlük özet, rapor hesapları
src/db.js        SQLite şeması
src/time.js      Europe/Istanbul + 04:00 gün mantığı
src/seed.js      Başlangıç lokasyonları
views/           EJS şablonları
public/          CSS ve personel ekranı JavaScript'i
```

## 9. Yedekleme

Tüm veri `DATA_DIR` altındaki `pdks.sqlite` dosyasındadır. Railway'de volume'u
snapshot'lamak veya periyodik olarak xlsx raporu indirmek yedekleme için yeterlidir.
