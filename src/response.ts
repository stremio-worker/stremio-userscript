// Response construction. Everything handed to the page is built with the page's
// own constructors, so `instanceof Response` and stream consumption keep
// working across the userscript sandbox boundary.
//
// A playlist body is the one response this script rewrites, because it fetched
// the CDN itself instead of letting the local server do it: the body still points
// at the CDN, and the references have to come back through the proxy for hls.js
// to be able to fetch them. The local server does the same to the same bytes
// (service/lib/proxy.js getParserStream), so both sides agree.

import type { AllowedMethod } from './config';
import { P, requirePageCtor } from './env';
import { headerValue, type HeaderMap } from './headers';
import { isPlaylistResponse, rewritePlaylistBytes, rewritePlaylistStream } from './playlist';
import type { ParsedProxyUrl } from './proxyUrl';
import type { TransportResponse } from './transport';

/** Statuses that are not allowed to carry a body. */
const NULL_BODY_STATUSES = [101, 103, 204, 205, 304];

export function hasNullBody(status: number, method: AllowedMethod): boolean {
  return method === 'HEAD' || NULL_BODY_STATUSES.includes(status);
}

/**
 * Headers for a body this script rewrote: the upstream length and encoding no
 * longer describe it, and a playlist is not seekable. The server clears the
 * same three (service/lib/proxy.js, the isPlaylist branch).
 */
function headersForRewrittenBody(headers: HeaderMap): HeaderMap {
  const out: HeaderMap = { ...headers };
  delete out['content-length'];
  delete out['content-encoding'];
  delete out['accept-ranges'];
  out['accept-ranges'] = 'none';
  return out;
}

/**
 * A playlist body with every reference rewritten into the local proxy format,
 * and its headers corrected to match. Anything else is returned untouched.
 */
export function rewritePlaylistIfNeeded(
  transport: TransportResponse,
  parsed: ParsedProxyUrl,
): TransportResponse {
  if (hasNullBody(transport.status, parsed.method)) return transport;
  const body = transport.body;
  if (body === null || body === undefined) return transport;

  const contentType = headerValue(transport.headers, 'content-type');
  // The upstream URL, not the local one: a relative reference in a playlist
  // resolves against the playlist's own location.
  const base = transport.finalUrl || parsed.upstreamUrl;
  if (!isPlaylistResponse(contentType, base)) return transport;

  const headers = headersForRewrittenBody(transport.headers);
  try {
    if (transport.streamed && typeof (body as ReadableStream).getReader === 'function') {
      return {
        ...transport,
        headers,
        body: rewritePlaylistStream(body as ReadableStream<Uint8Array>, base, parsed.headers),
      };
    }
    // Not streamed, so the body is the whole thing as an ArrayBuffer.
    const buffer = body as ArrayBuffer;
    return { ...transport, headers, body: rewritePlaylistBytes(buffer, base, parsed.headers) };
  } catch {
    // If the rewrite cannot be set up, the original body is still the CDN's and
    // still worth handing over: the page decides what to do with it.
    return transport;
  }
}

export function createPageResponse(transport: TransportResponse, method: AllowedMethod): Response {
  const ResponseCtor = requirePageCtor('Response');
  const init: ResponseInit = {
    status: transport.status,
    statusText: transport.statusText || '',
    headers: transport.headers,
  };
  if (hasNullBody(transport.status, method)) {
    return new ResponseCtor(null, init) as Response;
  }
  const body = transport.body;
  if (body === null || body === undefined) return new ResponseCtor(null, init) as Response;
  return new ResponseCtor(body as BodyInit, init) as Response;
}

export function decodeText(bytes: ArrayBuffer | Uint8Array): string {
  const DecoderCtor = P()?.TextDecoder;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof DecoderCtor === 'function') {
    return new DecoderCtor('utf-8').decode(view);
  }
  let out = '';
  for (const byte of view) out += String.fromCharCode(byte);
  try {
    return decodeURIComponent(escape(out));
  } catch {
    return out;
  }
}
