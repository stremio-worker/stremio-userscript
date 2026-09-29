// Target classification: the script may only make GM requests to public hosts.
//
// `@connect *` in the metadata is deliberate. The userscript manager's host
// allowlist is the wrong place to express this policy: the upstream is not known
// until the page hands us a local proxy URL, and the local server writes whatever
// CDN host the stream uses into it. A narrow `@connect` list breaks every real
// stream, and a wildcard without a check here is an SSRF hole: GM_xmlhttpRequest
// has no CORS and no CSP, so a hostile playlist could aim this script at a
// router, a NAS or a cloud metadata service and read the answer back into the
// page.
//
// So the rule lives here and is enforced twice: once where the page controlled
// `d=` parameter is parsed (proxyUrl.sanitizeUpstreamUrl) and once in the
// transport, the only place a request is actually handed to the manager.
//
// There is no exception. The local server is not a GM target: this script never
// talks to it, it only fetches the CDN hosts the local server names. Every other
// route it serves — /version, /hlsv2/*, /proxy/ without a target — is answered by
// the browser, from the page's own fetch, exactly as if this script were not
// installed.
//
// What this cannot cover: a public hostname whose DNS answer points into private
// space (DNS rebinding). A userscript has no resolver, so the check is on the
// literal address and on the shape of the hostname. That is the same limit every
// browser-side SSRF filter has; the local server, which does the real fetching
// for a native player, is not subject to it.

/** Hostnames that name the local machine by convention. */
const LOCAL_NAMES = new Set(['localhost', 'local', 'ip6-localhost', 'ip6-loopback']);

/** Suffixes that only ever resolve inside a local network. */
const LOCAL_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.home.arpa',
  '.corp',
  '.private',
];

export type TargetVerdict = 'public' | 'internal';

export interface TargetCheck {
  verdict: TargetVerdict;
  host: string;
  /** The address the host stands for, when it was a literal. */
  address: string | null;
  /** Why, for one log line and nothing else. */
  reason: string;
}

function allowed(host: string, address: string | null, reason: string): TargetCheck {
  return { verdict: 'public', host, address, reason };
}

function blocked(host: string, address: string | null, reason: string): TargetCheck {
  return { verdict: 'internal', host, address, reason };
}

