// Header policy. This is the only place that decides what may leave the browser
// towards an upstream host.
//
// Rules (mirroring service/lib/proxy.js so client and server agree):
//   * names must be HTTP tokens, values must be short and single-line
//   * hop-by-hop, credential and framing headers are never forwarded
//   * a page header never overrides a header that came from the proxy URL
//   * only end-to-end response headers are handed back to the page

import { MAX_FORWARDED_HEADERS, MAX_HEADER_VALUE_LENGTH } from './config';

/** Never forwarded, no matter where they came from. */
const DENIED_REQUEST_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

/**
 * Not on the denylist, because the `h=` parameters in a proxy URL are the page
 * telling us exactly which headers the upstream needs (Referer and Origin are
 * the whole reason that mechanism exists), but never taken from the page's own
 * request: forwarding ambient credentials to a host the page chose is the one
 * thing that would turn this into a credential leak.
 */
const NEVER_FROM_PAGE = new Set(['cookie', 'cookie2', 'authorization', 'origin', 'referer']);

/**
 * The userscript manager fills GM_xmlhttpRequest in with the browser's own
 * `sec-*` metadata — the client hints, fetch metadata and privacy signals of the
 * browser it runs in. None of that describes the request we are making on the
 * CDN's behalf, and some of it is a privacy signal about the user that has no
 * business reaching a third party, so they are not forwarded and are suppressed
 * below.
 *
 * This is the browser-managed `sec-*` set of the Fetch spec, kept as a list only
 * because a header map has no wildcard: an empty value is how a manager is told to
 * leave a name alone. Keep it complete, a missing name is exactly the bug of a
 * `sec-gpc` that still reached the CDN.
 *
 * A `sec-*` header the proxy URL names in `h=` is a different thing: that is the
 * page saying a specific CDN needs a specific value, the same statement as
 * `referer` or `user-agent`, and it is allowed through.
 */
const MANAGER_SEC_DEFAULTS = [
  'sec-ch-ua',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-mobile',
  'sec-ch-ua-model',
  'sec-ch-ua-platform',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-wow64',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-storage-access',
  'sec-fetch-user',
  'sec-gpc',
  'sec-purpose',
];

const DENIED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'set-cookie2',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CRLF_RE = /[\r\n]/;

export function isValidHeaderName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && TOKEN_RE.test(name);
}

export function isValidHeaderValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_HEADER_VALUE_LENGTH &&
    !CRLF_RE.test(value) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function isDeniedRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return DENIED_REQUEST_HEADERS.has(lower) || lower.startsWith('proxy-');
}

/**
 * A page cannot set a `sec-*` header, so one arriving with the page's own request
 * is either a bug or an attempt to look like the browser. The proxy tier is
 * exempt: `h=sec-fetch-site:cross-site` is the page naming a header a CDN needs.
 */
function isNeverFromPage(name: string): boolean {
  return NEVER_FROM_PAGE.has(name) || name.startsWith('sec-');
}

export type HeaderMap = Record<string, string>;

/**
 * Copies `source` into `target` when the header is allowed. Later calls win,
 * which is how the tier order (page first, proxy URL last) is applied.
 */
export function applyHeaders(
  target: HeaderMap,
  source: HeaderMap | null | undefined,
  origin: 'page' | 'proxy' | 'internal',
  dropped?: (name: string) => void,
): void {
  if (!source) return;
  for (const rawName of Object.keys(source)) {
    const name = rawName.toLowerCase();
    if (!isValidHeaderName(name) || !isValidHeaderValue(String(source[rawName]))) {
      dropped?.(name);
      continue;
    }
    if (isDeniedRequestHeader(name)) {
      dropped?.(name);
      continue;
    }
    if (origin === 'page' && isNeverFromPage(name)) {
      dropped?.(name);
      continue;
    }
    if (Object.keys(target).length >= MAX_FORWARDED_HEADERS && !(name in target)) {
      dropped?.(name);
      continue;
    }
    target[name] = String(source[rawName]);
  }
}

/**
 * Stops the manager from adding its own client hints, by giving it an empty
 * value for each name it would otherwise fill in — that is how a manager is told
 * to leave a header alone. Only the ones we are not sending a real value for are
 * blanked, so an `h=` requested `sec-` value still reaches the CDN.
 *
 * A manager that does not honour an empty value simply sends its default, which
 * is the behaviour we had before, so this can only help.
 */
export function suppressManagerSecDefaults(headers: HeaderMap): HeaderMap {
  for (const name of MANAGER_SEC_DEFAULTS) {
    if (!(name in headers)) headers[name] = '';
  }
  return headers;
}

export function countHeaders(headers: HeaderMap): number {
  return Object.keys(headers).length;
}

/** Response headers we hand to the page. */
export function filterResponseHeaders(headers: HeaderMap): HeaderMap {
  const out: HeaderMap = {};
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (DENIED_RESPONSE_HEADERS.has(lower) || lower.startsWith('sec-')) continue;
    if (!isValidHeaderName(lower) || !isValidHeaderValue(headers[name] ?? '')) continue;
    out[lower] = headers[name] as string;
  }
  return out;
}

/** XHR style serialisation, as `getAllResponseHeaders()` returns it. */
export function serializeHeaders(headers: HeaderMap): string {
  return Object.keys(headers)
    .map((name) => `${name}: ${headers[name]}`)
    .join('\r\n');
}

/** GM's raw `responseHeaders` string into a map (lowercased names). */
export function parseRawHeaders(raw: string | undefined | null): HeaderMap {
  const out: HeaderMap = {};
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!name || !value) continue;
    out[name] = value;
  }
  return out;
}

export function headerValue(headers: HeaderMap, name: string): string | null {
  const value = headers[name.toLowerCase()];
  return typeof value === 'string' ? value : null;
}
