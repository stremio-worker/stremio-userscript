// Parsing of the local proxy URL format produced by service/lib/proxy.js.
//
//   Format 1 (query)     /proxy/?d=<url>&h=<Header:value>[&h=...][&r=...]
//   Format 2 (Core)      /proxy/<d=..&h=..>/<path appended to the target>
//
// Both are produced by the server's buildProxyUrl()/parseProxyParams(), and both
// are accepted here. Everything that is not a local `/proxy/` URL is rejected
// before any parsing happens, so the script never turns into an open relay.

import {
  ALLOWED_METHODS,
  LOCAL_HOST,
  LOCAL_ORIGIN,
  LOCAL_PORT,
  LOCAL_SCHEME,
  MAX_UPSTREAM_URL_LENGTH,
  PROXY_PATH_PREFIX,
  type AllowedMethod,
} from './config';
import { applyHeaders, type HeaderMap } from './headers';
import { logOnce, safeUpstream } from './log';
import { classifyTarget } from './ssrf';
import { isLocalServiceDown } from './localService';

export interface ParsedProxyUrl {
  /** Absolute http(s) target the local server should be asked for. */
  upstreamUrl: string;
  /** Sanitised `h=` headers, lowercased. */
  headers: HeaderMap;
  /** Method of the request this URL came from, when known. */
  method: AllowedMethod;
}

/**
 * Drops URL credentials, anything that is not a plain http(s) URL, and anything
 * that points into the local network. The `d=` parameter is page controlled: it
 * comes out of a playlist, and GM_xmlhttpRequest would happily reach a router, a
 * NAS or a cloud metadata service with no CORS and no CSP in the way.
 */
export function sanitizeUpstreamUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > MAX_UPSTREAM_URL_LENGTH) {
    logOnce('upstream-too-long', 'proxyUrl: upstream URL longer than', MAX_UPSTREAM_URL_LENGTH);
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  const target = classifyTarget(url);
  if (target.verdict === 'internal') {
    logOnce('upstream-internal', `proxyUrl: refusing an internal target (${target.reason}):`, safeUpstream(url.href));
    return null;
  }
  return url.toString();
}

function normalizeMethod(value: unknown): AllowedMethod {
  const upper = typeof value === 'string' ? value.toUpperCase() : 'GET';
  return (ALLOWED_METHODS as readonly string[]).includes(upper) ? (upper as AllowedMethod) : 'GET';
}

/**
 * Strict origin + path check. Runs before any header or upstream handling, on
 * both the fetch and the video.src path.
 */
export function isLocalProxyUrl(value: unknown): URL | null {
  if (typeof value !== 'string' && !(typeof URL === 'function' && value instanceof URL)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  if (url.protocol !== LOCAL_SCHEME) return null;
  if (url.hostname !== LOCAL_HOST) return null;
  if (url.port !== LOCAL_PORT) return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.hash !== '') return null;
  if (!url.pathname.startsWith(PROXY_PATH_PREFIX)) return null;
  return url;
}

interface ParseResult {
  target: string;
  headers: HeaderMap;
}

/** Format 1: `?d=` and `?h=` query parameters. */
function parseQueryFormat(search: URLSearchParams, headers: HeaderMap): ParseResult | null {
  const d = search.get('d');
  if (!d) return null;
  collectHeaderParams(search.getAll('h'), headers);
  if (search.has('r')) {
    logOnce('r-param', 'proxyUrl: ignoring "r=" response header override');
  }
  return { target: d, headers };
}

/** Format 2: the options live in the first path segment. */
function parsePathFormat(rest: string, headers: HeaderMap): ParseResult {
  const slash = rest.indexOf('/');
  const querySegment = slash >= 0 ? rest.slice(0, slash) : rest;
  const pathSegment = slash >= 0 ? rest.slice(slash + 1) : '';

  let target = '';
  const localHeaders: Array<[string, string]> = [];

  for (const segment of querySegment.split('&')) {
    const equals = segment.indexOf('=');
    if (equals === -1) continue;
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(segment.slice(0, equals));
      value = decodeURIComponent(segment.slice(equals + 1));
    } catch {
      continue;
    }
    if (key === 'd') {
      target = value;
    } else if (key === 'h') {
      const colon = value.indexOf(':');
      if (colon > 0) localHeaders.push([value.slice(0, colon).trim(), value.slice(colon + 1).trim()]);
    } else if (key === 'r') {
      logOnce('r-param', 'proxyUrl: ignoring "r=" response header override');
    } else {
      logOnce('unknown-param', 'proxyUrl: ignoring unknown option', JSON.stringify(key));
    }
  }

  // Same rule as service/lib/proxy.js: the trailing path is appended to the
  // target, with a slash inserted when the target has no trailing one.
  if (target && pathSegment) {
    if (!target.endsWith('/')) target += '/';
    target += pathSegment;
  } else if (!target && rest) {
    target = rest;
  }

  for (const [name, value] of localHeaders) {
    applyHeaders(headers, { [name]: value }, 'proxy');
  }
  return { target, headers };
}

