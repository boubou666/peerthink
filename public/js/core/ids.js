/**
 * Object ids come from an injected generator so tests can be deterministic and
 * a future server can hand out ids the whole session agrees on.
 */
export function createIdGenerator(source = () => crypto.randomUUID()) {
  return () => source().replace(/-/g, '').slice(0, 8);
}

/** Predictable ids for tests and fixtures: p1, p2, … */
export function createSequentialIds(prefix = 'p') {
  let n = 0;
  return () => `${prefix}${++n}`;
}
