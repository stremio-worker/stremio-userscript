import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTarget, isInternalTarget } from '../src/ssrf';

function verdictOf(url: string): string {
  return classifyTarget(url).verdict;
}

test('public targets are allowed', () => {
  for (const url of [
    'https://cdn.example.com/stream/index.m3u8',
    'http://93.184.216.34/segment1.ts',
    'https://8.8.8.8/dns-query',
    'https://[2606:2800:220:1:248:1893:25c8:1946]/',
  ]) {
    assert.equal(verdictOf(url), 'public', url);
    assert.equal(isInternalTarget(url), false, url);
  }
});

test('the local server is the one private target we are allowed to reach', () => {
  // The local server is not a GM target. It answers the page's own requests, and
  // this script only ever fetches the public hosts the server names.
  const check = classifyTarget('http://127.0.0.1:11470/version');
  assert.equal(check.verdict, 'internal');
  assert.equal(isInternalTarget('http://127.0.0.1:11470/version'), true);
  assert.equal(
    isInternalTarget('http://127.0.0.1:11470/proxy/?d=https://cdn.example.com/x.m3u8'),
    true,
    'even one naming a public target, because the request would go to the server',
  );
});

test('the local service and its neighbours are all internal', () => {
  for (const url of [
    'http://127.0.0.1:11470/version',
    'http://127.0.0.1:11470/proxy/',
    'http://127.0.0.1:8080/',
    'http://127.0.0.1/',
    'https://127.0.0.1:11470/version',
  ]) {
    assert.equal(verdictOf(url), 'internal', url);
  }
});

test('loopback and unspecified addresses are refused', () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://127.1.2.3/',
    'http://0.0.0.0/',
    'http://0.0.0.1/',
    'http://[::1]/',
    'http://[::]/',
  ]) {
    assert.equal(verdictOf(url), 'internal', url);
  }
});

test('private and carrier-grade ranges are refused', () => {
  for (const url of [
    'http://10.0.0.5/',
    'http://10.255.255.254/',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.0.1/',
    'http://192.168.1.1:8080/admin',
    'http://100.64.0.1/',
    'http://100.127.255.255/',
  ]) {
    assert.equal(verdictOf(url), 'internal', url);
  }
});

test('the cloud metadata address is refused', () => {
  const check = classifyTarget('http://169.254.169.254/latest/meta-data/iam/');
  assert.equal(check.verdict, 'internal');
  assert.match(check.reason, /metadata/);
});

test('link-local, multicast and reserved addresses are refused', () => {
  for (const url of [
    'http://169.254.1.1/',
    'http://224.0.0.1/',
    'http://239.255.255.250/',
    'http://240.0.0.1/',
    'http://255.255.255.255/',
    'http://192.0.0.1/',
    'http://192.0.2.5/',
    'http://198.18.0.1/',
    'http://198.51.100.7/',
    'http://203.0.113.9/',
  ]) {
    assert.equal(verdictOf(url), 'internal', url);
  }
});

test('the private 172.16/12 block is bounded on both sides', () => {
  assert.equal(verdictOf('http://172.15.255.255/'), 'public');
  assert.equal(verdictOf('http://172.16.0.0/'), 'internal');
  assert.equal(verdictOf('http://172.31.255.255/'), 'internal');
  assert.equal(verdictOf('http://172.32.0.0/'), 'public');
});

test('an obfuscated IPv4 literal is folded by the parser and then refused', () => {
  for (const url of [
    'http://2130706433/', // 127.0.0.1 in decimal
    'http://0x7f000001/', // 127.0.0.1 in hex
    'http://017700000001/', // 127.0.0.1 in octal
    'http://127.1/', // short form
    'http://0/',
    'http://0x0/',
  ]) {
    assert.notEqual(verdictOf(url), 'public', url);
  }
  assert.equal(verdictOf('http://2130706433/'), 'internal');
});

test('a public decimal literal is still allowed', () => {
  // 93.184.216.34 in decimal.
  assert.equal(verdictOf('http://1567597386/'), 'public');
});

test('ipv6 private space is refused', () => {
  for (const url of [
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456:789a::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
    'http://[100::1]/',
    'http://[2001:db8::1]/',
    'http://[2001:0:1234::1]/', // teredo
    'http://[2001::1]/', // tunnelling
    'http://[::127.0.0.1]/', // v4-compatible loopback
  ]) {
    assert.equal(verdictOf(url), 'internal', url);
  }
});

test('an ipv4 address hidden in an ipv6 form is found', () => {
  for (const url of [
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::127.0.0.1]/',
    'http://[2002:7f00:1::]/', // 6to4 wrapping 127.0.0.1
    'http://[64:ff9b::7f00:1]/', // NAT64 wrapping 127.0.0.1
    'http://[64:ff9b::a00:1]/', // NAT64 wrapping 10.0.0.1
  ]) {
    assert.equal(verdictOf(url), 'internal', url);
  }
});

test('a public ipv6 address stays allowed', () => {
  assert.equal(verdictOf('http://[2606:2800:220:1:248:1893:25c8:1946]/'), 'public');
  assert.equal(verdictOf('http://[2a00:1450:4001:82f::200e]/'), 'public');
  assert.equal(verdictOf('http://[2002:5db8::1]/'), 'public', '6to4 around a public address');
});

test('local names are refused whatever their case or trailing dot', () => {
  for (const url of [
    'http://localhost/',
    'http://LocalHost:11470/',
    'http://localhost./',
    'http://printer.local/',
    'http://nas.internal/',
    'http://gateway.lan/',
    'http://data.home.arpa/',
    'http://wiki.corp/',
    'http://box.intranet/',
  ]) {
    assert.equal(verdictOf(url), 'internal', url);
  }
});

test('a single label host is refused: it only resolves on a local domain', () => {
  for (const url of ['http://nas/', 'http://router/', 'http://media-server:8096/x.m3u8']) {
    assert.equal(verdictOf(url), 'internal', url);
  }
});

test('a public-looking name that resolves into private space is the known limit', () => {
  // There is no resolver in a userscript, so a name that looks public is taken
  // at face value. This is the DNS rebinding hole every browser-side filter has,
  // and it is why the local server is the component that does the real fetching.
  const check = classifyTarget('http://127.0.0.1.nip.io/stream.m3u8');
  assert.equal(check.verdict, 'public');
  assert.equal(check.reason, 'public hostname');
  assert.equal(check.address, null, 'nothing was resolved, nothing was guessed');
});

test('non http schemes are refused', () => {
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com/x',
    'gopher://example.com/',
    'javascript:alert(1)',
    'data:text/plain,hello',
  ]) {
    assert.equal(verdictOf(url), 'internal', url);
  }
});

test('something that is not a URL is refused', () => {
  assert.equal(verdictOf('not a url'), 'internal');
  assert.equal(verdictOf(''), 'internal');
  assert.equal(isInternalTarget('http://'), true);
});

test('the reason never leaks the whole URL', () => {
  const check = classifyTarget('http://192.168.0.1/admin?token=secret');
  assert.equal(check.verdict, 'internal');
  assert.equal(check.reason, 'private network');
  assert.equal(check.address, '192.168.0.1');
  assert.equal(check.host, '192.168.0.1');
});