function collectHeaderParams(values: string[], headers: HeaderMap): void {
  for (const value of values) {
    const colon = value.indexOf(':');
    if (colon <= 0) continue;
    const name = value.slice(0, colon).trim();
    const headerValue = value.slice(colon + 1).trim();
    applyHeaders(headers, { [name]: headerValue }, 'proxy');
  }
}

export interface ParseProxyUrlOptions {
  method?: unknown;
}

/**
 * Full parse of a local proxy URL. Returns null unless the value is a local
 * proxy URL that carries a usable, sanitised http(s) target.
 */
export function parseProxyUrl(value: unknown, options: ParseProxyUrlOptions = {}): ParsedProxyUrl | null {
  const url = isLocalProxyUrl(value);
  if (!url) return null;

  const headers: HeaderMap = {};
  const rest = url.pathname.slice(PROXY_PATH_PREFIX.length);

  // A query string may accompany either format; the server accepts it too.
  let result = parseQueryFormat(url.searchParams, headers);
  if (!result) {
    result = parsePathFormat(rest, headers);
  }

  const upstreamUrl = sanitizeUpstreamUrl(result.target);
  if (!upstreamUrl) return null;

  if (upstreamUrl.length > 64) {
    logOnce('parsed', 'proxyUrl: intercepting', safeUpstream(upstreamUrl), 'with', Object.keys(headers).length, 'header(s)');
  }

  return { upstreamUrl, headers, method: normalizeMethod(options.method) };
}

/**
 * The one gate every hook asks before taking a request over, and it answers
 * three questions at once, because checking them apart is how a request for
 * something that is not ours gets answered as if it were:
 *
 *   1. is it the local origin and the `/proxy/` path at all?
 *      `/version`, `/hlsv2/*` and the server's other routes are none of our
 *      business, they belong to the page and to the native load path;
 *   2. does it carry a target in the server's format (`?d=` or the Core path
 *      form)? A bare `/proxy/` does not, and the server would answer 400
 *      "Missing proxy target URL";
 *   3. is that target something we are allowed to fetch? The server runs
 *      checkTargetNotPrivate() for the same reason.
 *
 * A null result means: leave the request to the browser, unchanged.
 */
export function parseForInterception(
  value: unknown,
  options: ParseProxyUrlOptions = {},
): ParsedProxyUrl | null {
  // One more reason to stay out of the way, and the only one that is not about the
  // URL: while the local service is not answering there is nothing this script can
  // do for the page. Intervening would only replace a request that fails at once
  // with one that fails after our own timeouts, so the page gets the native
  // behaviour, exactly as it would if this script were not installed.
  if (isLocalServiceDown()) return null;
  return parseProxyUrl(value, options);
}

/**
 * The inverse of the parsers. This is what puts a playlist's own references back
 * into the proxy format (see playlist.ts), so they come back through this script
 * and get the same treatment as the playlist itself: the same `h=` headers, the
 * same SSRF policy, GM transport instead of the browser.
 *
 * The local origin is written out, unlike the server's buildProxyUrl(), which
 * leaves the path relative. A relative `/proxy/?d=…` is only correct for whoever
 * loaded the playlist: the browser asks the local server, so relative works there.
 * Here the body is handed to a page on some other origin, and hls.js resolves
 * those references against the page — `https://load.example/proxy/?d=…`, a path
 * that has nothing to do with us. Absolute, it is the same URL wherever it is
 * resolved from.
 */
export function buildProxyUrl(upstreamUrl: string, headers: HeaderMap = {}): string {
  let out = `${LOCAL_ORIGIN}${PROXY_PATH_PREFIX}?d=${encodeURIComponent(upstreamUrl)}`;
  for (const name of Object.keys(headers)) {
    out += `&h=${encodeURIComponent(`${name}:${headers[name]}`)}`;
  }
  return out;
}
