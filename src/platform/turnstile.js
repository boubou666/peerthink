/**
 * A token that says the visitor is probably a person.
 *
 * Anonymous sign-in is the one endpoint here that anybody can reach without
 * having anything, and each call is a row in auth.users that nothing cleans up
 * except a nightly sweep. Turnstile is what stands in front of it.
 *
 * Configuration is a value that can be absent, exactly as it is for Supabase:
 * with no site key there is no widget, no script, and no token — and the
 * project has CAPTCHA protection switched off, so sign-in works anyway. That
 * is what lets the tests and a bare `npm run dev` run against a project with
 * no bot protection, and the deployed site run against one with it.
 *
 * The two halves must move together in one direction only. Turning the
 * Supabase setting on while the site sends no token rejects every sign-in;
 * sending a token to a project that is not checking one is ignored. So the
 * key ships first and the setting is turned on afterwards.
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** No key, no widget. Trimmed because a variable set to whitespace is not set. */
export function readTurnstileConfig(env = {}) {
  const siteKey = env.VITE_TURNSTILE_SITE_KEY?.trim();
  return siteKey ? { siteKey } : null;
}

/**
 * Load Cloudflare's script once, and answer when it is ready.
 *
 * Memoised on the document rather than in a module variable: two apps on one
 * page share the document, and a second <script> tag for the same src would
 * have the browser fetch and evaluate it twice. A failed load rejects and
 * clears the memo, so a retry is a retry rather than the cached failure.
 */
const loaders = new WeakMap();

export function loadTurnstile(doc, consumer) {
  if (doc?.defaultView?.turnstile) return Promise.resolve(doc.defaultView.turnstile);

  const pending = loaders.get(doc);
  if (pending) {
    if (consumer) pending.consumers.add(consumer);
    return pending.loading;
  }

  let script;
  const loading = new Promise((resolve, reject) => {
    script = doc.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      const api = doc.defaultView?.turnstile;
      // onload without the global is a script that loaded and did not do what
      // it was loaded for — a proxy serving an error page with a 200, most
      // likely. Rejecting says so rather than failing later on `undefined`.
      api ? resolve(api) : reject(new Error('Turnstile loaded without an API.'));
    };
    script.onerror = () => reject(new Error('Could not load Turnstile.'));
    doc.head.appendChild(script);
  });

  const settled = loading
    .catch((error) => {
      loaders.delete(doc);
      throw error;
    })
    // Nothing to cancel once it has landed, so the record goes either way.
    .finally(() => {
      if (loaders.get(doc)?.loading === settled) loaders.delete(doc);
    });

  loaders.set(doc, {
    loading: settled,
    script,
    consumers: new Set(consumer ? [consumer] : []),
  });
  return settled;
}

/**
 * Drop a load that has not settled, once nobody is waiting on it.
 *
 * A pending script outlives whoever asked for it: its handlers hold a closure
 * over a promise nobody is waiting for any more, and the tag sits in the head
 * of a document the app has finished with. Removing it is what makes destroy()
 * mean destroyed. Safe to call twice, and safe after the load has landed.
 *
 * The script is shared per document, and two apps on one page share the
 * document — so a provider being destroyed says only that *it* has stopped
 * waiting. Pulling the script out from under the other one would leave it
 * awaiting a promise that can now never settle, which is a worse leak than
 * the one this is here to fix.
 */
export function cancelTurnstileLoad(doc, consumer) {
  const pending = loaders.get(doc);
  if (!pending) return;
  if (consumer) {
    pending.consumers.delete(consumer);
    if (pending.consumers.size > 0) return;
  }
  loaders.delete(doc);
  if (!pending.script) return;
  pending.script.onload = null;
  pending.script.onerror = null;
  pending.script.remove?.();
}

/**
 * A function that answers a fresh token, or null if there is no site key.
 *
 * A token is single-use and short-lived, so one is taken per sign-in rather
 * than kept. The widget renders into a detached element: the managed mode is
 * invisible unless Cloudflare decides otherwise, and an interactive challenge
 * in a container nobody attached would be one the visitor cannot answer — so
 * the container is attached, sized to nothing, and removed when the token
 * arrives.
 */
export function createTurnstileCaptcha(config, { doc, load = loadTurnstile, cancel = cancelTurnstileLoad } = {}) {
  if (!config) return null;

  // A function with a lifecycle rather than an object, so the port that calls
  // it stays a call rather than a protocol. destroy() drops a script still in
  // flight; a token already taken needs nothing undone.
  // This provider's identity in the shared loader, so destroy() withdraws only
  // this one rather than cancelling for everybody on the page.
  const self = Symbol('turnstile-consumer');

  const captcha = async () => {
    const turnstile = await load(doc, self);
    const container = doc.createElement('div');
    container.setAttribute('data-turnstile', '');
    doc.body.appendChild(container);

    try {
      return await new Promise((resolve, reject) => {
        turnstile.render(container, {
          sitekey: config.siteKey,
          callback: resolve,
          'error-callback': () => reject(new Error('Turnstile refused to issue a token.')),
          'timeout-callback': () => reject(new Error('Turnstile timed out.')),
        });
      });
    } finally {
      container.remove();
    }
  };

  captcha.destroy = () => cancel(doc, self);
  return captcha;
}
