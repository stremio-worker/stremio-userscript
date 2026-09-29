// The rewrite has to agree with the local server (service/lib/proxy.js
// getParserStream), because the two rewrite the same bytes: the server does it
// when the browser asks it, this script does it when it asks the CDN itself.

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProxyUrl } from '../src/proxyUrl';
import {
  isPlaylistResponse,
  rewritePlaylistBytes,
  rewritePlaylistLine,
  rewritePlaylistStream,
} from '../src/playlist';

const BASE = 'https://cdn.example.com/stream/index.m3u8';
const HEADERS = { referer: 'https://service.strem.io/', origin: 'https://service.strem.io' };

function proxy(target: string, headers: Record<string, string> = HEADERS): string {
  return buildProxyUrl(target, headers);
}

function bytes(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

function text(buffer: ArrayBuffer): string {
  return new TextDecoder('utf-8').decode(new Uint8Array(buffer));
}

test('a segment line is resolved against the playlist and wrapped', () => {
  assert.equal(
    rewritePlaylistLine('seg1.ts', BASE, {}),
    proxy('https://cdn.example.com/stream/seg1.ts', {}),
  );
  assert.equal(
    rewritePlaylistLine('/abs/seg1.ts', BASE, {}),
    proxy('https://cdn.example.com/abs/seg1.ts', {}),
    'root relative',
  );
  assert.equal(
    rewritePlaylistLine('https://other.example.com/x.ts', BASE, {}),
    proxy('https://other.example.com/x.ts', {}),
    'absolute, another host',
  );
  assert.equal(
    rewritePlaylistLine('../up/seg1.ts', BASE, {}),
    proxy('https://cdn.example.com/up/seg1.ts', {}),
    'dot dot',
  );
});

test('every URI bearing tag is rewritten', () => {
  for (const tag of [
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/en.m3u8"',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8"',
    '#EXT-X-PART:DURATION=1,URI="part1.ts"',
  ]) {
    const rewritten = rewritePlaylistLine(tag, BASE, {});
    assert.ok(rewritten.includes('http://127.0.0.1:11470/proxy/?d='), `${tag} was not rewritten`);
    // A relative URI is resolved against the playlist, an absolute one is kept.
    const expectedUri = /URI="([^"]+)"/.exec(tag)?.[1] ?? '';
    const target = new URL(expectedUri, BASE).toString();
    assert.ok(
      rewritten.includes(proxy(target, {})),
      `${tag} should point at ${target}, got ${rewritten}`,
    );
    assert.equal(rewritten.replace(proxy(target, {}), expectedUri), tag, tag);
  }
});

test('a tag without a URI is left exactly as it was', () => {
  for (const tag of [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",DEFAULT=YES',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXT-X-ENDLIST',
  ]) {
    assert.equal(rewritePlaylistLine(tag, BASE, HEADERS), tag);
  }
});

test('a blank line stays blank', () => {
  assert.equal(rewritePlaylistLine('', BASE, HEADERS), '');
});

test('a reference the proxy cannot fetch is left alone', () => {
  // A FairPlay key or an inline data: URI is not something the proxy can serve,
  // and naming it as a target would break a key the browser handles itself.
  for (const reference of [
    '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://k"',
    '#EXT-X-MAP:URI="data:application/octet-stream;base64,AAAA"',
  ]) {
    assert.equal(rewritePlaylistLine(reference, BASE, HEADERS), reference);
  }
});

test('the rewritten URL names the local server outright, not a relative path', () => {
  const rewritten = rewritePlaylistLine('seg1.ts', BASE, HEADERS);

  assert.equal(
    rewritten,
    'http://127.0.0.1:11470/proxy/?d=' +
      encodeURIComponent('https://cdn.example.com/stream/seg1.ts') +
      `&h=${encodeURIComponent('referer:https://service.strem.io/')}` +
      `&h=${encodeURIComponent('origin:https://service.strem.io')}`,
  );
});

test('a rewritten reference cannot end up on the page own origin', () => {
  // This is the bug that mattered: a relative `/proxy/?d=…` is resolved by
  // hls.js against the page it is running in, so every segment went to
  // https://load.example/proxy/?d=… instead of the local server.
  for (const reference of [
    'seg1.ts',
    '/hls/11/seg-1-v1-a1.txt',
    'https://cdn.example.com/stream/seg2.ts',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k1"',
  ]) {
    const line = rewritePlaylistLine(reference, BASE, HEADERS);
    const urls = line.includes('URI="') ? [line.slice(line.indexOf('URI="') + 5, line.indexOf('"', 5 + line.indexOf('URI="')))] : [line];
    for (const url of urls) {
      assert.ok(url.startsWith('http://127.0.0.1:11470/proxy/?'), `${url} is not the local server`);
      // And where the page resolves it from makes no difference.
      const fromPage = new URL(url, 'https://load.prectv63.lol/');
      assert.equal(fromPage.origin, 'http://127.0.0.1:11470');
      assert.equal(new URL(url, 'http://127.0.0.1:8080/').origin, 'http://127.0.0.1:11470');
    }
  }
});

