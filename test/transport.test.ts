import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { resetCapabilities } from '../src/capabilities';
import { configureEnv, env } from '../src/env';
import { isLocalServiceDown, noteLocalReachable } from '../src/localService';
import { parseForInterception, type ParsedProxyUrl } from '../src/proxyUrl';
import {
  activeRequestCount,
  gmRequest,
  getStreamsSupported,
  resetTransportState,
  setStreamsSupported,
  TransportError,
} from '../src/transport';
import { DEFAULT_LOCAL_ORIGIN as LOCAL_ORIGIN } from '../src/config';
import { createFakeGm, respond, type FakeGm } from './fakeGm';
import { fakePage } from './fakes';

const UPSTREAM = 'https://cdn.example.com/stream/index.m3u8';

function parsed(overrides: Partial<ParsedProxyUrl> = {}): ParsedProxyUrl {
  return { upstreamUrl: UPSTREAM, headers: {}, method: 'GET', ...overrides };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function bytes(value: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(value));
}

let gm: FakeGm;

beforeEach(() => {
  gm = createFakeGm();
  configureEnv({ page: fakePage(), gmRequest: gm.fn, hls: null });
  resetTransportState();
  resetCapabilities();
});

afterEach(() => {
  resetTransportState();
});

test('a plain GET is sent anonymously, without the page credentials', async () => {
  // A manager without stream support, so the request is the plain buffered one
  // this test is about and nothing else gets in the way.
  setStreamsSupported(false);
  gm.setResponder(respond({ status: 200, body: 'ok' }));
  const response = await gmRequest({ parsed: parsed({ headers: { referer: 'https://ref.example.com/' } }) });

  assert.equal(response.status, 200);
  assert.equal(bytes(response.body as ArrayBuffer), 'ok');
  assert.equal(response.streamed, false);
  assert.equal(gm.calls.length, 1);

  const details = gm.calls[0]?.details as unknown as Record<string, unknown>;
  assert.equal(details.anonymous, true);
  assert.equal(details.redirect, 'follow');
  assert.equal(details.responseType, 'arraybuffer');
  // The referer the page asked for, plus the blanked manager defaults: this is
  // the whole request as the manager sees it, so there is no room for it to add
  // a client hint of its own, and none of them was seen leaving on the wire.
  assert.deepEqual(details.headers, {
    referer: 'https://ref.example.com/',
    'sec-ch-ua': '',
    'sec-ch-ua-arch': '',
    'sec-ch-ua-bitness': '',
    'sec-ch-ua-full-version': '',
    'sec-ch-ua-full-version-list': '',
    'sec-ch-ua-mobile': '',
    'sec-ch-ua-model': '',
    'sec-ch-ua-platform': '',
    'sec-ch-ua-platform-version': '',
    'sec-ch-ua-wow64': '',
    'sec-fetch-dest': '',
    'sec-fetch-mode': '',
    'sec-fetch-site': '',
    'sec-fetch-storage-access': '',
    'sec-fetch-user': '',
    'sec-gpc': '',
    'sec-purpose': '',
  });
  assert.equal('cookie' in (details.headers as object), false);
  assert.equal('cookiePartition' in details, false);
});

test('a stream capable manager yields a live stream, not a buffer', async () => {
  setStreamsSupported(true);
  gm.setResponder(respond({ stream: true, streamChunks: ['#EXTM3U\n', '#EXT-X-ENDLIST\n'] }));
  const response = await gmRequest({ parsed: parsed(), preferStream: true });

  assert.equal(response.streamed, true);
  const body = response.body as ReadableStream<Uint8Array>;
  const reader = body.getReader();
  const chunks: string[] = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(new TextDecoder().decode(result.value));
  }
  assert.equal(chunks.join(''), '#EXTM3U\n#EXT-X-ENDLIST\n');
});

