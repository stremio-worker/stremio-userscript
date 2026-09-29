import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { resetCapabilities } from '../src/capabilities';
import { DEFAULT_LOCAL_ORIGIN as LOCAL_ORIGIN } from '../src/config';
import { configureEnv } from '../src/env';
import { installFetchHook } from '../src/fetchHook';
import { buildProxyUrl } from '../src/proxyUrl';
import { resetTransportState, setStreamsSupported } from '../src/transport';
import { createFakeGm, respond, type FakeGm } from './fakeGm';
import { fakePage } from './fakes';

const UPSTREAM = 'https://cdn.example.com/stream/index.m3u8';
const PLAYLIST = '#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg1.ts\n';
/** PLAYLIST with every reference resolved and pointing back at the local proxy. */
const REWRITTEN_PLAYLIST = `#EXTM3U\n#EXT-X-TARGETDURATION:6\n${buildProxyUrl('https://cdn.example.com/stream/seg1.ts')}\n`;

function proxyUrl(upstream = UPSTREAM, headers?: Record<string, string>): string {
  return buildProxyUrl(upstream, headers);
}

type Page = Record<string, unknown>;

let gm: FakeGm;
let page: Page;
let originalFetch: (input: unknown, init?: unknown) => Promise<unknown>;

function pageFetch(): (input: unknown, init?: unknown) => Promise<unknown> {
  return page.fetch as (input: unknown, init?: unknown) => Promise<unknown>;
}

function usePage(overrides: Record<string, unknown> = {}, streams = false): void {
  page = fakePage({ Response, ReadableStream, ...overrides });
  originalFetch = async (input: unknown): Promise<unknown> => ({ native: true, input });
  page.fetch = originalFetch;
  configureEnv({ page, gmRequest: gm.fn });
  resetCapabilities();
  setStreamsSupported(streams);
}

beforeEach(() => {
  gm = createFakeGm();
  resetTransportState();
  usePage();
});

afterEach(() => {
  resetTransportState();
});

test('a local proxy GET is answered by the script, not the network', async () => {
  gm.setResponder(
    respond({ status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, body: PLAYLIST }),
  );
  assert.equal(installFetchHook(), true);

  const response = (await pageFetch()(proxyUrl())) as Response;

  assert.equal(gm.calls.length, 1);
  assert.equal(gm.calls[0]?.details.url, UPSTREAM, 'the upstream came out of the proxy URL');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  // Not byte for byte: a playlist has to leave with its references pointing back
  // at the local proxy, or hls.js would ask the CDN for the segment itself.
  assert.equal(await response.text(), REWRITTEN_PLAYLIST);
  assert.equal(response.headers.get('content-length'), null, 'the body is a different size now');
});

test('a non-local URL is left to the page fetch', async () => {
  assert.equal(installFetchHook(), true);

  const result = (await pageFetch()('https://example.com/thing.json')) as { native: boolean };

  assert.equal(result.native, true);
  assert.equal(gm.calls.length, 0);
});

test('the sibling local path is not ours either', async () => {
  assert.equal(installFetchHook(), true);

  const result = (await pageFetch()(`${LOCAL_ORIGIN}/hlsv2/stream.m3u8`)) as { native: boolean };

  assert.equal(result.native, true);
  assert.equal(gm.calls.length, 0);
});

test('a method the local server does not serve is left alone', async () => {
  assert.equal(installFetchHook(), true);

  for (const method of ['POST', 'PUT', 'OPTIONS', 'TRACE']) {
    const result = (await pageFetch()(proxyUrl(), { method })) as { native: boolean };
    assert.equal(result.native, true, `${method} went to the page fetch`);
  }
  assert.equal(gm.calls.length, 0);
});

test('a HEAD request keeps the headers and has no body', async () => {
  gm.setResponder(
    respond({ status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': '180' } }),
  );
  assert.equal(installFetchHook(), true);

  const response = (await pageFetch()(proxyUrl(), { method: 'HEAD' })) as Response;

  assert.equal(gm.calls[0]?.details.method, 'HEAD');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '180');
  assert.equal(await response.text(), '');
});

test('a proxy URL we do serve is answered, and only that', async () => {
  gm.setResponder(respond({ status: 200, body: PLAYLIST }));
  assert.equal(installFetchHook(), true);

  const response = (await pageFetch()(proxyUrl())) as Response;

  assert.equal(gm.calls.length, 1);
  assert.equal(await response.text(), REWRITTEN_PLAYLIST);
});

test('a 404 from the local server looks like a dead network to the page', async () => {
  gm.setResponder(respond({ status: 404, statusText: 'Not Found' }));
  assert.equal(installFetchHook(), true);

  await assert.rejects(
    async () => pageFetch()(proxyUrl()),
    (error: unknown) => {
      assert.ok(error instanceof TypeError, 'a TypeError, the same thing a blocked fetch gives');
      assert.equal((error as TypeError).message, 'Failed to fetch');
      return true;
    },
  );
  assert.equal(gm.calls.length, 1, 'a 404 is an answer, not a transport failure to retry');
});

test('page headers are filtered, proxy URL headers win', async () => {
  assert.equal(installFetchHook(), true);

  await pageFetch()(proxyUrl(UPSTREAM, { referer: 'https://site.example/' }), {
    headers: {
      Referer: 'https://spoofed.example/',
      Cookie: 'session=leak',
      Authorization: 'Bearer leak',
      'X-Trace': 'keep-me',
    },
  });

  const sent = gm.calls[0]?.details.headers ?? {};
  assert.equal(sent['x-trace'], 'keep-me', 'ordinary headers are lent to the local server');
  assert.equal(sent['referer'], 'https://site.example/', 'h= wins over the page header');
  assert.equal(sent['cookie'], undefined, 'page credentials never leave the page');
  assert.equal(sent['authorization'], undefined, 'page credentials never leave the page');
});

test('a headers array is read too', async () => {
  assert.equal(installFetchHook(), true);

  await pageFetch()(proxyUrl(), { headers: [['X-Kept', 'yes'], ['Cookie', 'nope']] });

  const sent = gm.calls[0]?.details.headers ?? {};
  assert.equal(sent['x-kept'], 'yes');
  assert.equal(sent['cookie'], undefined);
});

test('an already aborted signal never starts a request', async () => {
  assert.equal(installFetchHook(), true);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    async () => pageFetch()(proxyUrl(), { signal: controller.signal }),
    (error: unknown) => error instanceof TypeError,
  );
});

