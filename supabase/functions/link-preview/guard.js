/**
 * What this function is allowed to fetch.
 *
 * A function that fetches a URL somebody typed into a card is a request made
 * from inside the provider's network on a stranger's behalf, which is the whole
 * of server-side request forgery. The URL arrives from a board that anyone
 * authorised to edit it can write to, so "it is only our own users" is not a
 * defence — it is the description of the attack.
 *
 * So the rules are here, in one file, with no Deno in it: everything below is
 * string and number work, which means `test/node/link-preview-function.test.js`
 * can drive every branch without a runtime, a network, or a deployed function.
 * `index.js` applies them, twice — once to the URL as given, and again to every
 * address the name resolves to and every redirect it follows.
 *
 * Plain JavaScript, not TypeScript, for the same reason: it is the only way this
 * code can be imported by the suite that already exists, and there is no
 * TypeScript anywhere else in this repository.
 */

/** How long to wait for a page, per request. */
export const TIMEOUT_MS = 6_000;

/** How much of a page to read before deciding we have seen the head. */
export const MAX_BYTES = 256 * 1024;

/** How much of a thumbnail to carry back, before base64 makes it a third bigger. */
export const MAX_IMAGE_BYTES = 120 * 1024;

/** How many hops to follow. Each one is re-checked; none is trusted. */
export const MAX_REDIRECTS = 3;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Names that mean "somewhere in here" rather than somewhere on the internet.
 *
 * A single-label name — `router`, `intranet` — is in the same class: it resolves
 * through the network's own search domain, which is exactly the network this
 * code is running inside. Public hostnames all have a dot.
 */
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.home.arpa', '.onion'];

export function isBlockedName(host) {
  const name = String(host ?? '').toLowerCase().replace(/\.$/, '');
  if (!name) return true;
  if (name === 'localhost') return true;
  if (PRIVATE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  // No dot, and not an address: a name only this network can resolve.
  return !name.includes('.') && !name.includes(':');
}

/** Blocked IPv4 ranges, as the octets they are recognised by. */
function blockedV4([a, b, c]) {
  if ([a, b, c].some((part) => part > 255)) return true;   // not an address at all
  if (a === 0) return true;                                // this network, and 0.0.0.0
  if (a === 10) return true;                               // private
  if (a === 127) return true;                              // loopback
  if (a === 100 && b >= 64 && b <= 127) return true;       // carrier-grade NAT
  if (a === 169 && b === 254) return true;                 // link-local, and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;        // private
  if (a === 192 && b === 168) return true;                 // private
  if (a === 192 && b === 0 && c === 0) return true;        // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true;    // benchmarking
  if (a >= 224) return true;                               // multicast, and everything reserved above it
  return false;
}

/**
 * An IPv6 literal as its eight groups, or null when it is not one.
 *
 * Written out rather than pattern-matched on the text, because the text has too
 * many spellings: `::1`, `0:0:0:0:0:0:0:1` and `::ffff:127.0.0.1` are all
 * loopback, and a prefix check would catch one of the three.
 */
export function expandV6(value) {
  const address = String(value ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!address.includes(':')) return null;

  const halves = address.split('::');
  if (halves.length > 2) return null;

  const parse = (part) => (part ? part.split(':') : []);
  const head = parse(halves[0]);
  const tail = parse(halves[1] ?? '');

  // A trailing dotted quad — `::ffff:192.168.0.1` — is two groups.
  const groups = [];
  const push = (parts) => {
    for (const part of parts) {
      const quad = IPV4.exec(part);
      if (quad) {
        const [a, b, c, d] = quad.slice(1).map(Number);
        if ([a, b, c, d].some((n) => n > 255)) return false;
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return false;
      groups.push(parseInt(part, 16));
    }
    return true;
  };

  if (!push(head)) return null;
  const filled = groups.length;
  if (!push(tail)) return null;

  if (halves.length === 2) {
    const missing = 8 - groups.length;
    if (missing < 1) return null;
    groups.splice(filled, 0, ...Array(missing).fill(0));
  }

  return groups.length === 8 ? groups : null;
}

function blockedV6(groups) {
  const [first, second] = groups;
  const empty = groups.slice(0, 5).every((group) => group === 0);

  if (groups.every((group) => group === 0)) return true;                       // ::
  if (empty && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return true; // ::1
  // An IPv4 address wearing an IPv6 hat is still that address.
  if (empty && groups[5] === 0xffff) {
    return blockedV4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  if (first === 0x64 && second === 0xff9b) return true;                        // NAT64, ditto
  if ((first & 0xfe00) === 0xfc00) return true;                                // unique local
  if ((first & 0xffc0) === 0xfe80) return true;                                // link-local
  if ((first & 0xff00) === 0xff00) return true;                                // multicast
  return false;
}

/**
 * Whether an address must not be fetched.
 *
 * Answers false for anything that is not a literal address — a hostname is
 * `isBlockedName`'s business, and what it resolves to is checked separately,
 * with this.
 *
 * Note the URL parser does the hard part before this is reached: it normalises
 * `http://2130706433/` and `http://0x7f.1/` to `127.0.0.1`, so the decimal and
 * hex spellings of a loopback address arrive here as dotted quads. There is a
 * test that pins exactly that, because it is load-bearing and invisible.
 */
export function isBlockedAddress(host) {
  const address = String(host ?? '').replace(/^\[|\]$/g, '');
  const quad = IPV4.exec(address);
  if (quad) return blockedV4(quad.slice(1).map(Number));

  const groups = expandV6(address);
  if (groups) return blockedV6(groups);

  // A bracketed host that is not a readable IPv6 literal is refused rather than
  // guessed at.
  return host !== address;
}

/**
 * A URL this function will follow, or the reason it will not.
 *
 * The reason is for the log, never for the answer. A caller is told the same
 * thing about a refused host as about a host that did not reply — otherwise this
 * becomes a port scanner for the provider's private network, answering "that one
 * exists" a few hundred times a second.
 */
export function checkUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    return { refused: 'not-a-url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { refused: 'scheme' };
  // `https://docs.example.com@evil.test/` is a trick on the reader, and the
  // credentials would be sent to whoever the host really is.
  if (url.username || url.password) return { refused: 'credentials' };
  if (isBlockedAddress(url.hostname)) return { refused: 'private-address' };
  if (isBlockedName(url.hostname)) return { refused: 'private-name' };

  return { url };
}
