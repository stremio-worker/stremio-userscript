// The single place where the script reaches outside itself: the userscript
// sandbox (`window`), the page (`unsafeWindow`), the GM_xmlhttpRequest API and
// hls.js. Every module goes through here, which is what makes the rest of the
// code testable on plain node and keeps the sandbox boundary in one file.

import type Hls from 'hls.js';

export type HlsConstructor = typeof Hls;
export type HlsInstance = Hls;

export type GmRequestMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'TRACE';
export type GmResponseType = 'arraybuffer' | 'blob' | 'json' | 'text' | 'stream';

export interface GmRequestDetails {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  responseType?: GmResponseType;
  anonymous?: boolean;
  redirect?: 'follow' | 'error' | 'manual';
  timeout?: number;
  context?: unknown;
  onloadstart?: (response: GmLoadStartResponse) => void;
  onprogress?: (progress: GmProgressResponse) => void;
  onload?: (response: GmResponse) => void;
  onerror?: (error: unknown) => void;
  ontimeout?: (error: unknown) => void;
  onabort?: (error: unknown) => void;
}

export interface GmLoadStartResponse {
  response: unknown;
  finalUrl?: string;
  responseURL?: string;
  status?: number;
  statusText?: string;
  responseHeaders?: string;
  readyState?: number;
}

export interface GmProgressResponse {
  loaded: number;
  total: number;
  lengthComputable?: boolean;
  response?: unknown;
  finalUrl?: string;
}

export interface GmResponse {
  status: number;
  statusText?: string;
  responseHeaders?: string;
  response?: unknown;
  responseText?: string;
  responseURL?: string;
  finalUrl?: string;
}

export interface GmHandle {
  abort: () => void;
}

export type GmRequestFn = (details: GmRequestDetails) => GmHandle | void;

export interface Env {
  /** The userscript sandbox global. */
  sandboxGlobal: any;
  /** The page window (unsafeWindow when the manager provides it). */
  page: any;
  /** GM_xmlhttpRequest, or null when the script runs without a manager. */
  gmRequest: GmRequestFn | null;
  /** hls.js constructor injected through @require, or null. */
  hls: HlsConstructor | null;
}

function sandboxGlobal(): any {
  return typeof globalThis !== 'undefined' ? globalThis : {};
}

function detectPage(): any {
  const sandbox = sandboxGlobal();
  const unsafe = sandbox.unsafeWindow;
  if (unsafe) return unsafe;
  if (sandbox.window) return sandbox.window;
  return sandbox;
}

function detectGmRequest(): GmRequestFn | null {
  const sandbox = sandboxGlobal();
  if (typeof sandbox.GM_xmlhttpRequest === 'function') return sandbox.GM_xmlhttpRequest;
  if (typeof sandbox.GM?.xmlHttpRequest === 'function') return sandbox.GM.xmlHttpRequest;
  return null;
}

function detectHls(): HlsConstructor | null {
  const sandbox = sandboxGlobal();
  const page = detectPage();
  const candidates = [sandbox.Hls, page?.Hls, sandbox.HlsJs, page?.HlsJs];
  for (const candidate of candidates) {
    if (typeof candidate === 'function' && typeof candidate.isSupported === 'function') {
      return candidate as HlsConstructor;
    }
  }
  return null;
}

export const env: Env = {
  sandboxGlobal: sandboxGlobal(),
  page: detectPage(),
  gmRequest: detectGmRequest(),
  hls: null,
};

/** Test-only: lets a suite swap the whole outside world before the code runs. */
export function configureEnv(patch: Partial<Env>): void {
  Object.assign(env, patch);
}

/** Re-reads the sandbox (used once at startup, after the manager set its grants). */
export function refreshEnv(): void {
  env.sandboxGlobal = sandboxGlobal();
  env.page = detectPage();
  if (!env.gmRequest) env.gmRequest = detectGmRequest();
  if (!env.hls) env.hls = detectHls();
}

/** Re-detects only hls.js, so a test that injected its own page keeps it. */
export function refreshHls(): void {
  if (!env.hls) env.hls = detectHls();
}

export function hasGm(): boolean {
  return typeof env.gmRequest === 'function';
}

export function hasHls(): boolean {
  return env.hls !== null;
}

export function setHls(hls: HlsConstructor | null): void {
  env.hls = hls;
}

/**
 * hls.js types its emitter with the enum members, but at runtime it is a plain
 * string dispatcher and the values come from the injected constructor. One cast
 * here instead of a cast on every call site.
 */
export function onHlsEvent(
  hls: HlsInstance,
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  (hls.on as unknown as (name: string, cb: (...args: unknown[]) => void) => void)(event, listener);
}

// --- page primitives -------------------------------------------------------
//
// Every one of these is resolved at call time, never cached: a page can replace
// them at any moment and we must not end up calling a constructor the page has
// swapped for its own tracking wrapper.

export function P(): any {
  return env.page;
}

export function requirePageCtor(name: string): any {
  const ctor = P()?.[name];
  if (typeof ctor !== 'function') {
    throw new Error(`${name} is not available`);
  }
  return ctor;
}

// --- live session registry -------------------------------------------------
//
// `HTMLMediaElement` has no event for "this element went away", so sessions are
// tracked here and swept on demand (src changes, pagehide, and before any new
// interception).

export interface SessionHandle {
  destroy: (reason: string) => void;
}

const liveSessions = new Set<SessionHandle>();

export function registerSession(session: SessionHandle): void {
  liveSessions.add(session);
}

export function unregisterSession(session: SessionHandle): void {
  liveSessions.delete(session);
}

export function sweepSessions(keep: SessionHandle | null, reason: string): void {
  for (const session of Array.from(liveSessions)) {
    if (session === keep) continue;
    try {
      session.destroy(reason);
    } catch {
      liveSessions.delete(session);
    }
  }
}

export function destroyAllSessions(reason: string): void {
  sweepSessions(null, reason);
}

// --- micro task queue ------------------------------------------------------
//
// A userscript sandbox can sit in a different JS realm than the page. Promises
// and queueMicrotask can be realm specific, so tasks are always scheduled on
// the page's globals.

export function queueMicrotaskOnPage(task: () => void): void {
  const page = P();
  try {
    if (page && typeof page.queueMicrotask === 'function') {
      page.queueMicrotask(task);
      return;
    }
    if (page && typeof page.setTimeout === 'function') {
      page.setTimeout(task, 0);
      return;
    }
  } catch {
    /* fall through to the sandbox */
  }
  queueMicrotask(task);
}
