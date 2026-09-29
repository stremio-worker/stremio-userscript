# Stremio Local Proxy HLS

Stremio Web'in `http://127.0.0.1:11470/proxy/...` isteklerini `GM_xmlhttpRequest` uzerinden
gecirip hls.js/MSE ile oynatan userscript.

## Kurulum

`stremio-local-proxy-hls.user.js` dosyasini indirip Violentmonkey veya Tampermonkey'nin
"yeni script ekle" ekranina yapistirin. Ardindan Stremio Web sekmesini yenileyin.

## Notlar

- hls.js paketlenmez; `metadata.txt` icindeki `@require` satiri sayesinde
  userscript yoneticisi tarafindan yuklenir.
- Kurulum `hls.js`'in bir parcasi yanlislikla bundle'a girerse `build.mjs` hata verir.
