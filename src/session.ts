// One playback session per video element.
//
// The sniffed URL is only *reported* through the src getter: hls.js creates the
// MediaSource and assigns video.src = blob:... itself when attachMedia() runs,
// and that assignment is left to the original setter. A page that reads
// currentSrc / video.src therefore keeps seeing the local proxy URL, and nothing
// else in the page notices that playback is driven by hls.js.

import { HLS_CONFIG, MAX_FALLBACK_ATTEMPTS } from './config';
import {
  env,
  onHlsEvent,
  queueMicrotaskOnPage,
  registerSession,
  unregisterSession,
  type HlsInstance,
} from './env';
import { log, logOnce } from './log';
import { isLocalProxyUrl } from './proxyUrl';
import type { ParsedProxyUrl } from './proxyUrl';
import { parseProxyUrl } from './proxyUrl';
import { sniffMedia } from './sniff';

export interface HlsData {
  fatal?: boolean;
  type?: string;
  details?: string;
  reason?: string;
  error?: unknown;
}

export interface HlsLevelLike {
  type?: string;
  audioCodec?: string;
  videoCodec?: string;
}

const WATCHDOG_INTERVAL_MS = 5_000;

/** hls.js only ever assigns a blob: URL from attachMedia(). */
const BLOB_URL = /^blob:/i;

const activeSessions = new WeakMap<HTMLMediaElement, PlaybackSession>();
const spoofedSrc = new WeakMap<HTMLMediaElement, string>();
const originalSetters = new WeakMap<HTMLMediaElement, (video: HTMLMediaElement, url: string) => void>();
const fallbackCounts = new WeakMap<HTMLMediaElement, number>();
const attachWindows = new WeakMap<HTMLMediaElement, symbol>();

/**
 * Between the src attribute mutation and the manifest being parsed, hls.js
 * assigns its own blob: URL to the element. That assignment belongs to us, not
 * to the page, so it must not look like "the page changed the source".
 */
export function openAttachWindow(video: HTMLMediaElement): void {
  attachWindows.set(video, Symbol('attach'));
}

/** Without a token the window is closed unconditionally. */
function closeAttachWindow(video: HTMLMediaElement, token?: symbol): void {
  if (token === undefined || attachWindows.get(video) === token) attachWindows.delete(video);
}

/**
 * True only for the assignment hls.js itself makes: it has to be a blob: URL
 * *and* it has to happen inside the attach window it opened. Either condition
 * alone would swallow an assignment from the page, which must always win.
 */
export function isOwnSrcAssignment(video: HTMLMediaElement, url: string): boolean {
  if (!BLOB_URL.test(url)) return false;
  const token = attachWindows.get(video);
  if (token === undefined) return false;
  const session = activeSessions.get(video);
  return session !== undefined && session.attaching;
}

export function spoofSrc(video: HTMLMediaElement, url: string): void {
  spoofedSrc.set(video, url);
}

export function getSpoofedSrc(video: HTMLMediaElement): string | undefined {
  return spoofedSrc.get(video);
}

export function clearSpoof(video: HTMLMediaElement): void {
  spoofedSrc.delete(video);
}

/** Installed by the src hook, which is the only holder of the native setter. */
export function setOriginalSrcSetter(
  video: HTMLMediaElement,
  setter: (video: HTMLMediaElement, url: string) => void,
): void {
  originalSetters.set(video, setter);
}

export class PlaybackSession {
  readonly video: HTMLMediaElement;
  readonly sourceUrl: string;
  readonly parsed: ParsedProxyUrl;
  /** False when the proxy URL carries no target we are allowed to fetch. */
  readonly usable: boolean;

  private state: 'sniffing' | 'attaching' | 'playing' | 'stopped' = 'sniffing';
  private readonly abort = new AbortController();
  private hls: HlsInstance | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly onPlay = (): void => {
    try {
      const played = this.video.play();
      if (played && typeof played.catch === 'function') played.catch(() => undefined);
    } catch {
      /* autoplay rejected; the page handles the user gesture */
    }
  };

