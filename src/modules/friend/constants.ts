/**
 * Friend-module constants. Bounds + magic numbers used by validation
 * and the search service.
 */

export const SEARCH_QUERY_MIN_LENGTH = 2;
export const SEARCH_QUERY_MAX_LENGTH = 60;

/** Hard cap on results returned by /friends/search. Mobile UX. */
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;
