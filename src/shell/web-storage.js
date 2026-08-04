/**
 * Storage access throws outright in some privacy modes; degrade rather than
 * fail. Returns null when Web Storage cannot be reached at all.
 *
 * Its own module because both sides of the shell need it — the auth client
 * keeps its session here, and the local repository keeps boards here — and
 * those two must not import each other: the repository now depends on the
 * account, so a shared helper living in either one is a cycle.
 */
export function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
