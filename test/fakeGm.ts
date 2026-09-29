// A scriptable GM_xmlhttpRequest. Every request is recorded and the response is
// produced by a per-test handler, so the transport can be driven through its
// streaming, retry, timeout and abort paths without a network.

import type { GmHandle, GmRequestDetails, GmResponse } from '../src/env';

export interface GmCall {
  details: GmRequestDetails;
  aborted: boolean;
}

export type GmResponder = (call: GmCall, details: GmRequestDetails) => void;

export interface FakeGm {
  fn: (details: GmRequestDetails) => GmHandle;
  calls: GmCall[];
  callsTo(pattern: RegExp): GmCall[];
  setResponder(responder: GmResponder): void;
  reset(): void;
}

export interface ResponderOptions {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  /** Hand out a ReadableStream, as a manager with stream support would. */
  stream?: boolean;
  streamChunks?: string[];
  /** Leave the stream open, so only a cancel or abort ends it. */
  keepOpen?: boolean;
  /** Fail at the transport level instead of answering. */
  error?: string;
  /** Never answer: only timeouts and aborts can end the request. */
  hang?: boolean;
  /** Fire onloadstart and then stay silent. */
  startOnly?: boolean;
  /** Answer, then break: onloadstart followed by a transport level error. */
  breakAfterStart?: string;
  /** Answer every request with a different status, in order. */
  sequence?: ResponderOptions[];
}

export function serializeHeaders(headers: Record<string, string> = {}): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n');
}

function toArrayBuffer(body: string | ArrayBuffer | undefined): ArrayBuffer {
  if (!body) return new ArrayBuffer(0);
  if (body instanceof ArrayBuffer) return body;
  return new TextEncoder().encode(body).buffer as ArrayBuffer;
}

export function makeStream(chunks: string[], keepOpen = false): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      if (!keepOpen) controller.close();
    },
  });
}

export function respond(options: ResponderOptions = {}): GmResponder {
  let used = 0;
  return (_call, details) => {
    const sequence = options.sequence;
    const active: ResponderOptions =
      sequence && sequence.length > 0 ? (sequence[Math.min(used, sequence.length - 1)] ?? options) : options;
    used += 1;

    if (active.hang) return;
    if (active.error) {
      details.onerror?.({ error: active.error });
      return;
    }

    const status = active.status ?? 200;
    const raw = serializeHeaders(active.headers ?? {});
    const statusText = active.statusText ?? 'OK';

    if (active.breakAfterStart !== undefined) {
      // The response starts and the connection then gives out, which is what an
      // upstream that dies mid body looks like to a manager.
      details.onloadstart?.({
        status,
        statusText,
        responseHeaders: raw,
        finalUrl: details.url,
        response: undefined,
      });
      details.onerror?.({ error: active.breakAfterStart });
      return;
    }

    if (active.startOnly) {
      const response = active.stream ? makeStream(active.streamChunks ?? [], active.keepOpen) : undefined;
      details.onloadstart?.({
        status,
        statusText,
        responseHeaders: raw,
        finalUrl: details.url,
        response,
      });
      return;
    }

    if (active.stream) {
      const stream = makeStream(active.streamChunks ?? [], active.keepOpen);
      details.onloadstart?.({
        status,
        statusText,
        responseHeaders: raw,
        finalUrl: details.url,
        response: stream,
      });
      return;
    }

    const response: GmResponse = {
      status,
      statusText,
      responseHeaders: raw,
      responseURL: details.url,
      finalUrl: details.url,
      response: toArrayBuffer(active.body),
    };
    details.onloadstart?.({
      status,
      statusText,
      responseHeaders: raw,
      finalUrl: details.url,
      response: response.response,
    });
    details.onload?.(response);
  };
}

export function createFakeGm(responder: GmResponder = respond()): FakeGm {
  let current = responder;
  const calls: GmCall[] = [];

  const fn = (details: GmRequestDetails): GmHandle => {
    const call: GmCall = { details, aborted: false };
    calls.push(call);
    current(call, details);
    return {
      abort(): void {
        call.aborted = true;
        details.onabort?.({ error: 'aborted' });
      },
    };
  };

  return {
    fn,
    calls,
    callsTo(pattern: RegExp): GmCall[] {
      return calls.filter((call) => pattern.test(call.details.url));
    },
    setResponder(next: GmResponder): void {
      current = next;
    },
    reset(): void {
      calls.length = 0;
    },
  };
}
