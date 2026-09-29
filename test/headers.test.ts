import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyHeaders,
  countHeaders,
  filterResponseHeaders,
  headerValue,
  isDeniedRequestHeader,
  suppressManagerSecDefaults,
  isValidHeaderName,
  isValidHeaderValue,
  parseRawHeaders,
  serializeHeaders,
  type HeaderMap,
} from '../src/headers';

test('header names must be HTTP tokens', () => {
  assert.equal(isValidHeaderName('content-type'), true);
  assert.equal(isValidHeaderName('X-Custom-Header'), true);
  assert.equal(isValidHeaderName(''), false);
  assert.equal(isValidHeaderName('bad header'), false);
  assert.equal(isValidHeaderName('bad:header'), false);
  assert.equal(isValidHeaderName('a'.repeat(129)), false);
});

test('header values must be single line and bounded', () => {
  assert.equal(isValidHeaderValue('application/json'), true);
  assert.equal(isValidHeaderValue('a: b'), true);
  assert.equal(isValidHeaderValue('with\r\nX-Evil: 1'), false);
  assert.equal(isValidHeaderValue('with\nnewline'), false);
  assert.equal(isValidHeaderValue('nul\u0000byte'), false);
  assert.equal(isValidHeaderValue('del\u007f'), false);
  assert.equal(isValidHeaderValue(''), false);
  assert.equal(isValidHeaderValue('a'.repeat(1025)), false);
});

test('hop-by-hop headers are never forwarded from any tier', () => {
  for (const name of [
    'connection',
    'transfer-encoding',
    'content-length',
    'host',
    'expect',
    'accept-encoding',
    'proxy-authorization',
    'proxy-connection',
    'proxy-anything-else',
    'TE',
    'Upgrade',
    'via',
  ]) {
    assert.equal(isDeniedRequestHeader(name), true, name);
  }
  for (const name of [
    'Sec-Fetch-Site',
    'SEC-CH-UA-Mobile',
    'sec-websocket-key',
    'sec-purpose',
    'sec-ch-ua-platform',
    'sec-fetch-dest',
  ]) {
    // Not a global ban: an h= parameter naming a sec- header is the page saying
    // a CDN needs that exact value, the same statement as referer. The page
    // tier and the manager's own defaults are handled separately.
    assert.equal(isDeniedRequestHeader(name), false, name);
  }
  assert.equal(isDeniedRequestHeader('user-agent'), false);
  assert.equal(isDeniedRequestHeader('range'), false);
  assert.equal(isDeniedRequestHeader('referer'), false, 'referer is only denied from the page tier');
  assert.equal(isDeniedRequestHeader('cookie'), false, 'cookie is only denied from the page tier');
});

test('applyHeaders drops ambient credentials from the page but keeps them from the proxy URL', () => {
  const fromPage: HeaderMap = {};
  applyHeaders(fromPage, { Cookie: 'session=abc', Authorization: 'Bearer x', 'X-Ok': '1' }, 'page');
  assert.deepEqual(fromPage, { 'x-ok': '1' });

  const pageWithOrigin: HeaderMap = {};
  applyHeaders(pageWithOrigin, { Origin: 'https://web.stremio.com', Referer: 'https://web.stremio.com/' }, 'page');
  assert.deepEqual(pageWithOrigin, {});

  const fromProxy: HeaderMap = {};
  applyHeaders(fromProxy, { Cookie: 'session=abc', Authorization: 'Bearer x', Referer: 'https://ref/' }, 'proxy');
  assert.deepEqual(fromProxy, {
    cookie: 'session=abc',
    authorization: 'Bearer x',
    referer: 'https://ref/',
  });
});

test('applyHeaders lowercases names and lets the last tier win', () => {
  const headers: HeaderMap = {};
  applyHeaders(headers, { 'X-Token': 'from-page' }, 'page');
  applyHeaders(headers, { 'x-token': 'from-proxy' }, 'proxy');
  assert.equal(headerValue(headers, 'X-TOKEN'), 'from-proxy');
  assert.equal(countHeaders(headers), 1);
});

test('applyHeaders enforces the forwarding limit', () => {
  const headers: HeaderMap = {};
  const many: HeaderMap = {};
  for (let i = 0; i < 32; i += 1) many[`x-h${i}`] = String(i);
  applyHeaders(headers, many, 'proxy');
  assert.equal(countHeaders(headers), 16);
});

test('applyHeaders reports what it dropped', () => {
  const dropped: string[] = [];
  applyHeaders({ Cookie: 'a' }, { Cookie: 'a' }, 'page', (name) => dropped.push(name));
  assert.deepEqual(dropped, ['cookie']);
});