test('a manager that ignores the stream option is downgraded once', async () => {
  setStreamsSupported(true);
  gm.setResponder(respond({ sequence: [{ startOnly: true, stream: false }, { body: 'plain' }] }));
  const response = await gmRequest({ parsed: parsed(), preferStream: true, retries: 0 });
  assert.equal(response.streamed, false);
  assert.equal(bytes(response.body as ArrayBuffer), 'plain');
  // First attempt asked for a stream, the retry did not.
  assert.equal(gm.calls.length, 2);
  assert.equal((gm.calls[0]?.details as unknown as Record<string, unknown>).responseType, 'stream');
  assert.equal((gm.calls[1]?.details as unknown as Record<string, unknown>).responseType, 'arraybuffer');
});

test('HEAD uses the HEAD method and never asks for a stream', async () => {
  setStreamsSupported(true);
  gm.setResponder(respond({ status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }));
  const response = await gmRequest({ parsed: parsed({ method: 'HEAD' }), preferStream: true });

  assert.equal(gm.calls[0]?.details.method, 'HEAD');
  assert.equal((gm.calls[0]?.details as unknown as Record<string, unknown>).responseType, 'arraybuffer');
  assert.equal(response.status, 200);
});

test('a retryable status is retried, a fatal one is not', async () => {
  gm.setResponder(respond({ sequence: [{ status: 503 }, { status: 200, body: 'second' }] }));
  const ok = await gmRequest({ parsed: parsed(), retries: 1, preferStream: false });
  assert.equal(bytes(ok.body as ArrayBuffer), 'second');
  assert.equal(gm.calls.length, 2);

  gm.reset();
  gm.setResponder(respond({ status: 404 }));
  await assert.rejects(
    () => gmRequest({ parsed: parsed(), retries: 2, preferStream: false }),
    (error: unknown) => error instanceof TransportError && error.status === 404,
  );
  assert.equal(gm.calls.length, 1);
});

test('a refused connection is not retried, because it is the local service', async () => {
  // Every request this script makes targets 127.0.0.1:11470, so a connection
  // that is refused is the local service not running. Retrying would only make
  // the page wait three times as long for the same answer, and it already has
  // the answer a page without this script would have got.
  gm.setResponder(respond({ error: 'ECONNREFUSED' }));
  await assert.rejects(
    () => gmRequest({ parsed: parsed(), retries: 2, preferStream: false }),
    (error: unknown) => error instanceof TransportError && error.message.includes('local service unreachable'),
  );
  assert.equal(gm.calls.length, 1, 'a refusal does not become an answer on the second try');
});

test('a response that starts and then breaks is retried, that is the upstream', async () => {
  gm.setResponder(respond({ breakAfterStart: 'ECONNRESET' }));
  await assert.rejects(
    () => gmRequest({ parsed: parsed(), retries: 2, preferStream: false }),
    (error: unknown) => error instanceof TransportError && error.message.includes('network error'),
  );
  assert.equal(gm.calls.length, 3);
});

test('two unanswered requests in a row take the local service out of the picture', async () => {
  gm.setResponder(respond({ error: 'ECONNREFUSED' }));
  const request = () => gmRequest({ parsed: parsed(), retries: 0, preferStream: false });

  await assert.rejects(request, TransportError);
  // One refusal is a bad moment; the page still gets a fast answer either way.
  assert.equal(isLocalServiceDown(), false);
  await assert.rejects(request, TransportError);
  assert.equal(isLocalServiceDown(), true);
  // And the gate that every hook shares now leaves the page alone entirely.
  assert.equal(parseForInterception(`${LOCAL_ORIGIN}/proxy/?d=${encodeURIComponent(UPSTREAM)}`), null);

  // A service that comes back is used again without a reload.
  noteLocalReachable();
  assert.equal(isLocalServiceDown(), false);
  assert.notEqual(
    parseForInterception(`${LOCAL_ORIGIN}/proxy/?d=${encodeURIComponent(UPSTREAM)}`),
    null,
  );
});

test('any answer from the local service is proof that it is up', async () => {
  gm.setResponder(respond({ error: 'ECONNREFUSED' }));
  await assert.rejects(
    () => gmRequest({ parsed: parsed(), retries: 0, preferStream: false }),
    TransportError,
  );
  assert.equal(isLocalServiceDown(), false);

  // Even a 404: the service is running and has an opinion, which is the whole
  // difference between it and a closed port.
  gm.setResponder(respond({ status: 404 }));
  await assert.rejects(
    () => gmRequest({ parsed: parsed(), retries: 0, preferStream: false }),
    TransportError,
  );
  assert.equal(isLocalServiceDown(), false);
});