  constructor(video: HTMLMediaElement, sourceUrl: string, parsed?: ParsedProxyUrl) {
    this.video = video;
    this.sourceUrl = sourceUrl;
    this.parsed = parsed ?? parseProxyUrl(sourceUrl, { method: 'GET' }) ?? {
      upstreamUrl: '',
      headers: {},
      method: 'GET',
    };
    this.usable = this.parsed.upstreamUrl !== '';
  }

  get stopped(): boolean {
    return this.state === 'stopped';
  }

  /** True while hls.js owns video.src, i.e. it may assign a blob: URL. */
  get attaching(): boolean {
    return this.state === 'attaching';
  }

  get status(): string {
    return this.state;
  }

  /** SessionHandle, used by the env-wide sweep on pagehide. */
  destroy = (reason: string): void => {
    this.stop();
    if (reason) logOnce('session-stop', `session: stopped (${reason})`);
  };

  start(): void {
    const current = activeSessions.get(this.video);
    if (current === this) return;
    if (current) current.stop();

    activeSessions.set(this.video, this);
    registerSession(this);
    spoofSrc(this.video, this.sourceUrl);
    this.video.addEventListener('play', this.onPlay);
    void this.run();
  }

  private async run(): Promise<void> {
    if (!this.usable) {
      // The `d=` parameter did not survive parsing: it is not an http(s) URL, it
      // carries credentials, or it points into the local network. The page is
      // asking us to fetch something we must not, and it gets its own load.
      this.fail('the local proxy URL has no usable target', '');
      return;
    }
    const result = await sniffMedia(this.parsed, this.abort.signal);
    if (this.stopped) return;
    if (result.kind !== 'playlist') {
      const why = result.kind === 'unknown' ? 'probe inconclusive' : result.contentType ?? 'not hls';
      this.fail('probe says no playlist', why);
      return;
    }
    await this.attach();
  }

  private async attach(): Promise<void> {
    const ctor = env.hls;
    if (typeof ctor !== 'function') {
      this.fail('hls.js is missing', '');
      return;
    }
    this.state = 'attaching';
    const token = Symbol('attach');
    attachWindows.set(this.video, token);

    const hls = new ctor(HLS_CONFIG);
    this.hls = hls;

    // hls.js is injected by @require, never bundled, so the event names come
    // from the constructor with the documented strings as a fallback.
    const events = (ctor as unknown as {
      Events?: { ERROR: 'hlsError'; MANIFEST_PARSED: 'hlsManifestParsed' };
    }).Events;
    const errorEvent = events?.ERROR ?? 'hlsError';
    const manifestEvent = events?.MANIFEST_PARSED ?? 'hlsManifestParsed';

    const onError = ((_event: string, data: unknown): void => {
      if (this.stopped) return;
      const error = data as HlsData | undefined;
      if (!error?.fatal) return;
      this.fail(`hls.js fatal: ${error.type ?? 'unknown'} ${error.details ?? ''}`.trim(), '');
    }) as (...args: unknown[]) => void;

    const onManifest = ((_event: string, data: unknown): void => {
      if (this.stopped || this.state === 'playing') return;
      const parsed = data as { levels?: HlsLevelLike[] } | undefined;
      if (!hasPlayableLevel(parsed)) {
        this.fail('no level this browser can decode', 'codec');
        return;
      }
      this.state = 'playing';
      // It worked, so the fallback budget is not a life sentence: a service that
      // comes back later must be used again for this element.
      fallbackCounts.delete(this.video);
      closeAttachWindow(this.video, token);
      this.armWatchdog();
    }) as (...args: unknown[]) => void;

    onHlsEvent(hls, errorEvent, onError);
    onHlsEvent(hls, manifestEvent, onManifest);

    // loadSource goes through the XHR hook, which is the point: the page CSP
    // blocks the browser from reaching 127.0.0.1, the userscript manager does
    // not. attachMedia assigns video.src = blob:... and that assignment belongs
    // to the browser, not to us.
    hls.loadSource(this.sourceUrl);
    hls.attachMedia(this.video);
  }

