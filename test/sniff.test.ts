import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { resetCapabilities } from '../src/capabilities';
import { configureEnv } from '../src/env';
import { sniffMedia } from '../src/sniff';
import { resetTransportState, setStreamsSupported } from '../src/transport';
import { createFakeGm, respond, type FakeGm } from './fakeGm';
import { fakePage } from './fakes';

const PLAYLIST = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv1.m3u8\n';
const UPSTREAM = 'https://cdn.example.com/stream/index.m3u8';

function parsed() {
  return { upstreamUrl: UPSTREAM, headers: {}, method: 'GET' as const };
}

let gm: FakeGm;

beforeEach(() => {
  gm = createFakeGm();
  configureEnv({ page: fakePage(), gmRequest: gm.fn, hls: null });
  resetTransportState();
  resetCapabilities();
  // Sniffing reads a small body to decide what it is. The tests below describe
  // the buffered path, which is what a manager without stream support gives; the
  // streamed path has a test of its own below.
  setStreamsSupported(false);
});

test('an mpegurl content type is enough, no body is fetched', async () => {
  gm.setResponder(respond({ status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }));
  const result = await sniffMedia(parsed());

  assert.equal(result.kind, 'playlist');
  assert.equal(result.contentType, 'application/vnd.apple.mpegurl');
  assert.equal(gm.calls.length, 1, 'only the HEAD probe');
  assert.equal(gm.calls[0]?.details.method, 'HEAD');
});

test('a streamed body is sniffed the same way', async () => {
  setStreamsSupported(true);
  gm.setResponder(
    respond({
      sequence: [
        { status: 200, headers: { 'content-type': 'text/plain' } },
        { status: 206, headers: { 'content-type': 'text/plain' }, stream: true, streamChunks: [PLAYLIST] },
      ],
    }),
  );
  const result = await sniffMedia(parsed());

  assert.equal(result.kind, 'playlist');
  assert.equal(gm.calls.length, 2, 'one HEAD, one streamed body');
  assert.equal((gm.calls[1]?.details as unknown as Record<string, unknown>).responseType, 'stream');
});

test('a small body without a playlist content type is sniffed', async () => {
  gm.setResponder(
    respond({
      sequence: [
        { status: 200, headers: { 'content-type': 'text/plain', 'content-length': String(PLAYLIST.length) } },
        { status: 206, headers: { 'content-type': 'text/plain' }, body: PLAYLIST },
      ],
    }),
  );
  const result = await sniffMedia(parsed());

  assert.equal(result.kind, 'playlist');
  assert.equal(gm.calls.length, 2);
  assert.equal((gm.calls[1]?.details as unknown as Record<string, unknown>).headers !== undefined, true);
  assert.equal(gm.calls[1]?.details.headers?.range, `bytes=0-${65536 - 1}`);
});

test('a body that is not a playlist is left to the browser', async () => {
  gm.setResponder(
    respond({
      sequence: [
        { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '1024' } },
        { status: 200, headers: { 'content-type': 'video/mp4' }, body: '\u0000\u0000\u0000ftypmp42' },
      ],
    }),
  );
  const result = await sniffMedia(parsed());
  assert.equal(result.kind, 'other');
});

test('a HEAD that answers 4xx is not our business', async () => {
  gm.setResponder(respond({ status: 404 }));
  const result = await sniffMedia(parsed());
  assert.equal(result.kind, 'other');
  assert.equal(result.status, 404);
  assert.equal(gm.calls.length, 1, 'no body probe after an error status');
});

test('a local server that is not running leaves the page alone', async () => {
  gm.setResponder(respond({ error: 'ECONNREFUSED' }));
  const result = await sniffMedia(parsed());
  assert.equal(result.kind, 'unknown');
  assert.equal(result.status, 0);
});

test('a huge body of unknown type is never pulled in', async () => {
  setStreamsSupported(false);
  gm.setResponder(
    respond({ status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(64 * 1024 * 1024) } }),
  );
  const result = await sniffMedia(parsed());
  assert.equal(result.kind, 'unknown');
  assert.equal(gm.calls.length, 1, 'the body probe is skipped for a large unknown type');
});

test('an aborted signal stops the probe', async () => {
  gm.setResponder(respond({ hang: true }));
  const controller = new AbortController();
  const promise = sniffMedia(parsed(), controller.signal);
  controller.abort();
  const result = await promise;
  assert.equal(result.kind, 'unknown');
});