test('no first byte in time aborts the request', async () => {
  gm.setResponder(respond({ hang: true }));
  await assert.rejects(
    () => gmRequest({ parsed: parsed(), retries: 0, preferStream: false, firstByteTimeoutMs: 20 }),
    (error: unknown) => error instanceof TransportError && error.message.includes('no first byte'),
  );
  assert.equal(gm.calls[0]?.aborted, true);
  assert.equal(activeRequestCount(), 0);
});

test('a signal that is already aborted never reaches the manager', async () => {
  gm.setResponder(respond({ hang: true }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => gmRequest({ parsed: parsed(), retries: 0, preferStream: false, signal: controller.signal }),
    (error: unknown) => (error as { cause?: { name?: string } }).cause?.name === 'AbortError',
  );
  assert.equal(gm.calls.length, 0);
});

test('an AbortSignal ends a running request and marks it aborted', async () => {
  gm.setResponder(respond({ hang: true }));
  const controller = new AbortController();
  const promise = gmRequest({ parsed: parsed(), retries: 0, preferStream: false, signal: controller.signal });
  await tick();
  assert.equal(gm.calls.length, 1);
  controller.abort();
  await assert.rejects(promise, (error: unknown) => {
    const cause = (error as { cause?: { name?: string } }).cause;
    return cause?.name === 'AbortError';
  });
  assert.equal(gm.calls[0]?.aborted, true);
  assert.equal(activeRequestCount(), 0);
});

test('onActive hands out an abort for the caller that owns the request', async () => {
  gm.setResponder(respond({ hang: true }));
  let abort: (() => void) | null = null;
  const promise = gmRequest({
    parsed: parsed(),
    retries: 0,
    preferStream: false,
    onActive: (fn) => {
      abort = fn;
    },
  });
  await tick();
  assert.equal(typeof abort, 'function');
  (abort as unknown as () => void)();
  await assert.rejects(promise);
  assert.equal(gm.calls[0]?.aborted, true);
});

test('the concurrency limit is respected', async () => {
  let inFlight = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  gm.setResponder((_call, details) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    release.push(() => {
      inFlight -= 1;
      details.onload?.({ status: 200, responseHeaders: '', response: new ArrayBuffer(0) });
    });
  });

  const pending = Array.from({ length: 10 }, () => gmRequest({ parsed: parsed(), retries: 0, preferStream: false }));
  // Let the requests reach the manager before answering any of them.
  await tick();
  assert.equal(peak, 6);
  const all = Promise.all(pending);
  // Answer whatever is in flight; releasing a slot lets the next queued request
  // through, so keep going until all ten have been served.
  for (let served = 0; served < 10; served += 1) {
    await tick();
    while (release.length > 0) release.shift()?.();
  }
  await all;
  assert.equal(peak, 6);
  assert.equal(gm.calls.length, 10);
  assert.equal(activeRequestCount(), 0);
});

test('a missing GM implementation fails the request instead of hanging', async () => {
  configureEnv({ gmRequest: null });
  await assert.rejects(
    () => gmRequest({ parsed: parsed(), retries: 0, preferStream: false }),
    (error: unknown) => error instanceof TransportError,
  );
  assert.equal(env.gmRequest, null);
});

test('an internal target is refused before the manager is called', async () => {
  for (const upstream of [
    'http://192.168.0.1/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://2130706433/',
    'http://printer.local/',
  ]) {
    await assert.rejects(
      async () => gmRequest({ parsed: parsed({ upstreamUrl: upstream }), retries: 3 }),
      (error: unknown) => {
        assert.ok(error instanceof TransportError);
        assert.match(error.message, /internal target/);
        assert.equal(error.retryable, false, 'a refused target is not worth retrying');
        return true;
      },
      upstream,
    );
  }
  assert.equal(gm.calls.length, 0, 'nothing was ever handed to GM_xmlhttpRequest');
});

