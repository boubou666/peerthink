import { createLocalStorageRepository, createNullRepository } from '../platform/storage.js';

/** Storage access throws outright in some privacy modes; degrade rather than fail. */
export function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * One repository for the whole shell, so the board list and the board itself
 * are looking at the same store rather than two views that can disagree.
 */
export const repository = (() => {
  const storage = safeLocalStorage();
  return storage ? createLocalStorageRepository({ storage }) : createNullRepository();
})();
