import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_LOCAL_ORIGIN as LOCAL_ORIGIN } from '../src/config';
import {
  buildProxyUrl,
  isLocalProxyUrl,
  parseProxyUrl,
  sanitizeUpstreamUrl,
} from '../src/proxyUrl';
import { headerValue } from '../src/headers';

const UPSTREAM = 'https://cdn.example.com/stream/index.m3u8';

test('only the exact local proxy origin and path is in scope', () => {
  assert.ok(isLocalProxyUrl(`${LOCAL_ORIGIN}/proxy/?d=${encodeURIComponent(UPSTREAM)}`));
  assert.ok(isLocalProxyUrl(`${LOCAL_ORIGIN}/proxy/d=https://a.example.com&h=Referer:x/y/seg.ts`));

  // Wrong port, host, scheme or path.
  assert.equal(isLocalProxyUrl('http://127.0.0.1:11471/proxy/?d=x'), null);
  assert.equal(isLocalProxyUrl('http://localhost:11470/proxy/?d=x'), null);
  assert.equal(isLocalProxyUrl('https://127.0.0.1:11470/proxy/?d=x'), null);
  assert.equal(isLocalProxyUrl(`${LOCAL_ORIGIN}/hlsv2/index.m3u8`), null);
  assert.equal(isLocalProxyUrl(`${LOCAL_ORIGIN}/other/?d=x`), null);
  // Credentials, fragments and non-strings.
  assert.equal(isLocalProxyUrl(`http://a:b@127.0.0.1:11470/proxy/?d=x`), null);
  assert.equal(isLocalProxyUrl(`${LOCAL_ORIGIN}/proxy/?d=x#frag`), null);
  assert.equal(isLocalProxyUrl('/proxy/?d=x'), null);
  assert.equal(isLocalProxyUrl(null), null);
  assert.equal(isLocalProxyUrl(42), null);
});

test('parseProxyUrl reads the query format and sanitises h=', () => {
  const url = buildProxyUrl(UPSTREAM, { Referer: 'https://ref.example.com/', 'X-Custom': 'v' });
  const parsed = parseProxyUrl(url, { method: 'GET' });
  assert.ok(parsed);
  assert.equal(parsed.upstreamUrl, UPSTREAM);
  assert.equal(headerValue(parsed.headers, 'referer'), 'https://ref.example.com/');
  assert.equal(headerValue(parsed.headers, 'x-custom'), 'v');
  assert.equal(parsed.method, 'GET');
});

test('an h= named sec- header is kept, in both URL formats', () => {
  const query = parseProxyUrl(
    `${LOCAL_ORIGIN}/proxy/?d=${encodeURIComponent(UPSTREAM)}` +
      `&h=${encodeURIComponent('Sec-Fetch-Mode:navigate')}` +
      `&h=${encodeURIComponent('sec-ch-ua:"Chromium";v="120"')}` +
      `&h=${encodeURIComponent('referer:https://ref.example.com/')}`,
    { method: 'GET' },
  );
  assert.ok(query);
  // A CDN that checks these needs them, and only the page can know which CDN and
  // which value, so the h= mechanism is the place they come from.
  assert.equal(headerValue(query.headers, 'sec-fetch-mode'), 'navigate');
  assert.equal(headerValue(query.headers, 'sec-ch-ua'), '"Chromium";v="120"');
  assert.equal(headerValue(query.headers, 'referer'), 'https://ref.example.com/');

  const core = parseProxyUrl(
    `${LOCAL_ORIGIN}/proxy/d=${encodeURIComponent(UPSTREAM)}` +
      `&h=${encodeURIComponent('Sec-Fetch-Site:cross-site')}` +
      `&h=${encodeURIComponent('accept:*/*')}`,
    { method: 'GET' },
  );
  assert.ok(core);
  assert.equal(headerValue(core.headers, 'sec-fetch-site'), 'cross-site');
  assert.equal(headerValue(core.headers, 'accept'), '*/*');
});

test('parseProxyUrl never lets h= inject headers through control characters', () => {
  const parsed = parseProxyUrl(
    `${LOCAL_ORIGIN}/proxy/?d=${encodeURIComponent(UPSTREAM)}` +
      `&h=${encodeURIComponent('Cookie: session=secret')}` +
      `&h=${encodeURIComponent('Referer: https://ok.example.com/\r\nX-Injected: 1')}` +
      `&h=${encodeURIComponent('Sec-Fetch-Mode: navigate')}` +
      `&h=${encodeURIComponent('Sec-Fetch-Dest:\u0000document')}` +
      `&h=${encodeURIComponent('NoColonHere')}`,
  );
  assert.ok(parsed);
  // A URL-borne Cookie is an explicit instruction from the page, not an ambient
  // credential, so it survives.
  assert.equal(headerValue(parsed.headers, 'cookie'), 'session=secret');
  // A param without a colon is not a header, and a value carrying CRLF is
  // dropped whole rather than truncated at the newline. That holds for a sec-
  // header too, which is otherwise allowed through: the check is on the value,
  // not on the family.
  assert.equal(headerValue(parsed.headers, 'nocolonhere'), null);
  assert.equal(headerValue(parsed.headers, 'sec-fetch-mode'), 'navigate');
  assert.equal(headerValue(parsed.headers, 'referer'), null);
  assert.equal(headerValue(parsed.headers, 'x-injected'), null);
  // A sec- header carrying a control character is dropped like any other one.
  assert.equal(headerValue(parsed.headers, 'sec-fetch-dest'), null);
});

