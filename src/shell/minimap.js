import { createMinimapState } from '../platform/minimap-state.js';
import { safeLocalStorage } from './web-storage.js';

/**
 * Whether this browser wants the map, wherever Web Storage can be reached.
 *
 * Built per call rather than once at module load, for the reason `colours.js`
 * gives: `safeLocalStorage()` can answer differently later, and a module-level
 * capture would go on using whatever it found at import.
 */
export const minimapState = () => createMinimapState({ storage: safeLocalStorage() });
