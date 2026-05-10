/**
 * Trip-module constants. Validation bounds + UI palette pinning.
 */
import { TRIP_COVER_COLORS } from '../../database/constants.js';

export const MIN_TRIP_NAME_LENGTH = 1;
export const MAX_TRIP_NAME_LENGTH = 80;

/** Max length of free-text trip description. */
export const MAX_TRIP_DESCRIPTION_LENGTH = 500;

/** Emoji column carries one or two grapheme clusters for compound emojis. */
export const MAX_TRIP_EMOJI_LENGTH = 8;

/** Re-export the cover-color palette for module consumers. */
export { TRIP_COVER_COLORS };

/** Server-side fallback when the client doesn't pick a cover color. */
export const DEFAULT_TRIP_EMOJI = '🌴';
