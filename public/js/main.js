import { createApp } from './app.js';

/**
 * Bootstrap. The only file in the project that is allowed to know it is
 * running in a browser — everything else receives what it needs.
 */
const app = createApp({
  document,
  window,
  storage: safeLocalStorage(),
});

/** Storage access throws outright in some privacy modes; degrade rather than fail. */
function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// console and test surface
window.app = app;
