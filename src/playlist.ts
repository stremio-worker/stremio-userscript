// Playlist rewriting.
//
// The local server rewrites every URI in a playlist body (service/lib/proxy.js
// getParserStream), and this script has to do the same, because it does not let
// the local server fetch anything: it takes the `d=` target out of a proxy URL
// and asks the CDN itself. So the playlist bytes that arrive here are the CDN's
// own, still pointing straight at the CDN, and hls.js would then request every
// segment with the page's own XHR — no `h=` headers, no CORS exemption, no
// cookies, and a 403 from most CDNs.
//
// Rewriting every reference back into the local `/proxy/` format fixes that: the
// references become our own URLs, and the fetch and XHR hooks pick them up on the
// way, apply the SSRF policy and route them through GM with the headers intact.
//
// The rules are the server's, so both sides agree on the output:
//
//   * a line that does not start with `#` is a segment or variant URL;
//   * a line with `URI="..."` is #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA,
//     #EXT-X-I-FRAME-STREAM-INF, #EXT-X-SESSION-KEY and friends;
//   * a line with neither is a tag, and tags are left alone;
//   * relative references resolve against the playlist's own URL, and the result
//     is a relative `/proxy/?d=...` URL, exactly as the server emits, which
//     resolves back to the local origin from wherever hls.js is standing.

import { PLAYLIST_CONTENT_TYPES } from './config';
import type { HeaderMap } from './headers';
import { buildProxyUrl } from './proxyUrl';

/** Path suffixes the server treats as a playlist even without a content type. */
const PLAYLIST_SUFFIXES = ['.m3u8', '.m3u'];

/** `URI="..."`, the one shape every URI bearing tag uses. */
const URI_ATTRIBUTE = /URI="([^"]+)"/;

function hasPlaylistSuffix(url: string): boolean {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* relative base, tested as written */
  }
  const lower = pathname.toLowerCase();
  return PLAYLIST_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function isPlaylistContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return PLAYLIST_CONTENT_TYPES.includes(base);
}

/** The same decision the server makes: a known content type, or the suffix. */
export function isPlaylistResponse(contentType: string | null | undefined, url: string): boolean {
  return isPlaylistContentType(contentType) || hasPlaylistSuffix(url);
}

/**
 * Absolute form of a playlist reference. Anything that is not http(s) — a data:
 * URI, a FairPlay `skd://` key, a blob: — is returned as it was, because wrapping
 * it would name a target the proxy cannot fetch and would break a key that the
 * browser handles itself.
 */
function absolutize(reference: string, base: string): string | null {
  const trimmed = reference.trim();
  if (trimmed === '') return null;
  // A reference the page already made absolute needs no resolution, and asking
  // URL for one would only throw on the schemes below.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    if (!/^https?:/i.test(trimmed)) return null;
    try {
      return new URL(trimmed).toString();
    } catch {
      return null;
    }
  }
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

/** Rewrites one line, or returns it untouched when there is nothing to rewrite. */
export function rewritePlaylistLine(line: string, base: string, headers: HeaderMap): string {
  if (line === '') return line;

  if (!line.startsWith('#')) {
    const target = absolutize(line, base);
    return target === null ? line : buildProxyUrl(target, headers);
  }

  const match = URI_ATTRIBUTE.exec(line);
  if (!match || match.index === undefined) return line;
  const reference = match[1] ?? '';
  const target = absolutize(reference, base);
  if (target === null) return line;
  // Splice at the match, not with a plain replace, so a tag that repeats the URI
  // earlier in the line cannot be rewritten by accident.
  const start = match.index + 'URI="'.length;
  return line.slice(0, start) + buildProxyUrl(target, headers) + line.slice(start + reference.length);
}

interface LineBatch {
  /** Complete lines with the terminator each one had, so the output is byte stable. */
  complete: string[];
  /** Trailing text after the last terminator, if the chunk ended mid line. */
  rest: string;
}

function takeLines(text: string): LineBatch {
  const complete: string[] = [];
  let index = 0;
  while (index < text.length) {
    let stop = text.length;
    for (let i = index; i < text.length; i += 1) {
      const char = text[i];
      if (char === '\n' || char === '\r') {
        stop = i;
        break;
      }
    }
    if (stop === text.length) break;
    const terminator =
      text[stop] === '\r' && text[stop + 1] === '\n' ? '\r\n' : (text[stop] as string);
    complete.push(text.slice(index, stop + terminator.length));
    index = stop + terminator.length;
  }
  return { complete, rest: text.slice(index) };
}

function rewriteLines(lines: string[], base: string, headers: HeaderMap): string {
  let out = '';
  for (const raw of lines) {
    const terminator = /(\r\n|\n|\r)$/.exec(raw)?.[1] ?? '';
    out += rewritePlaylistLine(raw.slice(0, raw.length - terminator.length), base, headers) + terminator;
  }
  return out;
}

/** A whole document, which is the buffered case: nothing is carried over. */
function rewriteText(text: string, base: string, headers: HeaderMap): string {
  const { complete, rest } = takeLines(text);
  return rewriteLines(complete, base, headers) + rewritePlaylistLine(rest, base, headers);
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * The playlist as a stream, with every reference rewritten. Errors pass through
 * untouched: a half rewritten playlist is still better than a hang, and hls.js
 * reports the failure either way.
 */
export function rewritePlaylistStream(
  source: ReadableStream<Uint8Array>,
  base: string,
  headers: HeaderMap,
): ReadableStream<Uint8Array> {
  const StreamCtor = (globalThis as { ReadableStream?: typeof ReadableStream }).ReadableStream;
  if (typeof StreamCtor !== 'function') return source;

  const reader = source.getReader();
  // A chunk boundary can fall inside a multi byte character, so the decoder has
  // to be told that more is coming. The server decodes per chunk and gets this
  // wrong for a split character.
  const decoder = new TextDecoder('utf-8');
  // And it can fall in the middle of a line, so a line is only rewritten once
  // its terminator has arrived. Rewriting the tail on every chunk would rewrite
  // it again and again, and a half rewritten line is a broken one.
  let partial = '';

  return new StreamCtor({
    async pull(controller) {
      // Keep reading until there is something to hand over. A chunk that holds
      // no complete line produces no output, and a pull that enqueues nothing
      // never gets called again, so the reader would wait forever.
      for (;;) {
        const result = await reader.read();
        if (result.done) {
          const tail = decoder.decode() + partial;
          if (tail !== '') controller.enqueue(encode(rewritePlaylistLine(tail, base, headers)));
          controller.close();
          return;
        }
        const { complete, rest } = takeLines(partial + decoder.decode(result.value, { stream: true }));
        partial = rest;
        const out = rewriteLines(complete, base, headers);
        if (out !== '') {
          controller.enqueue(encode(out));
          return;
        }
      }
    },
    cancel(reason: unknown) {
      return reader.cancel(reason);
    },
  });
}

/** The buffered form of the same rewrite, for a manager without stream support. */
export function rewritePlaylistBytes(
  body: ArrayBuffer,
  base: string,
  headers: HeaderMap,
): ArrayBuffer {
  const text = new TextDecoder('utf-8').decode(new Uint8Array(body));
  const rewritten = encode(rewriteText(text, base, headers));
  return rewritten.buffer.slice(
    rewritten.byteOffset,
    rewritten.byteOffset + rewritten.byteLength,
  ) as ArrayBuffer;
}
