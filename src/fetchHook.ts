// fetch() interception.
//
// The page asked for a local proxy URL, we ask the CDN behind it, and the body
// comes back untouched — with one exception: a playlist, whose references are
// rewritten back into the local proxy format, exactly as the local server would
// have done (see response.rewritePlaylistIfNeeded and the note there). Anything
// else is passed straight through, nothing is buffered unless the manager cannot
// stream, and nothing is logged about the upstream beyond its host.

import { ALLOWED_METHODS, type AllowedMethod } from './config';
import { P } from './env';
import { applyHeaders, type HeaderMap } from './headers';
import { log } from './log';
import { parseForInterception, type ParsedProxyUrl } from './proxyUrl';
import { createPageResponse, hasNullBody, rewritePlaylistIfNeeded } from './response';
import { capabilities } from './capabilities';
import { createAbortError, gmRequest, isAbortError } from './transport';

const PATCH_MARK = '__stremioLocalProxyFetch';

type FetchFn = typeof fetch;

function normalizeMethod(value: unknown): AllowedMethod | null {
  const upper = typeof value === 'string' && value.length > 0 ? value.toUpperCase() : 'GET';
  return (ALLOWED_METHODS as readonly string[]).includes(upper) ? (upper as AllowedMethod) : null;
}

function extractUrl(input: unknown): string | null {
  if (typeof input === 'string') return input;
  const RequestCtor = P()?.Request;
  if (RequestCtor && input instanceof RequestCtor) return (input as Request).url;
  if (input && typeof input === 'object' && typeof (input as Request).url === 'string') {
    return (input as Request).url;
  }
  return null;
}

function requestSignal(input: unknown, init: RequestInit | undefined): AbortSignal | null {
  if (init && init.signal) return init.signal as AbortSignal;
  const RequestCtor = P()?.Request;
  if (RequestCtor && input instanceof RequestCtor) return (input as Request).signal;
  return null;
}

/** Only the headers a page may lend us: never credentials, never framing. */
function pageHeaders(init: RequestInit | undefined): HeaderMap {
  const headers: HeaderMap = {};
  const source = init?.headers;
  if (!source) return headers;
  if (Array.isArray(source)) {
    for (const pair of source) {
      if (Array.isArray(pair) && pair.length >= 2) headers[String(pair[0]).toLowerCase()] = String(pair[1]);
    }
  } else if (typeof (source as Headers).forEach === 'function') {
    (source as Headers).forEach((value, name) => {
      headers[String(name).toLowerCase()] = String(value);
    });
  } else {
    for (const name of Object.keys(source as Record<string, string>)) {
      headers[name.toLowerCase()] = String((source as Record<string, string>)[name]);
    }
  }
  return headers;
}

/** A failed local request looks exactly like a failed network request. */
function failedFetch(): Response {
  throw new TypeError('Failed to fetch');
}

async function handleIntercepted(
  parsed: ParsedProxyUrl,
  method: AllowedMethod,
  init: RequestInit | undefined,
  input: unknown,
): Promise<Response> {
  // Page headers first, proxy URL headers last: h= wins, as decided in the plan.
  const headers: HeaderMap = {};
  applyHeaders(headers, pageHeaders(init), 'page');
  applyHeaders(headers, parsed.headers, 'proxy');
  parsed.headers = headers;

  const signal = requestSignal(input, init);
  const ResponseCtor = P()?.Response;
  if (typeof ResponseCtor !== 'function') return failedFetch();

  const wantsStream = method === 'GET';
  let response;
  try {
    // A playlist is rewritten here, before anything reads a byte of it, so both
    // the streamed and the buffered path below hand the page a body whose
    // references come back through this script.
    response = rewritePlaylistIfNeeded(
      await gmRequest({ parsed, signal, preferStream: wantsStream }),
      parsed,
    );
  } catch (error) {
    log('fetchHook: request failed', error);
    return failedFetch();
  }

  const ResponseCtorTyped = ResponseCtor as typeof Response;
  if (hasNullBody(response.status, method) || !wantsStream || !response.streamed) {
    return createPageResponse(response, method);
  }

  const StreamCtor = P()?.ReadableStream;
  const source = response.body as ReadableStream;
  if (typeof StreamCtor !== 'function' || typeof source?.getReader !== 'function') {
    return createPageResponse(response, method);
  }

  const reader = source.getReader();
  let aborted = false;

  const stream = new StreamCtor({
    async pull(controller: ReadableStreamDefaultController<Uint8Array>) {
      try {
        for (;;) {
          const result = await reader.read();
          if (aborted) {
            controller.error(createAbortError());
            return;
          }
          if (result.done) {
            controller.close();
            return;
          }
          const chunk = result.value;
          if (chunk && chunk.byteLength > 0) controller.enqueue(chunk);
        }
      } catch (error) {
        if (isAbortError(error) || aborted) {
          controller.error(createAbortError());
          return;
        }
        log('fetchHook: body stream failed', error);
        controller.error(new TypeError('Failed to fetch'));
      }
    },
    cancel() {
      aborted = true;
      void reader.cancel().catch(() => undefined);
    },
  });

  if (signal) {
    const onAbort = (): void => {
      aborted = true;
      void reader.cancel().catch(() => undefined);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return new ResponseCtorTyped(stream as unknown as BodyInit, {
    status: response.status,
    statusText: response.statusText || '',
    headers: response.headers,
  });
}

export function installFetchHook(): boolean {
  if (!capabilities().fetchHook) return false;
  const page = P();
  const original = page?.fetch;
  if (typeof original !== 'function' || (original as unknown as Record<string, unknown>)[PATCH_MARK]) {
    return false;
  }

  const patched = function fetch(this: unknown, input: unknown, init?: RequestInit): Promise<Response> {
    let url: string | null = null;
    let method: AllowedMethod | null = null;
    try {
      url = extractUrl(input);
      method = normalizeMethod(init?.method ?? (input as Request | null)?.method ?? 'GET');
    } catch {
      url = null;
    }
    if (!url || !method) {
      return original.call(this, input as RequestInfo, init);
    }
    // One gate: right origin and path, the server's format, a target we may
    // fetch. Anything else — /version, /hlsv2/*, a bare /proxy/ — is the page's
    // own request and gets the page's own answer, not a synthesised failure.
    const parsed = parseForInterception(url, { method });
    if (!parsed) {
      return original.call(this, input as RequestInfo, init);
    }
    return handleIntercepted(parsed, method, init, input).catch((error) => {
      log('fetchHook: unexpected failure', error);
      return failedFetch();
    });
  } as FetchFn;

  (patched as unknown as Record<string, unknown>)[PATCH_MARK] = true;

  try {
    page.fetch = patched;
  } catch (error) {
    log('fetchHook: cannot patch page fetch, leaving it alone', error);
    try {
      page.fetch = original;
    } catch {
      /* nothing else we can do */
    }
    return false;
  }

  log('fetchHook: installed');
  return true;
}
