// HTMLMediaElement.src interception.
//
// This is the entry point the page itself uses: a userscript sandbox has its own
// HTMLMediaElement.prototype, so the page's `video.src = url` (or React's
// setAttribute) has to be intercepted on the page's prototype.
//
// A local proxy URL is *not* assigned to the element. It is reported through the
// getter and played by hls.js, which then assigns its own blob: URL through the
// original setter. Everything else keeps the browser's behaviour, including the
// fallback replay after a session gives up.

import { capabilities } from './capabilities';
import { P } from './env';
import { log, logOnce } from './log';
import { parseForInterception, type ParsedProxyUrl } from './proxyUrl';
import {
  clearSpoof,
  getSpoofedSrc,
  isOwnSrcAssignment,
  openAttachWindow,
  PlaybackSession,
  resetFallbackBudget,
  setOriginalSrcSetter,
  spoofSrc,
  stopSession,
} from './session';

const PATCH_MARK = '__stremioLocalProxySrc';
const BYPASS = new WeakSet<HTMLMediaElement>();

let descriptor: PropertyDescriptor | null = null;
let observer: MutationObserver | null = null;
let installed = false;

export function withBypass<T>(video: HTMLMediaElement, run: () => T): T {
  BYPASS.add(video);
  try {
    return run();
  } finally {
    BYPASS.delete(video);
  }
}

function nativeSet(video: HTMLMediaElement, url: string): void {
  if (descriptor?.set) {
    descriptor.set.call(video, url);
    return;
  }
  // The page replaced the descriptor under us; the attribute is the same thing
  // the native setter writes, and the observer ignores the value we spoof.
  try {
    video.setAttribute('src', url);
  } catch (error) {
    log('srcHook: cannot assign src', error);
  }
}

/**
 * `parsed` is what parseForInterception() returned, so the caller has already
 * established that this URL is a proxy URL in the server's format with a target
 * we may fetch. A session is only ever started for one of those.
 */
export function startSession(video: HTMLMediaElement, url: string, parsed: ParsedProxyUrl): void {
  try {
    setOriginalSrcSetter(video, nativeSet);
    stopSession(video, 'src-assigned');
    if (getSpoofedSrc(video) !== url) resetFallbackBudget(video);
    clearSpoof(video);
    const session = new PlaybackSession(video, url, parsed);
    spoofSrc(video, url);
    session.start();
  } catch (error) {
    log('srcHook: cannot start a session, using the native load', error);
    nativeSet(video, url);
  }
}

function patchedSetter(this: HTMLMediaElement, value: unknown): void {
  const url = typeof value === 'string' ? value : String(value ?? '');
  try {
    if (BYPASS.has(this)) {
      nativeSet(this, url);
      return;
    }
    const method = 'GET';
    if (isOwnSrcAssignment(this, url)) {
      // hls.js assigning its own blob: URL while it is attaching.
      nativeSet(this, url);
      return;
    }
    const parsed = parseForInterception(url, { method });
    if (!parsed) {
      // Not ours: another local route, another format, or a target we refuse.
      if (getSpoofedSrc(this) === undefined) {
        nativeSet(this, url);
        return;
      }
      // We own the element, so a source we cannot play replaces ours cleanly.
      stopSession(this, 'src-replaced');
      clearSpoof(this);
      nativeSet(this, url);
      return;
    }
    if (!capabilities().srcHook) {
      nativeSet(this, url);
      return;
    }
    startSession(this, url, parsed);
  } catch (error) {
    log('srcHook: internal error, using the native setter', error);
    nativeSet(this, url);
  }
}

function patchedGetter(this: HTMLMediaElement): string {
  const spoofed = getSpoofedSrc(this);
  if (spoofed !== undefined) return spoofed;
  return descriptor?.get ? descriptor.get.call(this) : '';
}

function onAttributes(records: MutationRecord[]): void {
  for (const record of records) {
    if (record.type !== 'attributes' || record.attributeName !== 'src') continue;
    const element = record.target as HTMLElement | null;
    if (!element) continue;
    const value = element.getAttribute('src');
    if (!value) continue;

    const video = (
      element.tagName === 'VIDEO' ? element : element.closest('video')
    ) as HTMLMediaElement | null;
    if (!video) continue;
    // Our own replay: the getter is already reporting this value.
    if (getSpoofedSrc(video) === value) continue;

    // Same gate as the property setter, including the format and the target
    // check: an attribute on a route we do not serve is not our business.
    const parsed = parseForInterception(value, { method: 'GET' });
    if (!parsed) continue;
    if (!capabilities().srcHook) continue;

    if (element.tagName === 'SOURCE') {
      // Stop the browser from starting a request it is not allowed to make;
      // hls.js will assign its own source shortly after.
      element.removeAttribute('src');
    }
    openAttachWindow(video);
    startSession(video, value, parsed);
  }
}

export function installSrcHook(): boolean {
  if (!capabilities().srcHook) {
    logOnce('src-hook-off', 'srcHook: disabled —', capabilities().reason);
    return false;
  }
  if (installed) return true;

  const page = P();
  const proto = page?.HTMLMediaElement?.prototype;
  if (!proto) return false;

  const found = Object.getOwnPropertyDescriptor(proto, 'src');
  if (!found?.get || !found.set) return false;
  descriptor = found;
  if ((found.get as unknown as Record<string, unknown>)[PATCH_MARK]) return false;

  try {
    const getter = function get(this: HTMLMediaElement): string {
      return patchedGetter.call(this);
    };
    const setter = function set(this: HTMLMediaElement, value: unknown): void {
      patchedSetter.call(this, value);
    };
    for (const fn of [getter, setter]) {
      Object.defineProperty(fn, PATCH_MARK, { value: true });
    }
    Object.defineProperty(proto, 'src', {
      configurable: found.configurable,
      enumerable: found.enumerable,
      get: getter,
      set: setter,
    });
  } catch (error) {
    log('srcHook: cannot patch HTMLMediaElement.src, leaving it alone', error);
    descriptor = null;
    return false;
  }

  const MutationObserverCtor = page?.MutationObserver;
  if (typeof MutationObserverCtor === 'function') {
    try {
      const root = page.document?.documentElement;
      if (root) {
        const instance: MutationObserver = new MutationObserverCtor(onAttributes);
        instance.observe(root, { attributes: true, attributeFilter: ['src'], subtree: true });
        observer = instance;
      }
    } catch (error) {
      observer = null;
      log('srcHook: cannot observe src attributes, the property hook still works', error);
    }
  }

  installed = true;
  log('srcHook: installed');
  return true;
}

export function uninstallSrcHook(): void {
  const proto = P()?.HTMLMediaElement?.prototype;
  if (proto && descriptor) {
    try {
      Object.defineProperty(proto, 'src', descriptor);
    } catch {
      /* leave the patch in place: it is still the safer of the two states */
    }
  }
  try {
    observer?.disconnect();
  } catch {
    /* already gone */
  }
  observer = null;
  installed = false;
  log('srcHook: removed');
}

export function isSrcHookInstalled(): boolean {
  return installed;
}