test('hop-by-hop never reaches the manager, and its sec- defaults are blanked', async () => {
  gm.setResponder(respond({ status: 200, body: 'ok' }));

  // Nothing but the transport can guarantee this, because a ParsedProxyUrl is a
  // plain object: a future caller, or a test, can put anything in it.
  await gmRequest({
    parsed: parsed({
      headers: {
        'sec-fetch-site': 'cross-site',
        connection: 'keep-alive',
        'proxy-authorization': 'Basic x',
        'user-agent': 'kept',
      },
    }),
    retries: 0,
    preferStream: false,
  });

  const headers = gm.calls[0]?.details.headers ?? {};
  // A sec- header the page named is sent, a hop-by-hop one is not.
  assert.equal(headers['sec-fetch-site'], 'cross-site');
  assert.equal(headers['user-agent'], 'kept');
  assert.equal(headers.connection, undefined);
  assert.equal(headers['proxy-authorization'], undefined);
  // And the names the manager would fill in itself are handed to it blanked,
  // except the one we mean to send.
  assert.equal(headers['sec-ch-ua'], '');
  assert.equal(headers['sec-fetch-mode'], '');
  assert.equal(headers['sec-fetch-user'], '');
  assert.equal(headers['sec-gpc'], '', 'the privacy signal that was seen going out');
});

test('the local service is not a GM target, not even our own', async () => {
  gm.setResponder(respond({ status: 200, body: 'version' }));

  // This script fetches the CDN hosts the local server names. The local server
  // itself is answered by the browser, so /version and /hlsv2/* stay the page's
  // own business and no playlist can aim the manager at 127.0.0.1:11470.
  for (const upstream of [
    'http://127.0.0.1:11470/version',
    'http://127.0.0.1:11470/proxy/',
    'http://127.0.0.1:8080/',
    'http://127.0.0.1/',
    'http://192.168.0.1/',
  ]) {
    await assert.rejects(
      async () => gmRequest({ parsed: parsed({ upstreamUrl: upstream }), retries: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof TransportError, upstream);
        assert.match(error.message, /internal target/);
        return true;
      },
      upstream,
    );
  }
  assert.equal(gm.calls.length, 0, 'the manager was never asked');
});

test('stream support is discovered by the first real request', async () => {
  // Unknown support: the first request asks for a stream, the manager has none,
  // and the answer arrives as a body instead of costing every later request.
  gm.setResponder(respond({ status: 200, body: 'chunk' }));
  assert.equal(getStreamsSupported(), null);

  const first = await gmRequest({ parsed: parsed(), retries: 0, preferStream: true });

  assert.equal(first.status, 200);
  assert.equal(bytes(first.body as ArrayBuffer), 'chunk');
  assert.equal(first.streamed, false);
  assert.equal(gm.calls.length, 2, 'asked for a stream, got a body, asked again buffered');
  assert.equal((gm.calls[0]?.details as { responseType?: string }).responseType, 'stream');
  assert.equal(getStreamsSupported(), false, 'remembered, so nothing asks again');

  const second = await gmRequest({ parsed: parsed(), retries: 0, preferStream: true });

  assert.equal(second.streamed, false);
  assert.equal(gm.calls.length, 3, 'the second request did not ask for a stream at all');
  assert.equal((gm.calls[2]?.details as { responseType?: string }).responseType, 'arraybuffer');
});

test('a manager that streams is remembered as well', async () => {
  gm.setResponder(respond({ status: 200, body: 'chunk', stream: true }));
  assert.equal(getStreamsSupported(), null);

  const first = await gmRequest({ parsed: parsed(), retries: 0, preferStream: true });
  assert.equal(first.streamed, true);
  assert.equal(getStreamsSupported(), true);
  assert.equal(gm.calls.length, 1, 'no wasted round trip');

  await gmRequest({ parsed: parsed(), retries: 0, preferStream: true });
  assert.equal(gm.calls.length, 2);
  assert.equal((gm.calls[1]?.details as { responseType?: string }).responseType, 'stream');
});