test('a sec- header is dropped from the page, but kept when h= asks for it', () => {
  const fromPage: Record<string, string> = {};
  applyHeaders(
    fromPage,
    {
      'Sec-Fetch-Mode': 'navigate',
      'sec-ch-ua': '"Chromium";v="120"',
      'user-agent': 'kept',
      // Referer is denied from the page tier for a different reason: it is
      // ambient state, and a host the page chose must never be handed it.
      referer: 'https://ref.example.com/',
    },
    'page',
  );
  // A page cannot set a sec-* header, so one arriving with its own request is
  // either a bug or an attempt to look like the browser.
  assert.deepEqual(fromPage, { 'user-agent': 'kept' });

  const fromProxyUrl: Record<string, string> = {};
  applyHeaders(fromProxyUrl, { 'sec-fetch-site': 'cross-site', accept: '*/*' }, 'proxy');
  // An h= parameter is the page naming a header the CDN asked for, so this one
  // is exactly what the CDNs that need it are relying on.
  assert.deepEqual(fromProxyUrl, { 'sec-fetch-site': 'cross-site', accept: '*/*' });
});

test('the manager sec- defaults are blanked, a real value is left alone', () => {
  const headers: Record<string, string> = { 'sec-ch-ua': '"Chromium";v="120"', accept: '*/*' };
  suppressManagerSecDefaults(headers);

  // An empty value is how a manager is told to leave a header alone, so it
  // cannot add its own client hints on top of what we decided to send.
  assert.equal(headers['sec-fetch-mode'], '');
  assert.equal(headers['sec-fetch-dest'], '');
  assert.equal(headers['sec-fetch-site'], '');
  assert.equal(headers['sec-fetch-user'], '');
  assert.equal(headers['sec-ch-ua-mobile'], '');
  assert.equal(headers['sec-ch-ua-platform'], '');
  // sec-gpc is the one that was seen going out, and it is a privacy signal
  // about the user rather than anything about the request.
  assert.equal(headers['sec-gpc'], '');
  // And the one we mean to send keeps its value.
  assert.equal(headers['sec-ch-ua'], '"Chromium";v="120"');
  assert.equal(headers.accept, '*/*');
});

test('every suppressed name belongs to the browser managed sec- family', () => {
  // The list is a list only because a header map has no wildcard, so it has to
  // be right by inspection: anything that is not a sec- name would be a header
  // we blank for no reason at all.
  const blanked: Record<string, string> = { 'user-agent': 'kept', referer: 'https://ref.example.com/' };
  suppressManagerSecDefaults(blanked);

  const added = Object.keys(blanked).filter((name) => name !== 'user-agent' && name !== 'referer');
  assert.equal(added.length, 17, `the spec set changed: ${added.join(', ')}`);
  for (const name of added) {
    assert.equal(name.startsWith('sec-'), true, name);
    assert.equal(blanked[name], '', name);
  }
  // Both halves of the client hint family, the fetch metadata and the privacy
  // signals, so a rename in any of them shows up here.
  for (const name of [
    'sec-ch-ua-arch',
    'sec-ch-ua-bitness',
    'sec-ch-ua-full-version',
    'sec-ch-ua-full-version-list',
    'sec-ch-ua-model',
    'sec-ch-ua-platform-version',
    'sec-ch-ua-wow64',
    'sec-fetch-storage-access',
    'sec-gpc',
    'sec-purpose',
  ]) {
    assert.equal(name in blanked, true, name);
  }
});

test('filterResponseHeaders removes set-cookie and sec- headers', () => {
  const filtered = filterResponseHeaders({
    'content-type': 'video/mp2t',
    'set-cookie': 'a=b',
    'set-cookie2': 'a=b',
    'sec-ch-ua': 'x',
    connection: 'keep-alive',
  });
  assert.deepEqual(filtered, { 'content-type': 'video/mp2t' });
});

test('parseRawHeaders survives malformed input', () => {
  const parsed = parseRawHeaders('Content-Type: video/mp2t\r\nbroken\r\n: novalue\r\nAge: 12');
  assert.deepEqual(parsed, { 'content-type': 'video/mp2t', age: '12' });
  assert.deepEqual(parseRawHeaders(undefined), {});
});

test('serializeHeaders uses the XHR format', () => {
  assert.equal(serializeHeaders({ 'content-type': 'video/mp2t' }), 'content-type: video/mp2t');
  assert.equal(serializeHeaders({}), '');
});
