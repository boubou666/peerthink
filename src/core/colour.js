/**
 * Colour arithmetic, for a picker that draws its own spectrum.
 *
 * Hex is what a card carries and what a stylesheet speaks; hue, saturation and
 * value are what a person points at — a square of shades under a hue slider.
 * Neither is the other, so the picker converts, and the conversion lives here
 * rather than in the component for the reason `bar-position` does: it is the
 * fiddly part, and a .jsx file cannot be imported by `node --test`.
 *
 * Hue is degrees round the wheel, saturation and value are 0..1. Alpha is not
 * represented: a card is either painted or it is `none`, which the format bar
 * offers as its own control rather than as a corner of a gradient.
 */

/** Hex as anything a person might type: with or without `#`, 3/4/6/8 digits. */
const HEX = /^#?(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * `#rrggbb`, or null for anything that is not a colour.
 *
 * Null rather than a fallback colour, because the callers want to tell the two
 * apart: the hex field keeps what is being typed while it is still half a
 * colour, and writes to the cards only once this answers.
 *
 * Alpha is dropped rather than refused. A card can carry `#rrggbbaa` — the
 * board format allows it — and the honest thing to show for one is its colour;
 * refusing would leave the picker with nothing to display at all.
 */
export function normaliseHex(value) {
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (!HEX.test(text)) return null;

  const digits = text.replace('#', '').toLowerCase();
  const rgb = digits.length <= 4
    ? [...digits.slice(0, 3)].map((digit) => digit + digit).join('')
    : digits.slice(0, 6);

  return `#${rgb}`;
}

/** `{ h, s, v }` for a hex colour, or null if it is not one. */
export function hexToHsv(value) {
  const hex = normaliseHex(value);
  if (!hex) return null;

  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const spread = max - Math.min(r, g, b);

  /**
   * Grey has no hue — every channel is equal, and the expression below would
   * divide by zero. Zero is as good an answer as any and better than NaN: it
   * is only ever seen as where the hue slider sits for a colour that does not
   * have one, and the picker keeps the hue the user chose anyway, so dragging
   * down to black and back does not silently turn red into red-by-default.
   */
  let hue = 0;
  if (spread) {
    if (max === r) hue = ((g - b) / spread) % 6;
    else if (max === g) hue = (b - r) / spread + 2;
    else hue = (r - g) / spread + 4;
    hue = (hue * 60 + 360) % 360;
  }

  return { h: hue, s: max ? spread / max : 0, v: max };
}

/**
 * `#rrggbb` for a point in the cylinder.
 *
 * Hue wraps rather than clamps — it is an angle, and a slider at 359 nudged up
 * means red, not violet. Saturation and value clamp, because they are edges.
 */
export function hsvToHex({ h, s, v }) {
  const hue = ((h % 360) + 360) % 360;
  const saturation = clamp01(s);
  const value = clamp01(v);

  // The standard HSV→RGB in its branchless form: each channel is the same
  // function of hue, read a third of the wheel apart.
  const channel = (n) => {
    const k = (n + hue / 60) % 6;
    return value - value * saturation * Math.max(0, Math.min(k, 4 - k, 1));
  };

  const pair = (n) => Math.round(channel(n) * 255).toString(16).padStart(2, '0');
  return `#${pair(5)}${pair(3)}${pair(1)}`;
}

/**
 * `#rrggbb` for a browser's `rgb(…)`, or null for anything that is not a
 * colour a card could carry.
 *
 * Computed style is the only way to ask the stylesheet what a name means, and
 * it never answers in the hex that was written — always `rgb()` or `rgba()`.
 *
 * Fully transparent answers null rather than black. `rgba(0, 0, 0, 0)` is what
 * a card with no fill computes to, and it is not a dark colour: reading it as
 * `#000000` would put a black swatch in the palette where "no fill" belongs,
 * and that control is elsewhere. Partial alpha keeps its colour and loses its
 * alpha, which is the same trade `normaliseHex` makes for `#rrggbbaa`.
 */
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/i;

export function rgbToHex(value) {
  const parts = typeof value === 'string' ? value.trim().match(RGB) : null;
  if (!parts) return null;
  if (parts[4] !== undefined && Number(parts[4]) === 0) return null;

  const pair = (n) => Math.min(255, Math.max(0, Math.round(Number(n)))).toString(16).padStart(2, '0');
  return `#${pair(parts[1])}${pair(parts[2])}${pair(parts[3])}`;
}
