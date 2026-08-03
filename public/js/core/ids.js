/**
 * Object ids come from an injected generator so tests can be deterministic and
 * a future server can hand out ids the whole session agrees on.
 *
 * 12 hex characters is 48 bits. Ids are minted independently by every client —
 * there is no coordinator to reject a duplicate — so the width has to survive
 * the birthday bound rather than the object count: 48 bits keeps a collision
 * below one in a million out past a million objects, where 32 bits would start
 * colliding in the tens of thousands.
 */
export const ID_LENGTH = 12;

export function createIdGenerator(source = () => crypto.randomUUID()) {
  return () => source().replace(/-/g, '').slice(0, ID_LENGTH);
}

/** Predictable ids for tests and fixtures: p1, p2, … */
export function createSequentialIds(prefix = 'p') {
  let n = 0;
  return () => `${prefix}${++n}`;
}