function parseIpv4(literal: string): number | null {
  const parts = literal.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * A v4 address carried inside an IPv6 one: `::ffff:1.2.3.4`, `::1.2.3.4`,
 * `2002:0102:0304::` (6to4) and `64:ff9b::1.2.3.4` (NAT64). None of them is a
 * way past the v4 rules: the client still opens the socket to that address.
 */
function embeddedIpv4(groups: number[]): number | null {
  const g = (index: number): number => groups[index] ?? 0;
  // v4-mapped is ::ffff:a.b.c.d, the deprecated v4-compatible form is ::a.b.c.d.
  if (g(0) === 0 && g(1) === 0 && g(2) === 0 && g(3) === 0 && g(4) === 0 && (g(5) === 0xffff || g(5) === 0)) {
    return (g(6) << 16) | g(7);
  }
  if (g(0) === 0x2002) {
    return (g(1) << 16) | g(2);
  }
  // NAT64: 64:ff9b::/96 and the local-use prefix 64:ff9b:1::/48.
  if (g(0) === 0x0064 && g(1) === 0xff9b) {
    return (g(6) << 16) | g(7);
  }
  return null;
}

/** Hostname field to the eight 16 bit groups an IPv6 literal stands for. */
function expandIpv6(literal: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(literal)) return null;
  let text = literal;
  if (text.includes('.')) {
    // The parser left the v4-in-v6 tail as text; turn it into two groups.
    const lastColon = text.lastIndexOf(':');
    if (lastColon < 0) return null;
    const value = parseIpv4(text.slice(lastColon + 1));
    if (value === null) return null;
    text = `${text.slice(0, lastColon + 1)}${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}

function privateIpv4Reason(value: number): string | null {
  const first = value >>> 24;
  const second = (value >>> 16) & 0xff;
  const third = (value >>> 8) & 0xff;
  if (first === 0) return 'this network';
  if (first === 127) return 'loopback';
  if (first === 10) return 'private network';
  if (first === 172 && second >= 16 && second <= 31) return 'private network';
  if (first === 192 && second === 168) return 'private network';
  if (first === 100 && second >= 64 && second <= 127) return 'carrier-grade nat';
  if (first === 169 && second === 254) return 'link-local / cloud metadata';
  if (first === 192 && second === 0 && third === 2) return 'documentation';
  if (first === 192 && second === 0 && third === 0 && (value & 0xff) === 9) return 'protocol assignment';
  if (first === 192 && second === 0) return 'ietf protocol assignment';
  if (first === 192 && second === 88) return '6to4 relay anycast';
  if (first === 198 && (second === 18 || second === 19)) return 'benchmarking';
  if (first === 198 && second === 51 && third === 100) return 'documentation';
  if (first === 203 && second === 0 && third === 113) return 'documentation';
  if (first >= 224) return (value >>> 0) === 0xffffffff ? 'broadcast' : 'multicast or reserved';
  return null;
}

function privateIpv6Reason(groups: number[]): string | null {
  const g = (index: number): number => groups[index] ?? 0;
  if (groups.every((group) => group === 0)) return 'unspecified';
  if (g(7) === 1 && groups.slice(0, 7).every((group) => group === 0)) return 'loopback';
  if (g(0) === 0x0100 && g(1) === 0 && g(2) === 0 && g(3) === 0) return 'discard only';
  if ((g(0) & 0xfe00) === 0xfc00) return 'unique local address';
  if ((g(0) & 0xffc0) === 0xfe80) return 'link-local';
  if ((g(0) & 0xff00) === 0xff00) return 'multicast';
  if (g(0) === 0x2001 && g(1) === 0x0db8) return 'documentation';
  if (g(0) === 0x2001 && (g(1) & 0xfff0) === 0x0010) return 'teredo';
  if (g(0) === 0x2001 && g(1) === 0x0000) return 'tunnelling';
  return null;
}

function checkAddress(host: string): TargetCheck | null {
  const dotted = parseIpv4(host);
  if (dotted !== null) {
    const reason = privateIpv4Reason(dotted);
    return reason === null ? allowed(host, host, 'public address') : blocked(host, host, reason);
  }

  if (host.includes(':')) {
    const groups = expandIpv6(host);
    if (groups === null) return blocked(host, null, 'unparseable address');
    // ::1 and :: are decided by their own rules, not as a wrapped 0.0.0.x.
    const special = privateIpv6Reason(groups);
    if (special === 'unspecified' || special === 'loopback') return blocked(host, host, special);
    const embedded = embeddedIpv4(groups);
    if (embedded !== null) {
      const reason = privateIpv4Reason(embedded);
      return reason === null
        ? allowed(host, host, 'public address inside an ipv6 form')
        : blocked(host, host, reason);
    }
    return special === null ? allowed(host, host, 'public address') : blocked(host, host, special);
  }
  return null;
}

export function classifyTarget(value: string | URL): TargetCheck {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(String(value));
  } catch {
    return blocked(String(value), null, 'not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return blocked(url.hostname, null, `scheme ${url.protocol} is not allowed`);
  }
  // The WHATWG parser already folded every obfuscated form of an IPv4 literal
  // (2130706433, 0x7f.1, 017700000001, 127.1) into a dotted quad, so looking at
  // the hostname is enough. IPv6 literals keep their brackets.
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '') return blocked(host, null, 'no host');

  if (LOCAL_NAMES.has(host)) return blocked(host, null, 'loopback name');
  for (const suffix of LOCAL_SUFFIXES) {
    if (host.endsWith(suffix)) return blocked(host, null, `local network name (${suffix})`);
  }

  const literal = checkAddress(host);
  if (literal) return literal;

  // A single label can only be resolved through a local search domain.
  if (!host.includes('.')) return blocked(host, null, 'unqualified name');
  if (host.endsWith('.arpa') || host.endsWith('.invalid')) {
    return blocked(host, null, 'non-routable name');
  }
  return allowed(host, null, 'public hostname');
}

/** The only question the callers ask: may this request be made at all? */
export function isInternalTarget(value: string | URL): boolean {
  return classifyTarget(value).verdict === 'internal';
}
