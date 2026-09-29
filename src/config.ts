// Every tunable in one place. Nothing here is read from the network, from the
// page, or from a userscript value: the script's behaviour is fixed at build
// time so a hostile page cannot reconfigure it.

export const LOCAL_ORIGIN = 'http://127.0.0.1:11470';
export const LOCAL_HOST = '127.0.0.1';
export const LOCAL_PORT = '11470';
export const LOCAL_SCHEME = 'http:';

/** The local server only rewrites playlists under this prefix (service/server.js:218). */
export const PROXY_PATH_PREFIX = '/proxy/';

// Mirrors MAX_URL_LEN in service/lib/proxy.js.
export const MAX_UPSTREAM_URL_LENGTH = 2048;
// Mirrors invalidHeaderValue() in service/lib/proxy.js.
export const MAX_HEADER_VALUE_LENGTH = 1024;
export const MAX_FORWARDED_HEADERS = 16;

export const ALLOWED_METHODS = ['GET', 'HEAD'] as const;
export type AllowedMethod = (typeof ALLOWED_METHODS)[number];

/** Response types we can faithfully synthesise. blob/document fall back to the real XHR. */
export const SUPPORTED_RESPONSE_TYPES = ['', 'text', 'arraybuffer', 'json'] as const;

export const MAX_CONCURRENT_REQUESTS = 6;

/**
 * Unanswered local requests in a row before the script stops intervening for this
 * page load. Two is enough to tell "not running" from "one bad moment", and low
 * enough that a service which just started coming up is used again quickly.
 */
export const LOCAL_SERVICE_FAILURE_THRESHOLD = 2;
export const FIRST_BYTE_TIMEOUT_MS = 15_000;
export const STALL_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 500;
export const MAX_RETRY_DELAY_MS = 4_000;
export const RETRYABLE_STATUS_CODES = [408, 425, 429, 500, 502, 503, 504];

/** Sniffed prefix of a body when the content type is inconclusive. */
export const SNIFF_BYTES = 65_536;

export const PLAYLIST_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
];

export const PLAYLIST_MAGIC = '#EXTM3U';

/** Hls config, matched to stremio-video's hlsConfig so playback behaves the same. */
export const HLS_CONFIG = {
  debug: false,
  // The transmuxer runs on the main thread: a blob: worker created from a
  // userscript sandbox is rejected by the page CSP on most sites.
  enableWorker: false,
  backBufferLength: 30,
  maxBufferLength: 50,
  maxMaxBufferLength: 80,
  maxBufferHole: 0,
  maxFragLookUpTolerance: 0,
  manifestLoadingTimeOut: 30_000,
  manifestLoadingMaxRetry: 3,
  fragLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 10_000,
      maxLoadTimeMs: 120_000,
      timeoutRetry: { maxNumRetry: 5, retryDelayMs: 0, maxRetryDelayMs: 2_000 },
      errorRetry: { maxNumRetry: 3, retryDelayMs: 1_000, maxRetryDelayMs: 4_000 },
    },
  },
  playlistLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 10_000,
      maxLoadTimeMs: 60_000,
      timeoutRetry: { maxNumRetry: 5, retryDelayMs: 0, maxRetryDelayMs: 2_000 },
      errorRetry: { maxNumRetry: 3, retryDelayMs: 1_000, maxRetryDelayMs: 4_000 },
    },
  },
} as const;

export const PAGE_HIDE_GRACE_MS = 1_500;
export const MAX_FALLBACK_ATTEMPTS = 3;
