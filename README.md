# Stremio Local Proxy HLS (userscript)

Stremio Web asks for `http://127.0.0.1:11470/proxy/...` URLs from inside an
`https://` page. The browser refuses them as mixed content, and even without that the local
origin sends no CORS headers, so hls.js cannot read a response. This userscript takes over
that part: it fetches the proxy URLs through `GM_xmlhttpRequest`, rewrites the segment
addresses inside the playlist, and plays the result with hls.js/MSE.

**In one sentence:** it stays completely out of the way of everything the page does for
itself, and only plays the local service's `/proxy/` requests through its own path.

## Requirements

- The local service must be running and reachable at `http://127.0.0.1:11470` (or whatever
  you point the script at, see [Settings](#settings)).
- A userscript manager that provides `GM_xmlhttpRequest` (Violentmonkey or Tampermonkey).
  On Tampermonkey, also set **Settings → Security → Check @connect:** to **Casual**, see
  [Install](#install).
- Stremio Web (`https://web.stremio.com/*`). No other site is targeted.
- Node.js 20+, for building only.

## Install

Download `stremio-local-proxy-hls.user.js` from the
[releases page](https://github.com/stremio-worker/stremio-userscript/releases) and paste it
into the manager's "add new script" screen, or point the manager at the file if it can read
a local path. Reload the Stremio Web tab afterwards.

**Tampermonkey:** open **Settings → Security** and set **Check @connect:** to **Casual**.
The script declares `@connect *`, because the CDN host is not known until a playlist names
it. With the default setting, Tampermonkey stops at a confirmation dialog the first time
each new CDN host is requested, and a dialog that times out looks to the script exactly like
a blocked request. `Casual` is the mode that allows those requests without prompting. Nothing
else in Security needs changing, and the script's own `ssrf.ts` policy still decides what is
actually fetched: the setting is about Tampermonkey prompting you, not about what goes out.

To build it from source instead:

```bash
npm install
npm run build          # dist/stremio-local-proxy-hls.user.js
```

hls.js is not bundled: the `@require` line in `metadata.txt` makes the manager load it.
`build.mjs` asserts that line is still there and that nothing hls.js-sized slipped into the
output (a stray `import 'hls.js'` would silently inline a second ~1 MB player).

## Settings

The local service's URL is the one thing you can change, because it is the one thing the
script cannot work out for itself. Open your userscript manager's menu for this script
(Violentmonkey: the ⋮ on the script, Tampermonkey: the script's entry in the dashboard) and
you get three commands:

- **Set local service URL** — prompts for the origin, for example `http://192.168.1.50:11470`
  or `127.0.0.1:11471`. It is stored with `GM_setValue` and used from the next page load on.
- **Show local service URL** — what the script is currently using.
- **Reset local service URL** — back to `http://127.0.0.1:11470`.

Only a local origin is accepted: loopback, or a private address on your own network, over
`http` or `https`. A public hostname is refused, because the local URL is the one host the
script does not run its own request policy on, and it has to be a host you control. A stored
value that no longer validates falls back to the default rather than standing the script
down.

There is deliberately no in-page settings UI. A control on `web.stremio.com` would mean
touching the page, and staying out of the page is the whole point of this script.

## Releasing

Bump the version in **both** `package.json` (`version`) and `metadata.txt` (`@version`), then
push to `main`. The two fields must match, otherwise the job fails.

Pushing a tag (`git tag v1.2.3 && git push origin v1.2.3`) publishes that version too, and the
workflow can be run by hand from the Actions tab.

A single `ci.yml` workflow handles both. Its `check` job runs on every PR and push, and its
`release` job waits for `check` and only runs when the version actually changed, so a
docs-only push publishes nothing. `release` downloads the bundle that `check` already built
rather than rebuilding it: the published file is byte for byte the one that passed the tests.
The release notes come from `release-notes.md`.

## How it works

There are three interception points, all installed at `document-start`, before the page's
own code: `HTMLMediaElement.prototype.src`, `XMLHttpRequest` and `fetch`.

1. **The gate.** `parseForInterception()` applies one condition to every request: exactly
   the local origin, the `/proxy/` prefix, a target in the server's format (`?d=` or the
   Core path form), and a target that `ssrf.ts` is willing to fetch. If any of that fails
   the request goes to the page **untouched** — including `blob:`, `data:` and the page's
   own requests. The same gate also stands down while the local service is not answering
   (see below).
2. **Pre-flight.** `sniff.ts` looks at the first 64 KB to decide whether the target really
   is an HLS playlist (a `.m3u8`/`.m3u` suffix or a playlist content type, falling back to
   an `#EXTM3U` prefix in the body). If it is not — a plain `.mp4`, a 4xx, a closed port —
   the page runs its own load and never learns this script exists.
3. **Playlist rewrite.** `playlist.ts` turns every non-comment line and every `URI="…"`
   attribute into an absolute local proxy URL. This has to happen here, because the body
   arrives straight from the CDN: a relative `/proxy/?d=…` would be resolved against the
   page the player is running in and end up on the wrong host. The segment headers travel
   along as `h=` parameters, and non-HTTP references such as `skd://` are left alone.
4. **Playback.** `session.ts` builds one hls.js instance per video element; hls.js assigns
   its own `blob:` URL through the original setter. A page that reads `currentSrc` or
   `video.src` still sees the local proxy URL, so the rest of the page never notices that
   playback is driven by hls.js.
5. **Transport.** `transport.ts` hands the request to the manager: it asks for a stream and
   falls back to `arraybuffer` once if the manager cannot provide one, remembering what it
   learned. Timeouts, retries and the concurrency limit live here.

### When it fails, the page is still fine

Every installation is fail-open. Each hook is installed in its own `try/catch`, so one that
throws is simply not installed and the page carries on. If playback gives up, the `src`
assignment is replayed through the original setter once, so the page runs its own load.

If the local service is not running, that is the normal path rather than an error: the probe
fails once, the page gets its element and its URL back, and nothing of ours is left on the
element. Two unanswered requests in a row then open a circuit and the script stops
intervening for the rest of the page load, because a page whose own request fails at once
is in a far better position than a page waiting for this script to fail on its behalf. A
single answer closes the circuit again, so a service that comes back mid-visit is picked up
without a reload.

## Security policy

The policy lives in `headers.ts`, `ssrf.ts` and `transport.ts`.

- **Target.** Only `public` targets are requested. No internal address, the local service
  included, can ever become a GM target, and the check runs a second time in `transport.ts`
  immediately before the manager is called: nothing gets out unless it passes the last
  gate.
- **Local URL.** The one user-settable value is not a GM target: it is where the page's own
  requests are recognised, so setting it decides which requests get intercepted, never
  where this script sends anything. It is written only by the manager's menu, the page
  cannot reach it, and it is refused unless it names a loopback or private address over
  `http`/`https`. A value that no longer validates falls back to the default instead of
  changing what gets intercepted.
- **Timeout SSRF.** An address that only resolves when a lookup times out is not requested;
  only addresses that are statically public are accepted. A hostname that cannot be
  resolved statically cannot be reasoned about, and that is a known limit.
- **Headers.** `cookie`, `authorization`, `origin`, `referer` and `sec-*` are never taken
  from the page's own request. GM requests are sent `anonymous`, so the manager does not
  attach its own cookies either.
- **`h=` headers.** The `h=` parameters in a playlist are the page saying which headers the
  upstream needs (`referer`, `user-agent` and so on), so they are deliberately let through.
  The target is still bounded by `ssrf.ts`, which is what makes this part of the model
  rather than a hole in it.
- **`sec-*` defaults.** The manager fills `GM_xmlhttpRequest` in with the browser's own
  client hints (`sec-ch-ua*`, `sec-fetch-*`, `sec-gpc`, `sec-purpose`). None of that
  describes the request we are making on the CDN's behalf, and `sec-gpc` in particular is a
  privacy signal about the user, so nothing is forwarded: every name we are not sending a
  real value for is blanked (`'sec-gpc': ''`), which is how a manager is told to leave a
  header alone. A `sec-*` header the page asked for in `h=` keeps its value. The list is
  the whole browser-managed `Sec-*` family; a missing name is exactly this bug.
- **Response headers.** Only end-to-end headers reach the page: `set-cookie`, hop-by-hop
  and `sec-*` are dropped. When a playlist body was rewritten, `content-length` and
  `content-encoding` are removed and `accept-ranges: none` is added.

## Files

| File | Job |
| --- | --- |
| `src/index.ts` | Entry point, hook installation order, `pagehide` cleanup |
| `src/config.ts` | Every tunable in one place; never read from the page or the network |
| `src/settings.ts` | The one user-configurable value, validated and stored with GM_setValue |
| `src/menu.ts` | The manager's menu commands, including the prompt for the local URL |
| `src/env.ts` | The only path to the sandbox, `unsafeWindow`, GM and hls.js |
| `src/capabilities.ts` | One environment check per page load; makes no request |
| `src/localService.ts` | Whether the local service is answering at all |
| `src/proxyUrl.ts` | Parsing (`parseForInterception`) and building (`buildProxyUrl`) proxy URLs |
| `src/ssrf.ts` | Target policy: public only |
| `src/headers.ts` | The single policy for headers sent and headers returned |
| `src/transport.ts` | The GM request, stream discovery, retries, the last SSRF gate |
| `src/playlist.ts` | Playlist detection and the streaming/buffered rewrite |
| `src/response.ts` | Building the `Response` and XHR objects the page receives |
| `src/sniff.ts` | Deciding from the first 64 KB whether the target is a playlist |
| `src/session.ts` | One hls.js session per video element |
| `src/srcHook.ts`, `xhrHook.ts`, `fetchHook.ts` | The interception points, all through the same gate |
| `src/log.ts` | De-duplicated logging, so the page is not spammed |

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # node --test, no browser needed
npm run build        # dist/
npm run build:min    # minified dist/
npm run check        # typecheck + test + build (run this before packaging)
```

The tests run on plain node: `test/fakeGm.ts` provides a fake `GM_xmlhttpRequest` and
`test/fakes.ts` a fake page environment. What they cover: the gate and its fail-open
behaviour, SSRF, the header policy, the stream and buffered paths, retries and timeouts,
playlists split across chunk boundaries, the XHR path hls.js actually uses, and a local
service that is not running.

## Known limits

- `@match` is `https://web.stremio.com/*` only; other Stremio clients are out of scope.
- `@connect *` is required, because the target address arrives from the page at runtime and
  cannot be listed ahead of time. A manager with a rule-based connection list may refuse to
  install the script.
- At most 6 requests at a time; the rest queue.
- Playback depends on hls.js. If the `@require` line cannot be loaded, the script does not
  play anything and still leaves the page alone.
