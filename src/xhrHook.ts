// XMLHttpRequest interception.
//
// stremio-video plays HLS with its own hls.js, whose XhrLoader uses a plain
// XMLHttpRequest (and the page CSP blocks connections to 127.0.0.1). Our own
// hls.js instance does the same, so this hook is the single transport for both.
//
// The real XHR object is kept: `open()` and `setRequestHeader()` are forwarded
// untouched, and only `send()` diverges. While diverging, the read-only members
// the loaders read back (readyState, status, response, ...) are shadowed with
// own properties on the instance, and events are dispatched on the real
// EventTarget so both `on*` handlers and addEventListener listeners fire.
// Releasing those shadows puts the object back to a pristine, never-sent XHR.

import { ALLOWED_METHODS, SUPPORTED_RESPONSE_TYPES } from './config';
import { P } from './env';
import { applyHeaders, filterResponseHeaders, headerValue, serializeHeaders, type HeaderMap } from './headers';
import { log, logOnce } from './log';
import { parseForInterception, type ParsedProxyUrl } from './proxyUrl';
import { decodeText, rewritePlaylistIfNeeded } from './response';
import { capabilities } from './capabilities';
import { gmRequest, isAbortError } from './transport';

const PATCH_MARK = '__stremioLocalProxyXhr';

const READ_ONLY_SHADOWS = ['readyState', 'status', 'statusText', 'response', 'responseText', 'responseURL'] as const;
const METHOD_SHADOWS = ['getAllResponseHeaders', 'getResponseHeader', 'abort'] as const;

interface InterceptState {
  method: string;
  url: string;
  parsed: ParsedProxyUrl | null;
  requestHeaders: HeaderMap;
  simulated: boolean;
}

