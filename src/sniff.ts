// Pre-flight: decide whether the local proxy URL points at an HLS playlist
// before the video element is touched at all. When it does not (a plain .mp4
// upstream, a 4xx, a server that is not up) the page keeps its own load and
// never learns this script exists.

import { PLAYLIST_MAGIC, SNIFF_BYTES } from './config';
import { headerValue, type HeaderMap } from './headers';
import { log } from './log';
import { parseProxyUrl, type ParsedProxyUrl } from './proxyUrl';
import { decodeText } from './response';
import { isPlaylistContentType } from './playlist';
import { gmRequest, getStreamsSupported, TransportError } from './transport';
import type { TransportResponse } from './transport';

export type MediaKind = 'playlist' | 'other' | 'unknown';

export interface SniffResult {
  kind: MediaKind;
  status: number;
  contentType: string | null;
  bytes: number;
}

/** Without a content-length we only read a prefix when we can stop early. */
const MAX_SNIFF_WITHOUT_LENGTH = 4 * 1024 * 1024;
const SNIFF_TIMEOUT_MS = 8_000;

function looksLikePlaylist(text: string): boolean {
  // Tolerate a BOM and leading whitespace before the tag.
  const head = text.replace(/^﻿/, '').trimStart();
  return head.startsWith(PLAYLIST_MAGIC);
}

async function readPrefix(response: TransportResponse, limit: number): Promise<string> {
  const body = response.body;
  if (!body) return '';
  if (response.streamed && typeof (body as ReadableStream).getReader === 'function') {
    const reader = (body as ReadableStream).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        const value = result.value;
        if (value && value.byteLength > 0) {
          chunks.push(value);
          total += value.byteLength;
        }
        if (total >= limit) break;
      }
    } catch {
      /* partial data is enough to sniff */
    } finally {
      await reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
    return decodeText(concat(chunks, total));
  }
  if (body instanceof ArrayBuffer) {
    const view = new Uint8Array(body, 0, Math.min(limit, body.byteLength));
    return decodeText(view);
  }
  return '';
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function sniffBody(parsed: ParsedProxyUrl, headers: HeaderMap, signal: AbortSignal | null): Promise<MediaKind> {
  const ranged: ParsedProxyUrl = {
    ...parsed,
    headers: { ...headers, range: `bytes=0-${SNIFF_BYTES - 1}` },
  };
  try {
    const response = await gmRequest({
      parsed: ranged,
      signal,
      retries: 0,
      preferStream: getStreamsSupported() !== false,
      firstByteTimeoutMs: SNIFF_TIMEOUT_MS,
      stallTimeoutMs: SNIFF_TIMEOUT_MS,
    });
    if (response.status >= 300) return 'other';
    const text = await readPrefix(response, SNIFF_BYTES);
    return looksLikePlaylist(text) ? 'playlist' : 'other';
  } catch (error) {
    log('sniff: body probe failed', error);
    return 'unknown';
  }
}

export async function sniffMedia(
  parsed: ParsedProxyUrl,
  signal: AbortSignal | null = null,
): Promise<SniffResult> {
  let head: TransportResponse;
  try {
    head = await gmRequest({
      parsed: { ...parsed, method: 'HEAD' },
      signal,
      retries: 1,
      preferStream: false,
      firstByteTimeoutMs: SNIFF_TIMEOUT_MS,
      stallTimeoutMs: SNIFF_TIMEOUT_MS,
    });
  } catch (error) {
    // An HTTP error status is an answer, not a transport failure: the page's own
    // request would fail the same way, so the element is left alone.
    if (error instanceof TransportError && error.status >= 300) {
      return { kind: 'other', status: error.status, contentType: null, bytes: 0 };
    }
    log('sniff: HEAD failed, leaving the page alone', error);
    return { kind: 'unknown', status: 0, contentType: null, bytes: 0 };
  }

  const contentType = headerValue(head.headers, 'content-type');
  if (head.status >= 300) {
    // The page's own request would fail exactly the same way.
    return { kind: 'other', status: head.status, contentType, bytes: 0 };
  }
  if (isPlaylistContentType(contentType)) {
    return { kind: 'playlist', status: head.status, contentType, bytes: 0 };
  }

  const declared = Number(headerValue(head.headers, 'content-length'));
  const canSniffBody =
    Number.isFinite(declared) && declared > 0
      ? declared <= MAX_SNIFF_WITHOUT_LENGTH
      : getStreamsSupported() !== false;
  if (!canSniffBody) {
    return { kind: 'unknown', status: head.status, contentType, bytes: 0 };
  }

  const kind = await sniffBody(parsed, parsed.headers, signal);
  return { kind, status: head.status, contentType, bytes: SNIFF_BYTES };
}

/** Convenience for the src path: null when the URL is not usable at all. */
export function parseForSniff(url: string): ParsedProxyUrl | null {
  return parseProxyUrl(url, { method: 'GET' });
}