test('a streamed playlist is rewritten as it arrives, never buffered whole', async () => {
  usePage({}, true);
  gm.setResponder(
    respond({
      status: 200,
      headers: { 'content-type': 'video/mp2t' },
      stream: true,
      streamChunks: ['#EXTM3U\n', 'seg1.ts\n', 'seg2.ts\n'],
    }),
  );
  assert.equal(installFetchHook(), true);

  const response = (await pageFetch()(proxyUrl())) as Response;

  assert.equal(response.status, 200);
  assert.equal(
    await response.text(),
    `#EXTM3U\n${buildProxyUrl('https://cdn.example.com/stream/seg1.ts')}\n${buildProxyUrl('https://cdn.example.com/stream/seg2.ts')}\n`,
    'each reference is resolved against the playlist and pointed back at the proxy',
  );
});

test('a manager without streams still gets the whole body', async () => {
  usePage({}, false);
  gm.setResponder(respond({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'hello' }));
  assert.equal(installFetchHook(), true);

  // A segment, not a playlist: nothing is rewritten and nothing is streamed.
  const response = (await pageFetch()(proxyUrl('https://cdn.example.com/stream/seg1.ts'))) as Response;

  assert.equal(await response.text(), 'hello');
});

test('a Request-like input is accepted', async () => {
  gm.setResponder(respond({ status: 200, body: 'x' }));
  assert.equal(installFetchHook(), true);

  await pageFetch()({ url: proxyUrl(), method: 'GET' });

  assert.equal(gm.calls[0]?.details.url, UPSTREAM);
});

test('a local URL that is not a usable proxy URL is the page request again', async () => {
  assert.equal(installFetchHook(), true);

  // None of these is a proxy URL in the server's format. The local server has a
  // real answer for them — 400 for a missing target, 404 for a wrong path, and
  // the JSON for /version — so the page must get that answer, not a synthesised
  // network error and not a proxied version of it.
  for (const url of [
    `${LOCAL_ORIGIN}/version`,
    `${LOCAL_ORIGIN}/hlsv2/stream.m3u8`,
    `${LOCAL_ORIGIN}/configure`,
    `${LOCAL_ORIGIN}/proxy/`,
    `${LOCAL_ORIGIN}/proxy/?x=1`,
    `${LOCAL_ORIGIN}/proxy/?d=`,
    `${LOCAL_ORIGIN}/proxy/version`,
    `${LOCAL_ORIGIN}/proxy/?d=not%20a%20url`,
    `${LOCAL_ORIGIN}/proxy/?d=https://user:pw@cdn.example.com/x`,
    `${LOCAL_ORIGIN}/proxy/?d=ftp://cdn.example.com/x`,
  ]) {
    const result = (await pageFetch()(url)) as { native: boolean };
    assert.equal(result.native, true, `${url} went to the page fetch`);
  }
  assert.equal(gm.calls.length, 0, 'nothing was proxied and nothing went upstream');
});

test('a proxy URL aimed at the local network is the page request again', async () => {
  assert.equal(installFetchHook(), true);

  // The script refuses the target, so it does not own the request: the browser
  // asks the local server, the local server answers 403 "Blocked target", and
  // nothing of the answer is redirected anywhere.
  for (const upstream of [
    'http://192.168.0.1/admin',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://127.0.0.1:8080/',
    'http://[::1]/',
    'http://nas.local/x.m3u8',
  ]) {
    const result = (await pageFetch()(proxyUrl(upstream))) as { native: boolean };
    assert.equal(result.native, true, `${upstream} went to the page fetch`);
  }
  assert.equal(gm.calls.length, 0, 'no SSRF from a hostile playlist');
});

test('the patch is installed once', () => {
  assert.equal(installFetchHook(), true);
  const patched = page.fetch;
  assert.notEqual(patched, originalFetch);

  assert.equal(installFetchHook(), false);
  assert.equal(page.fetch, patched, 'the second attempt did not wrap the wrapper');
});

test('without GM_xmlhttpRequest the page fetch is untouched', () => {
  configureEnv({ gmRequest: null });
  resetCapabilities();

  assert.equal(installFetchHook(), false);
  assert.equal(page.fetch, originalFetch);
});

test('a page without fetch is left alone', () => {
  page.fetch = undefined;
  configureEnv({ page, gmRequest: gm.fn });
  resetCapabilities();
  setStreamsSupported(false);

  assert.equal(installFetchHook(), false);
});

test('a page whose fetch cannot be replaced is left alone', () => {
  const frozen: Page = fakePage({ Response, ReadableStream });
  Object.defineProperty(frozen, 'fetch', {
    value: async (): Promise<unknown> => ({ native: true }),
    writable: false,
    configurable: false,
  });
  const before = frozen.fetch;
  configureEnv({ page: frozen, gmRequest: gm.fn });
  resetCapabilities();
  setStreamsSupported(false);

  assert.equal(installFetchHook(), false);
  assert.equal(frozen.fetch, before);
});
