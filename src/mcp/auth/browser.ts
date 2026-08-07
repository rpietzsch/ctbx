/**
 * Browser side of the authorization redirect, spec §7.5.
 *
 * A popup is preferred so the app keeps its state (an in-flight conversation
 * survives connecting a server). Popups are blocked often enough that the
 * full-page redirect fallback is not optional; both paths land on the same
 * static `callback.html` and converge on the same validation.
 */
import { readCallbackParams, type CallbackParams } from './validation';

/** Where the app lives, including the GitHub Pages subpath. */
export function appBaseUrl(): string {
  if (typeof globalThis.location === 'undefined') return 'https://rpietzsch.github.io/ctbx/';
  const { origin, pathname } = globalThis.location;
  const base = pathname.replace(/index\.html$/, '');
  return `${origin}${base.endsWith('/') ? base : `${base}/`}`;
}

export function redirectUri(): string {
  return `${appBaseUrl()}oauth/callback.html`;
}

/**
 * The CIMD document URL, which doubles as this client's `client_id`.
 *
 * It must byte-match the `client_id` inside the document. Changing the repo
 * name or owner changes this URL and invalidates every existing authorization
 * (spec §7.3, risk R6).
 */
export function clientMetadataUrl(): string {
  return `${appBaseUrl()}oauth/client-metadata.json`;
}

export function clientMetadataDocument(): Record<string, unknown> {
  return {
    client_id: clientMetadataUrl(),
    client_name: 'ctbx',
    client_uri: appBaseUrl(),
    redirect_uris: [redirectUri()],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

export const CALLBACK_MESSAGE_TYPE = 'ctbx:oauth-callback';
export const REDIRECT_RESULT_KEY = 'ctbx:oauth-redirect-result';

export interface PopupResult {
  params: CallbackParams;
  via: 'popup' | 'redirect';
}

/**
 * Opens the authorization URL in a popup and resolves when `callback.html`
 * posts the result back. Rejects if the popup cannot be opened, so the caller
 * can fall back to a full-page redirect.
 */
export function openAuthorizationPopup(
  authorizationUrl: string,
  options: { timeoutMs?: number } = {}
): Promise<CallbackParams> {
  return new Promise((resolve, reject) => {
    const popup = globalThis.open(
      authorizationUrl,
      'ctbx-oauth',
      'width=520,height=680,menubar=no,toolbar=no'
    );

    if (!popup) {
      reject(new Error('popup-blocked'));
      return;
    }

    const expectedOrigin = new URL(appBaseUrl()).origin;
    let settled = false;

    function cleanup() {
      globalThis.removeEventListener('message', onMessage);
      clearInterval(closedTimer);
      clearTimeout(timeoutTimer);
    }

    function onMessage(event: MessageEvent) {
      // Only ever trust a message from our own origin and our own callback page.
      if (event.origin !== expectedOrigin) return;
      const data = event.data as { type?: string; params?: CallbackParams } | null;
      if (!data || data.type !== CALLBACK_MESSAGE_TYPE || !data.params) return;

      settled = true;
      cleanup();
      popup?.close();
      resolve(data.params);
    }

    globalThis.addEventListener('message', onMessage);

    const closedTimer = setInterval(() => {
      if (popup.closed && !settled) {
        cleanup();
        reject(new Error('popup-closed'));
      }
    }, 500);

    const timeoutTimer = setTimeout(
      () => {
        if (settled) return;
        cleanup();
        popup.close();
        reject(new Error('popup-timeout'));
      },
      options.timeoutMs ?? 5 * 60 * 1000
    );
  });
}

/** Full-page redirect fallback when a popup is unavailable. */
export function redirectToAuthorization(authorizationUrl: string): void {
  globalThis.location.assign(authorizationUrl);
}

/**
 * Drains a redirect-mode result stashed by `callback.html`. Called once on app
 * boot, before anything else looks at connection state.
 */
export function takeRedirectResult(): CallbackParams | undefined {
  let raw: string | null;
  try {
    raw = globalThis.sessionStorage?.getItem(REDIRECT_RESULT_KEY) ?? null;
    if (raw !== null) globalThis.sessionStorage.removeItem(REDIRECT_RESULT_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;

  try {
    const parsed = JSON.parse(raw) as { search?: string };
    if (typeof parsed.search !== 'string') return undefined;
    return readCallbackParams(parsed.search);
  } catch {
    return undefined;
  }
}