  private fail(reason: string, detail: string): void {
    if (this.stopped) return;
    logOnce('session-fallback', `session: ${reason} ${detail}`.trim());
    this.fallback();
  }

  /**
   * Undo everything and hand the URL back to the element so the page runs its
   * own load path. destroy() runs first so hls.js has already released the
   * MediaSource and the blob URL.
   */
  fallback(): void {
    if (this.stopped) return;
    const count = fallbackCounts.get(this.video) ?? 0;
    if (count >= MAX_FALLBACK_ATTEMPTS) {
      log('session: too many fallbacks, leaving the element alone', this.sourceUrl);
      this.stop();
      return;
    }
    fallbackCounts.set(this.video, count + 1);
    const { video, sourceUrl } = this;
    this.stop();
    replayOriginalLoad(video, sourceUrl);
  }

  stop(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    closeAttachWindow(this.video, undefined);
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    this.abort.abort();
    this.video.removeEventListener('play', this.onPlay);
    try {
      this.hls?.destroy();
    } catch (error) {
      log('session: hls.js destroy threw', error);
    }
    this.hls = null;
    if (activeSessions.get(this.video) === this) activeSessions.delete(this.video);
    unregisterSession(this);
  }

  /** The page can drop the element long before anyone disposes the session. */
  private armWatchdog(): void {
    if (this.state === 'stopped') return;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.state === 'stopped') return;
      if (this.video.isConnected === false) {
        this.stop();
        return;
      }
      this.armWatchdog();
    }, WATCHDOG_INTERVAL_MS);
  }
}

export function hasPlayableLevel(data: { levels?: HlsLevelLike[] } | undefined): boolean {
  const levels = data?.levels ?? [];
  if (levels.length === 0) return true;
  const MediaSourceCtor = env.page?.MediaSource;
  if (typeof MediaSourceCtor?.isTypeSupported !== 'function') return true;
  for (const level of levels) {
    const mime = level.type === 'audio' ? 'audio/mp4' : 'video/mp4';
    const codecs = [level.videoCodec, level.audioCodec].filter(Boolean).join(',');
    const mimeType = codecs ? `${mime}; codecs="${codecs}"` : mime;
    try {
      if (MediaSourceCtor.isTypeSupported(mimeType)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * A different source on the same element gets its own budget. The count exists to
 * stop us fighting the page for one URL, not to lock a recovered service out of
 * an element that React reuses for the next title.
 */
export function resetFallbackBudget(video: HTMLMediaElement): void {
  fallbackCounts.delete(video);
}

export function replayOriginalLoad(video: HTMLMediaElement, url: string): void {
  const setter = originalSetters.get(video);
  if (!setter) {
    log('session: no native src setter available, cannot replay', url);
    return;
  }
  // The original setter reflects into the src attribute, which the src hook
  // observes. The spoof is kept, so the observer recognises the value as one
  // this script already owns and does not start a second session.
  spoofSrc(video, url);
  queueMicrotaskOnPage(() => {
    try {
      setter(video, url);
    } catch (error) {
      log('session: replaying the native load failed', error);
    }
  });
}

export function getActiveSession(video: HTMLMediaElement): PlaybackSession | undefined {
  return activeSessions.get(video);
}

export function stopSession(video: HTMLMediaElement, reason: string): void {
  const session = activeSessions.get(video);
  if (!session) return;
  session.stop();
  if (reason && isLocalProxyUrl(session.sourceUrl)) {
    logOnce('session-replaced', `session: replaced (${reason})`);
  }
}
