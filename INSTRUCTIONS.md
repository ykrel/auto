# Şile Bezi — Ürün Açıklaması Yazım İşi (bağımsız paket)

Bu paket, bir B2B toptan giyim sitesinin (Şile bezi / Turkish cotton gauze) ürün
açıklamalarını 5 dilde yazma işidir. İnternet veya veritabanı erişimi GEREKMEZ —
her şey bu klasördedir.

## Yapılacak iş

1. `spec.md`'yi OKU — yazım kuralları, dil terminolojisi, isim çevirim tablosu,
   anti-şablon kuralları orada. Bu spec bağlayıcıdır.
2. `batches/job-00.json` … `job-22.json` dosyalarının HER BİRİ için, spec'e göre
   `output/out-00.json` … `out-22.json` dosyasını yaz (aynı numara → aynı dosya).
   - Her batch ~25 ürün; her ürün için: `tr` açıklaması + `en/de/fr/es`
     `{name, desc}` çifti. Format örneği: `example-output.json`.
   - Çıktıyı ARTIMLI yaz: her ~5 üründe bir dosyayı kaydet ki kesinti olursa iş
     kaybolmasın. Sonda dosyanın tek parça geçerli JSON olduğundan emin ol.
3. Batch'leri paralel subagent'larla yazdırabilirsin (öneri: 5-8 paralel,
   her ajana bir batch + spec yolu). Her ajan kendi out-XX.json'ını yazsın.
4. İş bitince kök klasörden `python3 validate.py` çalıştır — `missing: 0` ve
   exit 0 olmalı. Eksik/bozuk varsa tamamla, tekrar doğrula.
5. Sonucu paketle:
   `zip -r silebezi-desc-results.zip output/`
   Bu zip'i kullanıcıya geri ver. (Sadece `output/` klasörü yeterli.)

## Kalite çıtası (özet — detay spec'te)

- Metinler İNSAN yazımı gibi: şablon açılış tekrarı yok, "Discover/Elevate/
  Crafted from" kalıpları yok, ünlem yok, üçlü sıfat listesi yok.
- Her dil kendi pazarının kumaş terimini kullanır: EN cotton gauze/muslin/double
  gauze, DE Musselin, FR gaze de coton/double gaze, ES muselina/bámbula.
- Üründe OLMAYAN özellik uydurma (cep, astar vb. sadece isim/veri söylüyorsa).
- Uzunluk: dil başına toplam 45–80 kelime, 2 kısa paragraf.

## Dosya sözlüğü

| Dosya | Ne |
|---|---|
| `spec.md` | Bağlayıcı yazım spec'i |
| `batches/job-XX.json` | Girdi: ürün listeleri (~25'erli, 555 ürün) |
| `output/` | Çıktıların yazılacağı klasör |
| `example-output.json` | Bitmiş bir çıktının örneği (format referansı) |
| `validate.py` | Son kontrol scripti (`python3 validate.py`) |
