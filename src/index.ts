// Entry point. Runs at document-start, before the page's own scripts.
//
// Order matters: the src hook goes first so a native load is cancelled as early
// as possible, then XHR (hls.js's loader) and fetch. Every installation is
// fail-open: if anything at all throws, the page is left exactly as it was.

import { detectCapabilities } from './capabilities';
import { destroyAllSessions, P } from './env';
import { hasGm, refreshEnv } from './env';
import { log, logOnce } from './log';
import { registerMenu } from './menu';
import { loadSettings } from './settings';
import { installFetchHook } from './fetchHook';
import { installSrcHook } from './srcHook';
import { installXhrHook } from './xhrHook';

function guarded(name: string, run: () => boolean): void {
  try {
    run();
  } catch (error) {
    logOnce(`install-${name}`, `index: ${name} failed to install`, error);
  }
}

function main(): void {
  refreshEnv();

  // Before the hooks: the gate compares against the configured local origin, so
  // a user who has changed it must not be filtered out by the default.
  loadSettings();
  registerMenu();

  if (!hasGm()) {
    // Without a userscript manager there is no way to reach 127.0.0.1. Stay
    // completely out of the page's way rather than half-hooking it.
    log('index: GM_xmlhttpRequest is unavailable, nothing to do');
    return;
  }

  const caps = detectCapabilities();
  if (!caps.srcHook && !caps.xhrHook) {
    log('index: nothing to hook', caps.reason);
    return;
  }

  guarded('srcHook', installSrcHook);
  guarded('xhrHook', installXhrHook);
  guarded('fetchHook', installFetchHook);

  const page = P();
  if (page?.addEventListener) {
    page.addEventListener('pagehide', () => {
      destroyAllSessions('pagehide');
    });
  }
}

try {
  main();
} catch (error) {
  // A userscript manager shows uncaught errors on top of the page; swallow ours.
  void error;
}