test('line endings survive, and a file with no final newline does not grow one', () => {
  const crlf = proxy('https://cdn.example.com/stream/seg1.ts', {});
  assert.equal(
    text(rewritePlaylistBytes(bytes('#EXTM3U\r\nseg1.ts\r\n'), BASE, {})),
    `#EXTM3U\r\n${crlf}\r\n`,
  );
  assert.equal(
    text(rewritePlaylistBytes(bytes('#EXTM3U\nseg1.ts'), BASE, {})),
    `#EXTM3U\n${crlf}`,
    'no newline is invented',
  );
  assert.equal(
    text(rewritePlaylistBytes(bytes('#EXTM3U\nseg1.ts\r\nseg2.ts'), BASE, {})),
    `#EXTM3U\n${crlf}\r\n${proxy('https://cdn.example.com/stream/seg2.ts', {})}`,
    'a file with mixed endings keeps each of them',
  );
});

test('a whole master playlist comes out right', () => {
  const source = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k1"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
    'https://cdn.example.com/stream/high/index.m3u8',
    '',
  ].join('\n');

  assert.equal(
    text(rewritePlaylistBytes(bytes(source), BASE, {})),
    [
      '#EXTM3U',
      `#EXT-X-KEY:METHOD=AES-128,URI="${proxy('https://keys.example.com/k1', {})}"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      proxy('https://cdn.example.com/stream/low/index.m3u8', {}),
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
      proxy('https://cdn.example.com/stream/high/index.m3u8', {}),
      '',
    ].join('\n'),
  );
});

test('a stream is rewritten chunk by chunk, mid line if need be', async () => {
  // Chunks split anywhere, including inside a line, which is what a real chunked
  // response does.
  const encoder = new TextEncoder();
  const pieces = ['#EXT', 'M3U\n#EXT-X-KEY:METHOD=AES-128,UR', 'I="key.bin"\nseg1', '.ts\nseg2.ts\n'];
  const rewritten = rewritePlaylistStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece));
        controller.close();
      },
    }),
    BASE,
    {},
  );

  const reader = rewritten.getReader();
  const decoder = new TextDecoder('utf-8');
  let out = '';
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    out += decoder.decode(result.value, { stream: true });
  }
  out += decoder.decode();

  assert.equal(
    out,
    [
      '#EXTM3U',
      `#EXT-X-KEY:METHOD=AES-128,URI="${proxy('https://cdn.example.com/stream/key.bin', {})}"`,
      proxy('https://cdn.example.com/stream/seg1.ts', {}),
      proxy('https://cdn.example.com/stream/seg2.ts', {}),
      '',
    ].join('\n'),
  );
});

test('a multi byte character split across chunks is decoded once, not twice', async () => {
  // The server decodes each chunk on its own, which turns a split character into
  // two replacement characters. Here it must not.
  const source = '#EXT-X-MEDIA:NAME="Favoriler — Türkçe"\nseg1.ts\n';
  const encoded = new TextEncoder().encode(source);
  const split = encoded.indexOf(0xe2) + 1; // inside "—", whose three bytes continue
  const rewritten = rewritePlaylistStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, split));
        controller.enqueue(encoded.slice(split));
        controller.close();
      },
    }),
    BASE,
    {},
  );

  const reader = rewritten.getReader();
  const decoder = new TextDecoder('utf-8');
  let out = '';
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    out += decoder.decode(result.value, { stream: true });
  }
  out += decoder.decode();

  assert.equal(
    out,
    `#EXT-X-MEDIA:NAME="Favoriler — Türkçe"\n${proxy('https://cdn.example.com/stream/seg1.ts', {})}\n`,
  );
  assert.ok(!out.includes('�'), 'no replacement characters');
});

test('a playlist is recognised the way the server recognises one', () => {
  assert.equal(isPlaylistResponse('application/vnd.apple.mpegurl', 'https://x/y'), true);
  assert.equal(isPlaylistResponse('application/x-mpegURL; charset=utf-8', 'https://x/y'), true);
  assert.equal(isPlaylistResponse('audio/mpegurl', 'https://x/y'), true);
  assert.equal(isPlaylistResponse('text/plain', 'https://cdn.example.com/a/b.m3u8'), true, 'suffix');
  assert.equal(isPlaylistResponse('text/plain', 'https://cdn.example.com/a/b.M3U'), true, 'case');
  assert.equal(isPlaylistResponse('video/mp2t', 'https://cdn.example.com/a/b.ts'), false);
  assert.equal(isPlaylistResponse('video/mp4', 'https://cdn.example.com/a/b.mpd'), false, 'DASH is not HLS');
  assert.equal(isPlaylistResponse(null, 'https://cdn.example.com/a/b.m3u8?token=1'), true, 'query');
});
