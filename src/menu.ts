// The userscript manager's own menu ("This user script → ...").
//
// GM_registerMenuCommand is the only part of the sandbox that is driven by a
// human, so it is the natural home for the local URL. There is no in-page UI:
// adding a visible control to web.stremio.com would mean touching the page, and
// this script's whole design is to stay out of it.
//
// The menu captions are the only English the user reads, so they are sentences
// rather than labels. A manager that has no menu (or a sandbox without the API)
// is not an error: the script then runs entirely on the build-time default, and
// logOnce says so once.

import { DEFAULT_LOCAL_ORIGIN } from './config';
import { env, hasMenu, P } from './env';
import { logOnce } from './log';
import { getLocalOrigin, saveLocalOrigin } from './settings';

const SET_CAPTION = 'Set local service URL';
const RESET_CAPTION = 'Reset local service URL';
const SHOW_CAPTION = 'Show local service URL';

/**
 * prompt/confirm/alert on the page's window: a dialog opened from the sandbox
 * can be swallowed by the manager on some browsers, and the page is the realm
 * that reliably has them.
 */
function dialog(name: 'prompt' | 'confirm' | 'alert') {
  return (...args: unknown[]): unknown => {
    const page = P();
    const fn = page?.[name];
    if (typeof fn === 'function') return fn.apply(page, args);
    return (env.sandboxGlobal as any)?.[name]?.(...args);
  };
}

function onSetLocalUrl(): void {
  const prompt = dialog('prompt') as (message: string, initial?: string) => string | null;
  const alert = dialog('alert') as (message: string) => void;

  const entered = prompt(
    `Local Stremio service URL (default ${DEFAULT_LOCAL_ORIGIN})`,
    getLocalOrigin(),
  );
  if (entered === null) return;

  const result = saveLocalOrigin(entered);
  if (!result.ok) {
    alert(`Not saved: ${result.error}`);
    return;
  }
  alert(
    result.origin === DEFAULT_LOCAL_ORIGIN
      ? `Local URL set to ${result.origin}.`
      : `Local URL set to ${result.origin}. Reload the Stremio tab to use it.`,
  );
}

function onShowLocalUrl(): void {
  const alert = dialog('alert') as (message: string) => void;
  alert(`Local service URL: ${getLocalOrigin()}`);
}

function onResetLocalUrl(): void {
  const confirm = dialog('confirm') as (message: string) => boolean;
  const alert = dialog('alert') as (message: string) => void;

  if (getLocalOrigin() === DEFAULT_LOCAL_ORIGIN) {
    alert(`Local service URL is already ${DEFAULT_LOCAL_ORIGIN}.`);
    return;
  }
  if (!confirm(`Reset the local service URL to ${DEFAULT_LOCAL_ORIGIN}?`)) return;

  const result = saveLocalOrigin(DEFAULT_LOCAL_ORIGIN);
  alert(
    result.ok
      ? `Reset to ${result.origin}. Reload the Stremio tab to use it.`
      : `Not reset: ${result.error}`,
  );
}

/** Returns the number of commands registered, 0 when the manager has no menu. */
export function registerMenu(): number {
  const register = env.gmRegisterMenuCommand;
  if (!hasMenu() || typeof register !== 'function') {
    logOnce('menu-missing', 'menu: GM_registerMenuCommand is unavailable, settings stay at the build-time default');
    return 0;
  }

  const commands: Array<[string, () => void]> = [
    [SET_CAPTION, onSetLocalUrl],
    [SHOW_CAPTION, onShowLocalUrl],
    [RESET_CAPTION, onResetLocalUrl],
  ];

  let registered = 0;
  for (const [caption, handler] of commands) {
    try {
      register.call(env.sandboxGlobal, caption, handler);
      registered += 1;
    } catch (error) {
      logOnce(`menu-${caption}`, `menu: could not register "${caption}"`, error);
    }
  }
  return registered;
}
