// The request layer. Everything the script sends to a remote host goes through
// here, and the only host it ever talks to is the one behind the local proxy URL
// that the page handed us (the upstream inside `d=` is the local server's
// business, it enforces the SSRF policy server side).
//
// Responsibilities:
//   * never carry ambient credentials (anonymous, no cookies, no origin/referer)
//   * own timeouts, because GM_xmlhttpRequest's `timeout` is not honoured for
//     streamed responses in Chromium
//   * bounded retries with exponential backoff
//   * full abortability: AbortSignal, per-session destroy, pagehide
//   * stream when the manager supports it, whole body otherwise

import {
  DEFAULT_RETRIES,
  FIRST_BYTE_TIMEOUT_MS,
  MAX_CONCURRENT_REQUESTS,
  MAX_RETRY_DELAY_MS,
  RETRY_BASE_DELAY_MS,
  RETRYABLE_STATUS_CODES,
  STALL_TIMEOUT_MS,
} from './config';
import { env, hasGm, P } from './env';
import { noteLocalReachable, noteLocalUnreachable, resetLocalServiceState } from './localService';
import {
  applyHeaders,
  filterResponseHeaders,
  headerValue,
  parseRawHeaders,
  suppressManagerSecDefaults,
  type HeaderMap,
} from './headers';
import { log, logOnce } from './log';
import type { GmHandle, GmRequestDetails } from './env';
import type { ParsedProxyUrl } from './proxyUrl';
import { classifyTarget } from './ssrf';

export class TransportError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'TransportError';
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function createAbortError(): Error {
  const DomException = P()?.DOMException;
  if (typeof DomException === 'function') {
    try {
      return new DomException('The operation was aborted', 'AbortError');
    } catch {
      /* fall through */
    }
  }
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError';
}

export interface TransportResponse {
  status: number;
  statusText: string;
  headers: HeaderMap;
  /** The URL the response actually came from (may differ after a redirect). */
  finalUrl: string;
  /** A page-realm ReadableStream when streamed, otherwise the whole body. */
  body: ReadableStream | ArrayBuffer | null;
  streamed: boolean;
}

export interface TransportOptions {
  parsed: ParsedProxyUrl;
  signal?: AbortSignal | null;
  retries?: number;
  /** Stream the body when the manager allows it. */
  preferStream?: boolean;
  firstByteTimeoutMs?: number;
  stallTimeoutMs?: number;
  /** Aborted together with the request (session destroy, pagehide). */
  onActive?: (abort: () => void) => void;
}

type AttemptOutcome =
  | { kind: 'ok'; response: TransportResponse }
  | { kind: 'no-stream-support' }
  | { kind: 'error'; error: TransportError };

// --- global state ----------------------------------------------------------

/** null = not probed yet, true/false once we know. */
let streamsSupported: boolean | null = null;
const active = new Set<{ abort: () => void }>();
let queued = 0;
let running = 0;
const waiters: Array<() => void> = [];

export function activeRequestCount(): number {
  return active.size;
}

export function setStreamsSupported(value: boolean | null): void {
  streamsSupported = value;
}

export function getStreamsSupported(): boolean | null {
  return streamsSupported;
}

export function resetTransportState(): void {
  streamsSupported = null;
  active.clear();
  queued = 0;
  running = 0;
  waiters.length = 0;
  resetLocalServiceState();
}

