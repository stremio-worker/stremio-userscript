// The settings the user can change from the userscript manager's own UI.
//
// Exactly one value is configurable: the local service's origin. It cannot be
// discovered — the script recognises the local service by origin string, and
// probing ports from a page is not something this script does. Everything else
// stays a build-time constant in config.ts.
//
// What a setting is not: page input. GM_setValue writes to the manager's own
// store, not the page's, so a hostile playlist cannot move the origin. The value
// is still validated on the way in and on the way out, because a stored value
// that is not a local origin is a misconfiguration, and the symptom would be
// silent: the gate would stop matching the page's requests and the script would
// look like it was not installed at all.

import { DEFAULT_LOCAL_ORIGIN } from './config';
import { env } from './env';
import { log, logOnce } from './log';
import { classifyTarget } from './ssrf';

/** GM_getValue key holding the local origin. */
export const LOCAL_ORIGIN_KEY = 'localOrigin';

const MAX_SETTING_LENGTH = 256;

export interface ValidOrigin {
  ok: true;
  /** Normalised `scheme://host:port`, with no trailing slash. */
  origin: string;
}

export interface InvalidOrigin {
  ok: false;
  error: string;
}

export type OriginCheck = ValidOrigin | InvalidOrigin;

/**
 * Accepts only an origin that could name a service on this machine or this
 * network. The local origin is the one host the script does not run the SSRF
 * policy on, so it is checked here instead: a public address would be a script
 * rewriting playlists to a host it has no business naming, and the upstream
 * targets inside those playlists are the page's to choose.
 */
export function validateLocalOrigin(value: unknown): OriginCheck {
  if (typeof value !== 'string') return { ok: false, error: 'the local URL must be text' };
  const text = value.trim();
  if (text.length === 0) return { ok: false, error: 'the local URL is empty' };
  if (text.length > MAX_SETTING_LENGTH) {
    return { ok: false, error: `the local URL is longer than ${MAX_SETTING_LENGTH} characters` };
  }

  let url: URL;
  try {
    url = new URL(text.includes('://') ? text : `http://${text}`);
  } catch {
    return { ok: false, error: `"${text}" is not a valid URL` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `${url.protocol} is not supported, use http:// or https://` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'the local URL must not carry a username or password' };
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return { ok: false, error: 'the local URL must be a bare origin, without a path' };
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, error: 'the local URL must be a bare origin, without a query or fragment' };
  }

  const target = classifyTarget(url);
  if (target.verdict !== 'internal') {
    return {
      ok: false,
      error: `${url.hostname} is not a local address (${target.reason}); the local service has to run on this machine or this network`,
    };
  }

  return { ok: true, origin: url.origin };
}

// The live value, read once at startup and replaced when the user saves.
let current = DEFAULT_LOCAL_ORIGIN;

export function getLocalOrigin(): string {
  return current;
}

export function setLocalOriginInMemory(origin: string): void {
  current = origin;
}

/** Splits the configured origin into the three parts the gate compares against. */
export function localOriginParts(): { scheme: string; host: string; port: string } {
  const url = new URL(current);
  return { scheme: url.protocol, host: url.hostname, port: url.port };
}

function readStoredOrigin(): string {
  const get = env.gmGetValue;
  if (!get) return DEFAULT_LOCAL_ORIGIN;
  let raw: unknown;
  try {
    raw = get(LOCAL_ORIGIN_KEY, undefined);
  } catch (error) {
    logOnce('settings-read', 'settings: could not read the stored local URL', error);
    return DEFAULT_LOCAL_ORIGIN;
  }
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_LOCAL_ORIGIN;
  const check = validateLocalOrigin(raw);
  if (!check.ok) {
    // Stored by an older build, or hand-edited in the manager's storage view.
    // Falling back keeps the script working at the default rather than standing
    // down entirely.
    logOnce('settings-invalid', `settings: ignoring the stored local URL (${check.error}), using the default`);
    return DEFAULT_LOCAL_ORIGIN;
  }
  return check.origin;
}

/** Called once at startup, before any hook is installed. */
export function loadSettings(): void {
  current = readStoredOrigin();
  if (current !== DEFAULT_LOCAL_ORIGIN) log('settings: local URL set to', current);
}

export type SaveResult = ValidOrigin | InvalidOrigin;

export function saveLocalOrigin(value: unknown): SaveResult {
  const check = validateLocalOrigin(value);
  if (!check.ok) {
    logOnce('settings-rejected', `settings: rejected a local URL (${check.error})`);
    return check;
  }
  const set = env.gmSetValue;
  if (!set) {
    return { ok: false, error: 'this userscript manager cannot store settings' };
  }
  try {
    set(LOCAL_ORIGIN_KEY, check.origin);
  } catch (error) {
    logOnce('settings-write', 'settings: could not store the local URL', error);
    return { ok: false, error: 'the userscript manager refused to store the value' };
  }
  current = check.origin;
  log('settings: local URL saved as', check.origin);
  return check;
}
