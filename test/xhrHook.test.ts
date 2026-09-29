import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { resetCapabilities } from '../src/capabilities';
import { configureEnv, type HlsConstructor } from '../src/env';
import { LOCAL_ORIGIN } from '../src/config';
import { buildProxyUrl } from '../src/proxyUrl';
import { resetTransportState, setStreamsSupported } from '../src/transport';
import { installXhrHook, isXhrHookInstalled, uninstallXhrHook } from '../src/xhrHook';
import { createFakeGm, respond, type FakeGm } from './fakeGm';
import { fakePage, FakeXMLHttpRequest, type FakeEvent } from './fakes';

const UPSTREAM = 'https://cdn.example.com/stream/index.m3u8';
const SEGMENT_UPSTREAM = 'https://cdn.example.com/stream/seg1.ts';
const PLAYLIST = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv1.m3u8\n';
/** PLAYLIST with its one reference resolved and pointed back at the local proxy. */
const REWRITTEN_PLAYLIST = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n${buildProxyUrl('https://cdn.example.com/stream/v1.m3u8')}\n`;

const Ctor = FakeXMLHttpRequest as unknown as new () => XMLHttpRequest;

let gm: FakeGm;
let events: string[];

function proxyUrl(upstream = UPSTREAM, headers: Record<string, string> = {}): string {
  return buildProxyUrl(upstream, headers);
}

function record(xhr: FakeXMLHttpRequest, type: string): void {
  xhr.addEventListener(type, () => events.push(type));
}

/** Records the event types the page actually observes, in order. */
function recorder(xhr: FakeXMLHttpRequest, types: string[]): string[] {
  const seen: string[] = [];
  for (const type of types) xhr.addEventListener(type, () => seen.push(type));
  return seen;
}

function tick(times = 4): Promise<void> {
  let promise = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    promise = promise.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
  return promise;
}

beforeEach(() => {
  events = [];
  gm = createFakeGm();
  configureEnv({ page: fakePage(), gmRequest: gm.fn, hls: null });
  resetTransportState();
  setStreamsSupported(false);
  resetCapabilities();
  FakeXMLHttpRequest.instances = [];
});

afterEach(() => {
  uninstallXhrHook();
  resetTransportState();
});

test('without GM_xmlhttpRequest the XHR prototype is left alone', () => {
  configureEnv({ gmRequest: null });
  resetCapabilities();
  const page = fakePage() as { XMLHttpRequest: { prototype: XMLHttpRequest } };
  const before = page.XMLHttpRequest.prototype.open;
  assert.equal(installXhrHook(), false);
  assert.equal(page.XMLHttpRequest.prototype.open, before);
});

test('a local proxy GET is answered by the script, not the network', async () => {
  gm.setResponder(respond({ status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, body: PLAYLIST }));
  assert.equal(installXhrHook(), true);
  assert.equal(isXhrHookInstalled(), true);

  const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
  record(xhr, 'readystatechange');
  record(xhr, 'progress');
  record(xhr, 'load');
  record(xhr, 'loadend');

  xhr.open('GET', proxyUrl(), true);
  xhr.responseType = 'text';
  xhr.send();

  await tick();

  assert.equal(xhr.record.sent, false, 'the real XHR never sent anything');
  assert.equal(gm.calls.length, 1);
  assert.equal(gm.calls[0]?.details.url, UPSTREAM);
  assert.equal(xhr.readyState, 4);
  assert.equal(xhr.status, 200);
  // hls.js reads the playlist over this very path, so it is the one that has to
  // hand the references back in the proxy format.
  assert.equal(xhr.responseText, REWRITTEN_PLAYLIST);
  assert.equal(xhr.response, REWRITTEN_PLAYLIST);
  assert.equal(xhr.responseURL, UPSTREAM);
  assert.equal(xhr.getResponseHeader('content-type'), 'application/vnd.apple.mpegurl');
  assert.equal(xhr.getResponseHeader('content-length'), null, 'the body is a different size now');
  assert.ok(xhr.getAllResponseHeaders().includes('content-type: application/vnd.apple.mpegurl'));
  assert.deepEqual(events, [
    'readystatechange',
    'progress',
    'readystatechange',
    'readystatechange',
    'load',
    'loadend',
  ]);
});

test('hls.js style requests: arraybuffer body, Range header, onreadystatechange handler', async () => {
  const segment = new Uint8Array([1, 2, 3, 4, 5]);
  gm.setResponder(respond({ status: 200, headers: { 'content-type': 'video/mp2t', 'content-length': '5' }, body: segment.buffer }));
  assert.equal(installXhrHook(), true);

  const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
  const states: number[] = [];
  xhr.onreadystatechange = () => {
    states.push(xhr.readyState);
  };
  xhr.onload = () => undefined;

  xhr.open('GET', proxyUrl(SEGMENT_UPSTREAM), true);
  xhr.responseType = 'arraybuffer';
  xhr.setRequestHeader('Range', 'bytes=0-4');
  xhr.send();

  await tick();

  assert.deepEqual(states, [2, 3, 4]);
  assert.equal(xhr.readyState, 4);
  assert.equal(xhr.status, 200);
  const body = xhr.response as ArrayBuffer;
  assert.deepEqual([...new Uint8Array(body)], [1, 2, 3, 4, 5]);
  assert.equal(gm.calls[0]?.details.headers?.range, 'bytes=0-4');
  assert.equal((gm.calls[0]?.details as unknown as Record<string, unknown>).responseType, 'arraybuffer');
});

test('the page cannot smuggle cookies through setRequestHeader', async () => {
  gm.setResponder(respond({ status: 200, body: 'ok' }));
  assert.equal(installXhrHook(), true);

  const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
  xhr.open('GET', proxyUrl(), true);
  xhr.setRequestHeader('Cookie', 'session=page-secret');
  xhr.setRequestHeader('X-Injected', 'yes');
  xhr.send();
  await tick();

  const headers = gm.calls[0]?.details.headers ?? {};
  assert.equal(headers.cookie, undefined);
  assert.equal(headers['x-injected'], 'yes');
});

test('h= headers win over the headers the page sets', async () => {
  gm.setResponder(respond({ status: 200, body: 'ok' }));
  assert.equal(installXhrHook(), true);

  const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
  xhr.open('GET', proxyUrl(UPSTREAM, { Referer: 'https://ref.example.com/' }), true);
  xhr.setRequestHeader('Referer', 'https://evil.example.com/');
  xhr.send();
  await tick();

  assert.equal(gm.calls[0]?.details.headers?.referer, 'https://ref.example.com/');
});

test('a request the script does not own is passed to the real XHR', async () => {
  gm.setResponder(respond({ status: 200, body: 'ok' }));
  assert.equal(installXhrHook(), true);

  for (const url of [
    'https://example.com/proxy/?d=x',
    `${LOCAL_ORIGIN}/hlsv2/index.m3u8`,
    `${LOCAL_ORIGIN}/other/?d=x`,
  ]) {
    const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
    xhr.open('GET', url, true);
    xhr.send();
    assert.equal(xhr.record.sent, true, url);
  }

  // Unsupported response types are not synthesised either.
  const blob = new Ctor() as unknown as FakeXMLHttpRequest;
  blob.open('GET', proxyUrl(), true);
  blob.responseType = 'blob';
  blob.send();
  assert.equal(blob.record.sent, true);

  assert.equal(gm.calls.length, 0);
});

test('withCredentials requests are left to the browser', async () => {
  gm.setResponder(respond({ status: 200, body: 'ok' }));
  assert.equal(installXhrHook(), true);

  const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
  xhr.open('GET', proxyUrl(), true);
  xhr.withCredentials = true;
  xhr.send();

  assert.equal(xhr.record.sent, true);
  assert.equal(gm.calls.length, 0);
});

test('a failure fires error and loadend, never a synthetic abort', async () => {
  gm.setResponder(respond({ error: 'ECONNREFUSED' }));
  assert.equal(installXhrHook(), true);

  const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
  const seen = recorder(xhr, ['readystatechange', 'load', 'error', 'abort', 'loadend']);
  xhr.open('GET', proxyUrl(), true);
  xhr.responseType = 'text';
  xhr.send();
  await tick();

  assert.deepEqual(seen, ['readystatechange', 'error', 'loadend']);
  assert.equal(xhr.status, 0);
  assert.equal(xhr.readyState, 4);
  assert.equal(xhr.responseText, '');
});

test('abort() stops the request and fires abort then loadend', async () => {
  gm.setResponder(respond({ hang: true }));
  assert.equal(installXhrHook(), true);

  const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
  const seen = recorder(xhr, ['load', 'error', 'abort', 'loadend']);
  xhr.open('GET', proxyUrl(), true);
  xhr.send();
  await tick();

  xhr.abort();
  await tick();

  assert.deepEqual(seen, ['abort', 'loadend']);
  assert.equal(gm.calls[0]?.aborted, true);
});

test('xhr.timeout is honoured and fires timeout, not error', async () => {
  gm.setResponder(respond({ hang: true }));
  assert.equal(installXhrHook(), true);

  const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
  const seen = recorder(xhr, ['timeout', 'error', 'loadend']);
  xhr.open('GET', proxyUrl(), true);
  xhr.timeout = 10;
  xhr.send();

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(seen, ['timeout', 'loadend']);
  assert.equal(gm.calls[0]?.aborted, true);
});

test('a HEAD request is answered without a body', async () => {
  gm.setResponder(respond({ status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }));
  assert.equal(installXhrHook(), true);

  const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
  xhr.open('HEAD', proxyUrl(), true);
  xhr.send();
  await tick();

  assert.equal(gm.calls[0]?.details.method, 'HEAD');
  assert.equal(xhr.status, 200);
  assert.equal(xhr.responseText, '');
  assert.equal(xhr.getResponseHeader('content-type'), 'application/vnd.apple.mpegurl');
});

test('json responseType is decoded for the page', async () => {
  gm.setResponder(respond({ status: 200, body: '{"ok":true}' }));
  assert.equal(installXhrHook(), true);

  const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
  xhr.open('GET', proxyUrl('https://cdn.example.com/thing.json'), true);
  xhr.responseType = 'json';
  xhr.send();
  await tick();

  assert.deepEqual(xhr.response, { ok: true });
  assert.throws(() => xhr.responseText, TypeError);
});

test('set-cookie never reaches the page', async () => {
  gm.setResponder(respond({ status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': 'a=b', body: 'ok' } }));
  assert.equal(installXhrHook(), true);

  const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
  xhr.open('GET', proxyUrl(), true);
  xhr.send();
  await tick();

  assert.equal(xhr.getResponseHeader('set-cookie'), null);
  assert.equal(xhr.getAllResponseHeaders().includes('set-cookie'), false);
});

test('reusing the same XHR for another URL is clean', async () => {
  gm.setResponder(respond({ status: 200, body: 'second' }));
  assert.equal(installXhrHook(), true);

  const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
  xhr.open('GET', 'https://example.com/first', true);
  xhr.send();
  assert.equal(xhr.record.sent, true);

  xhr.open('GET', proxyUrl(SEGMENT_UPSTREAM), true);
  xhr.responseType = 'text';
  xhr.send();
  await tick();

  assert.equal(xhr.responseText, 'second');
  assert.equal(gm.calls.length, 1);
});

test('a proxy URL aimed at the local network is left to the browser', () => {
  gm.setResponder(respond({ status: 200, body: PLAYLIST }));
  assert.equal(installXhrHook(), true);

  for (const upstream of [
    'http://192.168.0.1/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8080/',
    'http://[::1]/',
    'http://nas.local/x.m3u8',
  ]) {
    const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
    xhr.open('GET', proxyUrl(upstream), true);
    xhr.send();

    assert.equal(xhr.record.sent, true, `${upstream} went to the real XHR`);
    assert.equal(xhr.readyState, 1, `${upstream} was never simulated`);
  }
  assert.equal(gm.calls.length, 0, 'no SSRF through hls.js either');
});

test('uninstall puts the native prototype back', () => {
  const page = fakePage() as { XMLHttpRequest: { prototype: XMLHttpRequest } };
  const before = page.XMLHttpRequest.prototype.open;
  assert.equal(installXhrHook(), true);
  assert.notEqual(page.XMLHttpRequest.prototype.open, before);
  uninstallXhrHook();
  assert.equal(page.XMLHttpRequest.prototype.open, before);
  assert.equal(isXhrHookInstalled(), false);
});

test('the hook is not installed twice', () => {
  assert.equal(installXhrHook(), true);
  const page = fakePage();
  configureEnv({ page });
  assert.equal(installXhrHook(), true);
  const after = (page as { XMLHttpRequest: { prototype: Record<string, unknown> } }).XMLHttpRequest.prototype.open;
  const marked = after as { __stremioLocalProxyXhr?: boolean };
  assert.equal(marked.__stremioLocalProxyXhr, true);
});

test('hls.js is only needed for the src path, not for XHR', async () => {
  configureEnv({ hls: null as unknown as HlsConstructor });
  resetCapabilities();
  gm.setResponder(respond({ status: 200, body: 'ok' }));
  assert.equal(installXhrHook(), true);

  const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
  xhr.open('GET', proxyUrl(SEGMENT_UPSTREAM), true);
  xhr.send();
  await tick();

  assert.equal(xhr.responseText, 'ok');
});

test('every synthetic event is a real event object', async () => {
  gm.setResponder(respond({ status: 200, body: 'ok' }));
  assert.equal(installXhrHook(), true);

  const xhr = new Ctor() as unknown as FakeXMLHttpRequest;
  const types: string[] = [];
  xhr.addEventListener('progress', (event: unknown) => {
    const progress = event as FakeEvent & { loaded: number; total: number };
    types.push(progress.type);
    assert.equal(typeof progress.loaded, 'number');
    assert.equal(typeof progress.total, 'number');
  });
  xhr.open('GET', proxyUrl(), true);
  xhr.responseType = 'text';
  xhr.send();
  await tick();

  assert.deepEqual(types, ['progress']);
});
