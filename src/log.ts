// Logging is off by default and never prints header values, cookies, playlist
// bodies or upstream query strings. A "full" URL can carry tokens in `d=`, so
// only the origin plus a shortened path is ever shown.

const PREFIX = '[stremio-local-proxy]';

/** Build-time switch. Flipping it is the only way to get debug output. */
let enabled = false;

export function setLoggingEnabled(value: boolean): void {
  enabled = value;
}

export function isLoggingEnabled(): boolean {
  return enabled;
}

/** Shortens a URL to `origin + path` (path clipped) and drops query + fragment. */
export function safeUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '<empty>';
  try {
    const url = new URL(value);
    const path = url.pathname.length > 48 ? `${url.pathname.slice(0, 45)}...` : url.pathname;
    return `${url.origin}${path}`;
  } catch {
    return '<unparsable>';
  }
}

/** Host + first path segment only, for upstream URLs that live in proxy params. */
export function safeUpstream(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '<empty>';
  try {
    const url = new URL(value);
    const segment = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return `${url.host}/${segment}`.slice(0, 64);
  } catch {
    return '<unparsable>';
  }
}

function emit(level: 'log' | 'warn' | 'error', args: unknown[]): void {
  if (!enabled) return;
  const sink =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink.call(console, PREFIX, ...args);
}

export function log(...args: unknown[]): void {
  emit('log', args);
}

export function warn(...args: unknown[]): void {
  emit('warn', args);
}

export function logError(...args: unknown[]): void {
  emit('error', args);
}

const onceKeys = new Set<string>();

/** Rate-limited, de-duplicated warning. */
export function logOnce(key: string, ...args: unknown[]): void {
  if (onceKeys.has(key)) return;
  onceKeys.add(key);
  if (onceKeys.size > 200) {
    const oldest = onceKeys.values().next();
    if (!oldest.done) onceKeys.delete(oldest.value);
  }
  emit('warn', args);
}

export function resetLogOnce(): void {
  onceKeys.clear();
}