test('parseProxyUrl reads the Core path format and appends the trailing path', () => {
  const parsed = parseProxyUrl(
    `${LOCAL_ORIGIN}/proxy/d=https%3A%2F%2Fcdn.example.com%2Fbase%2F&h=Referer%3Ahttps%3A%2F%2Fref.example.com%2F/v1/index.m3u8`,
    { method: 'GET' },
  );
  assert.ok(parsed);
  assert.equal(parsed.upstreamUrl, 'https://cdn.example.com/base/v1/index.m3u8');
  assert.equal(headerValue(parsed.headers, 'referer'), 'https://ref.example.com/');
});

test('parseProxyUrl rejects a missing or unusable target', () => {
  assert.equal(parseProxyUrl(`${LOCAL_ORIGIN}/proxy/`), null);
  assert.equal(parseProxyUrl(`${LOCAL_ORIGIN}/proxy/?d=`), null);
  assert.equal(parseProxyUrl(`${LOCAL_ORIGIN}/proxy/?d=javascript:alert(1)`), null);
  assert.equal(parseProxyUrl(`${LOCAL_ORIGIN}/proxy/?d=${encodeURIComponent('file:///etc/passwd')}`), null);
  assert.equal(parseProxyUrl(`${LOCAL_ORIGIN}/proxy/?d=${encodeURIComponent(`https://x.example.com/${'a'.repeat(2100)}`)}`), null);
});

test('parseProxyUrl ignores the response header override parameter', () => {
  const parsed = parseProxyUrl(
    `${LOCAL_ORIGIN}/proxy/?d=${encodeURIComponent(UPSTREAM)}&r=${encodeURIComponent('content-type:text/html')}`,
  );
  assert.ok(parsed);
  assert.equal(parsed.headers['content-type'], undefined);
});

test('sanitizeUpstreamUrl keeps only plain http(s) URLs', () => {
  assert.equal(sanitizeUpstreamUrl('https://a.example.com/x?y=1'), 'https://a.example.com/x?y=1');
  assert.equal(sanitizeUpstreamUrl('https://user:pw@a.example.com/'), null);
  assert.equal(sanitizeUpstreamUrl('ftp://a.example.com/'), null);
  assert.equal(sanitizeUpstreamUrl('data:text/plain,hi'), null);
  assert.equal(sanitizeUpstreamUrl('not a url'), null);
  assert.equal(sanitizeUpstreamUrl(''), null);
});

test('sanitizeUpstreamUrl refuses every target inside the local network', () => {
  for (const upstream of [
    'http://127.0.0.1:8080/admin',
    'http://192.168.1.1/',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://2130706433/',
    'http://localhost:11470/proxy/?d=http://cdn.example.com/x',
    'http://printer.local/print',
  ]) {
    assert.equal(sanitizeUpstreamUrl(upstream), null, upstream);
  }
});

test('a proxy URL carrying an internal target never parses', () => {
  for (const upstream of [
    'http://192.168.0.1/admin',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://[fd00::1]/',
    'http://nas.local/x.m3u8',
  ]) {
    const url = buildProxyUrl(upstream);
    assert.ok(isLocalProxyUrl(url), 'the page can still send it');
    assert.equal(parseProxyUrl(url), null, 'and the script refuses to answer it');
  }
});

test('the local service is not a target, not even from a playlist', () => {
  // This script never talks to the local server: it fetches the public hosts the
  // server names. So a d= pointing back at the server itself is refused, and the
  // request stays the page's own, answered by the browser.
  for (const upstream of [
    'http://127.0.0.1:11470/version',
    'http://127.0.0.1:11470/proxy/',
    'http://127.0.0.1:8080/',
  ]) {
    assert.equal(sanitizeUpstreamUrl(upstream), null, upstream);
    assert.equal(parseProxyUrl(`${LOCAL_ORIGIN}/proxy/?d=${encodeURIComponent(upstream)}`), null, upstream);
  }
});

test('the method is normalised and unknown methods fall back to GET', () => {
  const head = parseProxyUrl(`${LOCAL_ORIGIN}/proxy/?d=${encodeURIComponent(UPSTREAM)}`, { method: 'head' });
  assert.equal(head?.method, 'HEAD');
  const post = parseProxyUrl(`${LOCAL_ORIGIN}/proxy/?d=${encodeURIComponent(UPSTREAM)}`, { method: 'POST' });
  assert.equal(post?.method, 'GET');
});
