# Stremio Local Proxy HLS

A userscript that routes Stremio Web's `http://127.0.0.1:11470/proxy/...` requests through
`GM_xmlhttpRequest` and plays them with hls.js/MSE.

## Install

Download `stremio-local-proxy-hls.user.js` from the
[releases page](https://github.com/stremio-worker/stremio-userscript/releases) and paste it
into your userscript manager's "add new script" screen, or point the manager at the file if
it can read a local path. Reload the Stremio Web tab afterwards.

## Notes

- hls.js is not bundled. The `@require` line in `metadata.txt` makes the userscript manager
  load it instead.
- If a piece of hls.js ever slips into the bundle, `build.mjs` fails the build.
