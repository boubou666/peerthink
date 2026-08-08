import { createRecentColours } from '../platform/recent-colours.js';
import { safeLocalStorage } from './web-storage.js';

/**
 * The colours mixed on this browser, wherever Web Storage can be reached.
 *
 * Built per call rather than once at module load, for the reason `seen.js`
 * gives: `safeLocalStorage()` can answer differently later, and a module-level
 * capture would go on using whatever it found at import.
 */
export const recentColours = () => createRecentColours({ storage: safeLocalStorage() });
