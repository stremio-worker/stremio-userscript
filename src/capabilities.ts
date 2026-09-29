// Look at the environment once per page load and cache the answer. Nothing
// is requested here: whether the manager hands out real ReadableStreams is not
// knowable without asking it, and asking it means a request, so the transport
// finds out on the first real request instead and remembers the answer. Every
// other endpoint of the local server stays the page's own business, including
// /version.

import { env, hasGm, hasHls, P, refreshHls } from './env';
import { resetTransportState } from './transport';

export interface Capabilities {
  /** GM_xmlhttpRequest is present. Without it the script does nothing at all. */
  gm: boolean;
  /** MSE is available in the page. */
  mediaSource: boolean;
  /** hls.js from @require, and it considers this browser supported. */
  hls: boolean;
  /** Intercept page fetch() calls. */
  fetchHook: boolean;
  /** Intercept page XMLHttpRequest calls (this is also our own hls.js path). */
  xhrHook: boolean;
  /** Take over HTMLMediaElement.src assignments. */
  srcHook: boolean;
  /** Why srcHook is off, when it is. */
  reason: string;
}

let cached: Capabilities | null = null;

function detectMediaSource(): boolean {
  const page = P();
  if (!page) return false;
  try {
    if (typeof page.MediaSource !== 'function') return false;
    if (typeof page.MediaSource.isTypeSupported !== 'function') return false;
    return page.MediaSource.isTypeSupported('video/mp4');
  } catch {
    return false;
  }
}

function detectHls(): boolean {
  // @require has run before this file, but a test may have injected the
  // constructor after startup, so re-read it before giving up.
  if (!hasHls()) refreshHls();
  const HlsCtor = env.hls;
  if (!HlsCtor) return false;
  try {
    return HlsCtor.isSupported() === true;
  } catch {
    return false;
  }
}

export function detectCapabilities(): Capabilities {
  if (cached) return cached;

  const gm = hasGm();
  const mediaSource = detectMediaSource();
  const hls = detectHls();

  let reason = '';
  if (!gm) reason = 'GM_xmlhttpRequest unavailable';
  else if (!mediaSource) reason = 'MediaSource unavailable';
  else if (!hls) reason = 'hls.js unavailable or unsupported';

  cached = {
    gm,
    mediaSource,
    hls,
    // The transport downgrades to a buffered arraybuffer per request when the
    // manager has no streams, so fetch can be hooked as soon as GM exists.
    fetchHook: gm,
    xhrHook: gm,
    srcHook: gm && mediaSource && hls,
    reason,
  };
  return cached;
}

export function capabilities(): Capabilities {
  return cached ?? detectCapabilities();
}

export function resetCapabilities(): void {
  cached = null;
  resetTransportState();
}