interface SimState {
  xhr: XMLHttpRequest;
  parsed: ParsedProxyUrl;
  readyState: number;
  status: number;
  statusText: string;
  headers: HeaderMap;
  finalUrl: string;
  body: ArrayBuffer | null;
  total: number;
  loaded: number;
  finished: boolean;
  aborted: boolean;
  abortRequest: (() => void) | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

const states = new WeakMap<object, InterceptState>();
const sims = new WeakMap<object, SimState>();

// --- events ----------------------------------------------------------------

function makeEvent(type: string, extra?: Record<string, unknown>): Event {
  const page = P();
  const Ctor = type === 'progress' ? page?.ProgressEvent : page?.Event;
  let event: any;
  if (typeof Ctor === 'function') {
    try {
      event = new Ctor(type, { bubbles: false, cancelable: false });
    } catch {
      event = null;
    }
  }
  if (!event) {
    const EventCtor = page?.Event;
    event = typeof EventCtor === 'function' ? new EventCtor(type) : { type };
  }
  if (extra) {
    for (const key of Object.keys(extra)) {
      try {
        Object.defineProperty(event, key, { value: extra[key], configurable: true, enumerable: true });
      } catch {
        /* the event object refuses the field, ignore */
      }
    }
  }
  return event as Event;
}

function dispatch(xhr: XMLHttpRequest, type: string, extra?: Record<string, unknown>): void {
  try {
    xhr.dispatchEvent(makeEvent(type, extra));
  } catch (error) {
    logOnce('xhr-event', 'xhrHook: cannot dispatch', type, error);
  }
}

function setReadyState(sim: SimState, value: number): void {
  sim.readyState = value;
}

function clearSimTimer(sim: SimState): void {
  if (sim.timeoutTimer !== null) clearTimeout(sim.timeoutTimer);
  sim.timeoutTimer = null;
}

// --- shadows ---------------------------------------------------------------

function bodyAs(sim: SimState, responseType: string): unknown {
  const bytes = sim.body ?? new ArrayBuffer(0);
  if (responseType === 'arraybuffer') return bytes;
  const text = decodeText(bytes);
  if (responseType === 'json') {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return text;
}

function installShadows(sim: SimState): void {
  const xhr = sim.xhr as unknown as Record<string, unknown>;

  Object.defineProperty(xhr, 'readyState', {
    configurable: true,
    get: () => sim.readyState,
  });
  Object.defineProperty(xhr, 'status', {
    configurable: true,
    get: () => sim.status,
  });
  Object.defineProperty(xhr, 'statusText', {
    configurable: true,
    get: () => sim.statusText,
  });
  Object.defineProperty(xhr, 'responseURL', {
    configurable: true,
    get: () => sim.finalUrl,
  });
  Object.defineProperty(xhr, 'response', {
    configurable: true,
    get(this: XMLHttpRequest) {
      return bodyAs(sim, String((this as { responseType?: string }).responseType ?? ''));
    },
  });
  Object.defineProperty(xhr, 'responseText', {
    configurable: true,
    get(this: XMLHttpRequest) {
      const responseType = String((this as { responseType?: string }).responseType ?? '');
      if (responseType !== '' && responseType !== 'text') {
        throw new TypeError("Failed to read the 'responseText' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text'");
      }
      return decodeText(sim.body ?? new ArrayBuffer(0));
    },
  });
  Object.defineProperty(xhr, 'getAllResponseHeaders', {
    configurable: true,
    writable: true,
    value: () => serializeHeaders(sim.headers),
  });
  Object.defineProperty(xhr, 'getResponseHeader', {
    configurable: true,
    writable: true,
    value: (name: unknown) => headerValue(sim.headers, String(name)),
  });
  Object.defineProperty(xhr, 'abort', {
    configurable: true,
    writable: true,
    value: () => {
      if (sim.finished) return;
      sim.aborted = true;
      try {
        sim.abortRequest?.();
      } catch {
        /* already gone */
      }
      finishAbort(sim);
    },
  });
}

function releaseShadows(xhr: XMLHttpRequest): void {
  const target = xhr as unknown as Record<string, unknown>;
  for (const name of [...READ_ONLY_SHADOWS, ...METHOD_SHADOWS]) {
    try {
      delete target[name];
    } catch {
      /* nothing we can do */
    }
  }
}

function finishAbort(sim: SimState): void {
  if (sim.finished) return;
  sim.finished = true;
  clearSimTimer(sim);
  sim.abortRequest = null;
  setReadyState(sim, 0);
  dispatch(sim.xhr, 'abort');
  dispatch(sim.xhr, 'loadend');
}

function finishError(sim: SimState): void {
  if (sim.finished) return;
  sim.finished = true;
  clearSimTimer(sim);
  sim.abortRequest = null;
  sim.status = 0;
  sim.statusText = '';
  sim.body = null;
  setReadyState(sim, 4);
  dispatch(sim.xhr, 'readystatechange');
  dispatch(sim.xhr, 'error');
  dispatch(sim.xhr, 'loadend');
}

function finishTimeout(sim: SimState): void {
  if (sim.finished) return;
  sim.finished = true;
  clearSimTimer(sim);
  sim.abortRequest = null;
  sim.status = 0;
  sim.statusText = '';
  sim.body = null;
  setReadyState(sim, 4);
  dispatch(sim.xhr, 'readystatechange');
  dispatch(sim.xhr, 'timeout');
  dispatch(sim.xhr, 'loadend');
}

function finishSuccess(sim: SimState): void {
  if (sim.finished) return;
  sim.finished = true;
  clearSimTimer(sim);
  sim.abortRequest = null;

  const declared = Number(headerValue(sim.headers, 'content-length'));
  sim.total = Number.isFinite(declared) && declared >= 0 ? declared : (sim.body?.byteLength ?? 0);

  setReadyState(sim, 2);
  dispatch(sim.xhr, 'readystatechange');

  sim.loaded = sim.body?.byteLength ?? 0;
  setReadyState(sim, 3);
  dispatch(sim.xhr, 'progress', {
    lengthComputable: Number.isFinite(declared) && declared >= 0,
    loaded: sim.loaded,
    total: sim.total,
  });
  dispatch(sim.xhr, 'readystatechange');

  setReadyState(sim, 4);
  dispatch(sim.xhr, 'readystatechange');
  dispatch(sim.xhr, 'load');
  dispatch(sim.xhr, 'loadend');
}

// --- simulation ------------------------------------------------------------

function shouldSimulate(xhr: XMLHttpRequest, state: InterceptState): boolean {
  if (!state.parsed) return false;
  if (!(ALLOWED_METHODS as readonly string[]).includes(state.method)) return false;
  const responseType = String((xhr as { responseType?: string }).responseType ?? '');
  if (!(SUPPORTED_RESPONSE_TYPES as readonly string[]).includes(responseType)) {
    logOnce('xhr-response-type', `xhrHook: not intercepting responseType=${responseType}`);
    return false;
  }
  if ((xhr as { withCredentials?: boolean }).withCredentials === true) {
    logOnce('xhr-credentials', 'xhrHook: not intercepting a credentialed request');
    return false;
  }
  return true;
}

async function simulate(xhr: XMLHttpRequest, parsed: ParsedProxyUrl): Promise<void> {
  const sim: SimState = {
    xhr,
    parsed,
    readyState: 1,
    status: 0,
    statusText: '',
    headers: {},
    finalUrl: parsed.upstreamUrl,
    body: null,
    total: 0,
    loaded: 0,
    finished: false,
    aborted: false,
    abortRequest: null,
    timeoutTimer: null,
  };
  sims.set(xhr, sim);

  try {
    installShadows(sim);
  } catch (error) {
    // Cannot shadow: put the object back to a pristine XHR and let the browser
    // do the request itself.
    log('xhrHook: cannot simulate, falling back to the original send', error);
    releaseShadows(xhr);
    sims.delete(xhr);
    (originalSend as (...a: unknown[]) => void).apply(xhr, [undefined]);
    return;
  }

  const timeoutMs = Number((xhr as { timeout?: number }).timeout ?? 0);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    sim.timeoutTimer = setTimeout(() => {
      try {
        sim.abortRequest?.();
      } catch {
        /* already gone */
      }
      finishTimeout(sim);
    }, timeoutMs);
  }

  try {
    const response = await gmRequest({
      parsed: sim.parsed,
      // hls.js and the page own their own retry policies; a silent retry here
      // would multiply their budgets.
      retries: 0,
      preferStream: false,
      onActive: (abort) => {
        sim.abortRequest = abort;
      },
    });
    if (sim.finished) return;
    // This is the path hls.js itself takes, so it is the one that matters: a
    // playlist has to leave with its references pointing back at the local
    // proxy, or every segment request would go to the CDN from the page.
    const body = rewritePlaylistIfNeeded(response, sim.parsed);
    sim.status = body.status;
    sim.statusText = body.statusText;
    sim.headers = filterResponseHeaders(body.headers);
    sim.finalUrl = body.finalUrl;
    sim.body = body.body instanceof ArrayBuffer ? body.body : new ArrayBuffer(0);
    finishSuccess(sim);
  } catch (error) {
    if (sim.finished) return;
    if (isAbortError(error) || sim.aborted) {
      finishAbort(sim);
      return;
    }
    log('xhrHook: request failed', error);
    finishError(sim);
  } finally {
    sims.delete(xhr);
  }
}

// --- installation ----------------------------------------------------------

let originalOpen: XMLHttpRequest['open'] | null = null;
let originalSend: XMLHttpRequest['send'] | null = null;
let originalSetRequestHeader: XMLHttpRequest['setRequestHeader'] | null = null;
let installed = false;

export function installXhrHook(): boolean {
  if (!capabilities().xhrHook) return false;
  if (installed) return true;

  const page = P();
  const Ctor = page?.XMLHttpRequest;
  const proto = Ctor?.prototype;
  if (!proto) return false;

  originalOpen = proto.open;
  originalSend = proto.send;
  originalSetRequestHeader = proto.setRequestHeader;
  if (!originalOpen || !originalSend || !originalSetRequestHeader) return false;

  const patchedOpen = function open(this: XMLHttpRequest, ...args: unknown[]): void {
    const existing = states.get(this);
    if (existing?.simulated) {
      releaseShadows(this);
      sims.delete(this);
    }
    (originalOpen as (...a: unknown[]) => void).apply(this, args);

    const method = String(args[0] ?? 'GET').toUpperCase();
    const url = String(args[1] ?? '');
    const state: InterceptState = {
      method,
      url,
      parsed: null,
      requestHeaders: {},
      simulated: false,
    };
    try {
      state.parsed = parseForInterception(url, { method });
    } catch (error) {
      state.parsed = null;
      log('xhrHook: cannot parse url', error);
    }
    states.set(this, state);
  };

  const patchedSetRequestHeader = function setRequestHeader(this: XMLHttpRequest, ...args: unknown[]): void {
    const state = states.get(this);
    if (state?.parsed && !state.simulated) {
      const name = String(args[0] ?? '').toLowerCase();
      const value = String(args[1] ?? '');
      applyHeaders(state.requestHeaders, { [name]: value }, 'page');
    }
    (originalSetRequestHeader as (...a: unknown[]) => void).apply(this, args);
  };

  const patchedSend = function send(this: XMLHttpRequest, ...args: unknown[]): void {
    const state = states.get(this);
    const parsed = state?.parsed;
    if (!state || !parsed || !shouldSimulate(this, state)) {
      (originalSend as (...a: unknown[]) => void).apply(this, args);
      return;
    }

    // Page headers first, proxy URL headers last: h= wins.
    const headers: HeaderMap = {};
    applyHeaders(headers, state.requestHeaders, 'page');
    applyHeaders(headers, parsed.headers, 'proxy');
    parsed.headers = headers;
    state.simulated = true;

    void simulate(this, parsed);
  };

  const marks: Array<[string, Function]> = [
    ['open', patchedOpen],
    ['send', patchedSend],
    ['setRequestHeader', patchedSetRequestHeader],
  ];
  for (const [name] of marks) {
    if ((proto[name] as unknown as Record<string, unknown>)[PATCH_MARK]) {
      uninstallXhrHook();
      return false;
    }
  }

  try {
    for (const [name, fn] of marks) {
      Object.defineProperty(fn, PATCH_MARK, { value: true });
      Object.defineProperty(proto, name, {
        configurable: true,
        writable: true,
        enumerable: false,
        value: fn,
      });
    }
  } catch (error) {
    log('xhrHook: cannot patch XMLHttpRequest, leaving it alone', error);
    uninstallXhrHook();
    return false;
  }

  installed = true;
  log('xhrHook: installed');
  return true;
}

export function uninstallXhrHook(): void {
  const proto = P()?.XMLHttpRequest?.prototype;
  if (proto && originalOpen) {
    try {
      Object.defineProperty(proto, 'open', { configurable: true, writable: true, value: originalOpen });
      Object.defineProperty(proto, 'send', { configurable: true, writable: true, value: originalSend });
      Object.defineProperty(proto, 'setRequestHeader', {
        configurable: true,
        writable: true,
        value: originalSetRequestHeader,
      });
    } catch {
      /* leave the patch in place, it is still the safer of the two states */
    }
  }
  installed = false;
  log('xhrHook: removed');
}

export function isXhrHookInstalled(): boolean {
  return installed;
}
