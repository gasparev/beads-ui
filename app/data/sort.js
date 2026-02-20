/**
 * Shared sort comparators for issues lists.
 * Centralizes sorting so views and stores stay consistent.
 */

/**
 * @typedef {{ id: string, title?: string, status?: 'open'|'in_progress'|'closed', priority?: number, issue_type?: string, created_at?: number, updated_at?: number, closed_at?: number }} IssueLite
 */

/**
 * Compare by priority asc, then created_at asc, then id asc.
 *
 * @param {IssueLite} a
 * @param {IssueLite} b
 */
export function cmpPriorityThenCreated(a, b) {
  const pa = a.priority ?? 2;
  const pb = b.priority ?? 2;
  if (pa !== pb) {
    return pa - pb;
  }
  const ca = a.created_at ?? 0;
  const cb = b.created_at ?? 0;
  if (ca !== cb) {
    return ca < cb ? -1 : 1;
  }
  const ida = a.id;
  const idb = b.id;
  return ida < idb ? -1 : ida > idb ? 1 : 0;
}

/**
 * Compare by priority desc (least severe first), then created_at desc, id asc.
 *
 * @param {IssueLite} a
 * @param {IssueLite} b
 */
export function cmpPriorityDescThenCreated(a, b) {
  const pa = a.priority ?? 2;
  const pb = b.priority ?? 2;
  if (pa !== pb) {
    return pb - pa;
  }
  const ca = a.created_at ?? 0;
  const cb = b.created_at ?? 0;
  if (ca !== cb) {
    return ca < cb ? 1 : -1;
  }
  const ida = a.id;
  const idb = b.id;
  return ida < idb ? -1 : ida > idb ? 1 : 0;
}

/**
 * Compare by created_at desc (most recent first), then id asc.
 *
 * @param {IssueLite} a
 * @param {IssueLite} b
 */
export function cmpCreatedDesc(a, b) {
  const ca = a.created_at ?? 0;
  const cb = b.created_at ?? 0;
  if (ca !== cb) {
    return ca < cb ? 1 : -1;
  }
  const ida = a.id;
  const idb = b.id;
  return ida < idb ? -1 : ida > idb ? 1 : 0;
}

/**
 * Compare by created_at asc (oldest first), then id asc.
 *
 * @param {IssueLite} a
 * @param {IssueLite} b
 */
export function cmpCreatedAsc(a, b) {
  const ca = a.created_at ?? 0;
  const cb = b.created_at ?? 0;
  if (ca !== cb) {
    return ca < cb ? -1 : 1;
  }
  const ida = a.id;
  const idb = b.id;
  return ida < idb ? -1 : ida > idb ? 1 : 0;
}

/**
 * Compare by updated_at desc (most recently updated first), then id asc.
 *
 * @param {IssueLite} a
 * @param {IssueLite} b
 */
export function cmpUpdatedDesc(a, b) {
  const ca = a.updated_at ?? 0;
  const cb = b.updated_at ?? 0;
  if (ca !== cb) {
    return ca < cb ? 1 : -1;
  }
  const ida = a.id;
  const idb = b.id;
  return ida < idb ? -1 : ida > idb ? 1 : 0;
}

/**
 * Compare by closed_at desc, then id asc for stability.
 *
 * @param {IssueLite} a
 * @param {IssueLite} b
 */
export function cmpClosedDesc(a, b) {
  const ca = a.closed_at ?? 0;
  const cb = b.closed_at ?? 0;
  if (ca !== cb) {
    return ca < cb ? 1 : -1;
  }
  const ida = a?.id;
  const idb = b?.id;
  return ida < idb ? -1 : ida > idb ? 1 : 0;
}

/**
 * Sort order keys for the board view.
 *
 * @typedef {'most-severe'|'least-severe'|'recent-first'|'oldest-first'|'recently-updated'} SortOrder
 */

/**
 * Map a sort order key to its comparator function.
 *
 * @type {Record<SortOrder, (a: IssueLite, b: IssueLite) => number>}
 */
export const SORT_ORDER_COMPARATORS = {
  'most-severe': cmpPriorityThenCreated,
  'least-severe': cmpPriorityDescThenCreated,
  'recent-first': cmpCreatedDesc,
  'oldest-first': cmpCreatedAsc,
  'recently-updated': cmpUpdatedDesc
};

/**
 * Display labels for sort order keys.
 *
 * @type {Record<SortOrder, string>}
 */
export const SORT_ORDER_LABELS = {
  'most-severe': 'Most severe',
  'least-severe': 'Least severe',
  'recent-first': 'Recent first',
  'oldest-first': 'Oldest first',
  'recently-updated': 'Recently updated'
};