async function acquireSlot(): Promise<void> {
  if (running < MAX_CONCURRENT_REQUESTS) {
    running += 1;
    queued -= 1;
    return;
  }
  queued += 1;
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function releaseSlot(): void {
  running = Math.max(0, running - 1);
  const next = waiters.shift();
  if (next) next();
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(createAbortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function backoffDelay(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS);
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function isReadableStream(value: unknown): value is ReadableStream {
  if (!value || typeof value !== 'object') return false;
  const stream = value as ReadableStream;
  return typeof stream.getReader === 'function';
}

function toBytes(chunk: unknown): Uint8Array | null {
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return null;
}

function parseRetryAfter(headers: HeaderMap): number | null {
  const value = headerValue(headers, 'retry-after');
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  return null;
}

// --- single attempt --------------------------------------------------------

function attempt(options: TransportOptions, useStream: boolean): Promise<AttemptOutcome> {
  const { parsed, signal } = options;
  const firstByteMs = options.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
  const stallMs = options.stallTimeoutMs ?? STALL_TIMEOUT_MS;

  return new Promise<AttemptOutcome>((resolve) => {
    if (!hasGm()) {
      resolve({ kind: 'error', error: new TransportError('GM_xmlhttpRequest is unavailable') });
      return;
    }
    if (signal?.aborted) {
      resolve({ kind: 'error', error: new TransportError('aborted', { cause: createAbortError() }) });
      return;
    }

  // The headers are filtered again here, not trusted from the caller. `h=` values
  // are cleaned when the URL is parsed, but a ParsedProxyUrl can also be built by
  // hand, and a hop-by-hop header reaching GM_xmlhttpRequest is either rejected
  // by the manager or leaked upstream. Same reasoning as the target check above:
  // this is the last place before the manager is called.
  const headers: HeaderMap = {};
  applyHeaders(headers, parsed.headers, 'proxy');
  // And the manager's own client hints are told to stay out of the way, so it
  // cannot add a sec-* header of its own on top of what we decided to send.
  suppressManagerSecDefaults(headers);
  let settled = false;
  // Set as soon as the service answers, so a later break in the response body is
  // recognised as the upstream's and not as a service that is not there.
  let responded = false;
    let handle: GmHandle | null = null;
    let firstByteTimer: ReturnType<typeof setTimeout> | null = null;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let streamMode = useStream;

    const entry = {
      abort: () => {
        try {
          handle?.abort();
        } catch {
          /* already gone */
        }
      },
    };
    active.add(entry);
    options.onActive?.(() => entry.abort());

    function cleanup(): void {
      if (firstByteTimer !== null) clearTimeout(firstByteTimer);
      if (stallTimer !== null) clearTimeout(stallTimer);
      firstByteTimer = null;
      stallTimer = null;
      signal?.removeEventListener('abort', onAbort);
      active.delete(entry);
    }

    function settle(outcome: AttemptOutcome, keepAlive = false): void {
      if (settled) return;
      settled = true;
      // In stream mode the socket stays open after the promise resolves, so the
      // abort wiring and the stall timer live until the stream ends.
      if (!keepAlive) cleanup();
      resolve(outcome);
    }

    function abortWith(error: TransportError): void {
      if (settled) return;
      settle({ kind: 'error', error });
    }

    function onAbort(): void {
      abortWith(new TransportError('aborted', { cause: createAbortError() }));
      entry.abort();
    }

    function armStall(): void {
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        // Settle first: a manager that calls onabort synchronously from abort()
        // would otherwise decide the reason for the failure.
        abortWith(new TransportError(`stalled after ${stallMs}ms`, { retryable: true }));
        entry.abort();
      }, stallMs);
    }

    function failTransport(detail: string, retryable: boolean): void {
      abortWith(new TransportError(detail, { retryable }));
    }

    function failHttp(status: number, responseHeaders: HeaderMap): void {
      const retryable = RETRYABLE_STATUS_CODES.includes(status);
      const error = new TransportError(`upstream responded ${status}`, { status, retryable });
      (error as { retryAfterMs?: number | null }).retryAfterMs = parseRetryAfter(responseHeaders);
      abortWith(error);
    }

    function collectArrayBuffer(response: unknown, status: number, responseHeaders: HeaderMap, finalUrl: string): void {
      const buffer =
        response instanceof ArrayBuffer
          ? response
          : ArrayBuffer.isView(response)
            ? (toBytes(response)?.buffer as ArrayBuffer | undefined)
            : null;
      if (!buffer && status === 200 && !useStream) {
        // Some managers only expose a string for empty bodies (HEAD).
        const text = (response as { responseText?: string } | null)?.responseText;
        if (typeof text === 'string' && text.length === 0) {
          settle({
            kind: 'ok',
            response: {
              status,
              statusText: 'OK',
              headers: filterResponseHeaders(responseHeaders),
              finalUrl,
              body: new ArrayBuffer(0),
              streamed: false,
            },
          });
          return;
        }
      }
      settle({
        kind: 'ok',
        response: {
          status,
          statusText: 'OK',
          headers: filterResponseHeaders(responseHeaders),
          finalUrl,
          body: buffer ?? new ArrayBuffer(0),
          streamed: false,
        },
      });
    }

    /**
     * Hands the live stream to the caller instead of buffering it. The stall
     * timer is armed per pull, so a consumer that pauses reading is never
     * mistaken for a dead connection.
     */
    function exposeStream(stream: ReadableStream, finalUrl: string, status: number, responseHeaders: HeaderMap): void {
      const reader = stream.getReader();
      const StreamCtor = (globalThis as { ReadableStream?: typeof ReadableStream }).ReadableStream;
      if (typeof StreamCtor !== 'function') {
        void reader.cancel().catch(() => undefined);
        settle({
          kind: 'ok',
          response: {
            status,
            statusText: 'OK',
            headers: filterResponseHeaders(responseHeaders),
            finalUrl,
            body: null,
            streamed: false,
          },
        });
        return;
      }

      const close = (): void => {
        if (stallTimer !== null) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
        active.delete(entry);
        signal?.removeEventListener('abort', onAbort);
      };

      const wrapped = new StreamCtor({
        async pull(controller) {
          armStall();
          let result: ReadableStreamReadResult<unknown>;
          try {
            result = await reader.read();
          } catch (error) {
            close();
            controller.error(error);
            return;
          }
          if (stallTimer !== null) {
            clearTimeout(stallTimer);
            stallTimer = null;
          }
          if (result.done) {
            close();
            controller.close();
            return;
          }
          const bytes = toBytes(result.value);
          if (bytes) controller.enqueue(bytes);
          else controller.enqueue(new Uint8Array(0));
        },
        cancel(reason) {
          close();
          return reader.cancel(reason).catch(() => undefined);
        },
      });

      settle(
        {
          kind: 'ok',
          response: {
            status,
            statusText: 'OK',
            headers: filterResponseHeaders(responseHeaders),
            finalUrl,
            body: wrapped,
            streamed: true,
          },
        },
        true,
      );
    }

    const details: GmRequestDetails = {
      method: parsed.method,
      url: parsed.upstreamUrl,
      headers,
      // Ambient credentials must never reach the upstream: no cookies, no
      // origin/referer, no cookie partitioning.
      anonymous: true,
      redirect: 'follow',
      responseType: streamMode ? 'stream' : 'arraybuffer',
      context: null,

      onloadstart: (start) => {
        // Reaching this point at all means the local service is up and talking,
        // whatever status it has to say: a 404 from it is proof of life.
        responded = true;
        noteLocalReachable();
        if (firstByteTimer !== null) clearTimeout(firstByteTimer);
        firstByteTimer = null;
        const responseHeaders = parseRawHeaders(start?.responseHeaders);
        const status = typeof start?.status === 'number' ? start.status : 200;
        const finalUrl = start?.finalUrl ?? start?.responseURL ?? parsed.upstreamUrl;
        if (signal?.aborted) {
          entry.abort();
          abortWith(new TransportError('aborted', { cause: createAbortError() }));
          return;
        }
        if (status >= 300) {
          failHttp(status, responseHeaders);
          return;
        }
        if (streamMode) {
          if (!isReadableStream(start?.response)) {
            // The manager accepted the option but handed us no stream.
            settle({ kind: 'no-stream-support' });
            return;
          }
          exposeStream(start.response, finalUrl, status, responseHeaders);
          return;
        }
        // arraybuffer mode: the body arrives in onload, keep the stall timer on.
        armStall();
      },

      onprogress: (progress) => {
        if (streamMode) return;
        if (progress && typeof progress.loaded === 'number') armStall();
      },

      onload: (response) => {
        if (firstByteTimer !== null) clearTimeout(firstByteTimer);
        firstByteTimer = null;
        const responseHeaders = parseRawHeaders(response?.responseHeaders);
        const status = typeof response?.status === 'number' ? response.status : 200;
        const finalUrl = response?.finalUrl ?? response?.responseURL ?? parsed.upstreamUrl;
        if (status >= 300) {
          failHttp(status, responseHeaders);
          return;
        }
        collectArrayBuffer(response?.response, status, responseHeaders, finalUrl);
      },

      onerror: (error) => {
        if (!responded) {
          // Nothing came back at all, so this is the local service not being
          // there. The hop we would retry is the hop that just failed, and a
          // refusal does not turn into an answer on the second try.
          noteLocalUnreachable();
          failTransport(`local service unreachable: ${describe(error)}`, false);
          return;
        }
        // The response started and then broke, which is the upstream's business
        // and the caller's: hls.js has a fragment retry policy for that.
        failTransport(`network error: ${describe(error)}`, true);
      },

      ontimeout: () => {
        failTransport('GM request timed out', true);
      },

      onabort: () => {
        abortWith(new TransportError('aborted', { cause: createAbortError() }));
      },
    };

    firstByteTimer = setTimeout(() => {
      abortWith(new TransportError(`no first byte after ${firstByteMs}ms`, { retryable: true }));
      entry.abort();
    }, firstByteMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      handle = env.gmRequest?.(details) ?? null;
    } catch (error) {
      failTransport(`GM_xmlhttpRequest threw: ${describe(error)}`, true);
    }
  });
}

function describe(error: unknown): string {
  if (!error) return 'unknown';
  if (typeof error === 'string') return error;
  const candidate = error as { error?: string; message?: string; status?: number; statusText?: string };
  if (candidate.error) return String(candidate.error);
  if (candidate.message) return String(candidate.message);
  if (candidate.status) return `${candidate.status} ${candidate.statusText ?? ''}`.trim();
  return 'unknown';
}

// --- public entry point ----------------------------------------------------

export async function gmRequest(options: TransportOptions): Promise<TransportResponse> {
  // Last line of the SSRF guard. `d=` is parsed with the same rule, but this is
  // the only place a request is handed to the manager, so it is the one that has
  // to hold even if a new caller forgets.
  const target = classifyTarget(options.parsed.upstreamUrl);
  if (target.verdict !== 'public') {
    throw new TransportError(`refusing an internal target: ${target.reason}`);
  }
  const signal = options.signal ?? null;
  const retries = options.retries ?? DEFAULT_RETRIES;
  // Streams are asked for while the answer is still unknown, and only when we
  // already know the manager cannot do it. Asking costs one extra round trip, so
  // the first request of a page load may pay it once: attempt() reports
  // no-stream-support, this function remembers false, and no later request asks
  // again. That is why nothing here probes the manager on its own — the page's
  // first real request is the probe, and it is a request the script was going to
  // make anyway.
  let useStream =
    options.preferStream !== false && streamsSupported !== false && options.parsed.method === 'GET';
  let downgraded = false;

  await acquireSlot();
  try {
    for (let index = 0; ; index += 1) {
      const outcome = await attempt(options, useStream);
      if (outcome.kind === 'ok') {
        if (useStream) streamsSupported = true;
        return outcome.response;
      }
      if (outcome.kind === 'no-stream-support') {
        if (downgraded) {
          throw new TransportError('manager returned no ReadableStream and no body');
        }
        downgraded = true;
        streamsSupported = false;
        useStream = false;
        logOnce('no-stream', 'transport: manager has no stream support, falling back to arraybuffer');
        index -= 1;
        continue;
      }
      const retryAfterMs = (outcome.error as { retryAfterMs?: number | null }).retryAfterMs ?? null;
      if (outcome.error.retryable && index < retries) {
        log('transport: retrying', outcome.error.message, `attempt ${index + 1}/${retries}`);
        await sleep(backoffDelay(index, retryAfterMs), signal);
        continue;
      }
      throw outcome.error;
    }
  } finally {
    releaseSlot();
  }
}
