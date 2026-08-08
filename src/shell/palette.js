import { readCardPalette } from '../platform/card-palette.js';

/**
 * The card palette this page's stylesheet describes, read once.
 *
 * Once is enough and once is necessary. Enough, because the card colours are
 * deliberately the same in both themes — a card is paper, and keeps a light
 * background in the dark theme too — so nothing a user can do changes the
 * answer. Necessary, because the format bar re-renders on every viewport
 * event: probing on each one would force a layout per frame of a pan, which
 * is the cost this is careful to pay only once.
 *
 * Lazily, rather than at import: the first caller is a format bar, which
 * cannot exist until something is selected, and by then the stylesheet has
 * certainly arrived. Reading at module load would race it in development,
 * where the styles are injected by script.
 */
let palette = null;

export const cardPalette = () => (palette ??= readCardPalette({ document, window }));
