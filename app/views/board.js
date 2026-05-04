import { html, render } from 'lit-html';
import { createListSelectors } from '../data/list-selectors.js';
import {
  SORT_ORDER_COMPARATORS,
  SORT_ORDER_LABELS,
  cmpPriorityThenCreated
} from '../data/sort.js';
import { createIssueIdRenderer } from '../utils/issue-id-renderer.js';
import { createLabelBadges } from '../utils/label-badge.js';
import { debug } from '../utils/logging.js';
import { createPriorityBadge } from '../utils/priority-badge.js';
import { showToast } from '../utils/toast.js';
import { createTypeBadge } from '../utils/type-badge.js';

/**
 * @typedef {{
 *   id: string,
 *   title?: string,
 *   status?: 'open'|'in_progress'|'closed',
 *   priority?: number,
 *   issue_type?: string,
 *   created_at?: number,
 *   updated_at?: number,
 *   closed_at?: number,
 *   labels?: string[]
 * }} IssueLite
 */

/**
 * Map column IDs to their corresponding status values.
 *
 * @type {Record<string, 'open'|'in_progress'|'closed'>}
 */
const COLUMN_STATUS_MAP = {
  'blocked-col': 'open',
  'ready-col': 'open',
  'in-progress-col': 'in_progress',
  'closed-col': 'closed'
};

/**
 * Create the Board view with Blocked, Ready, In progress, Closed.
 * Push-only: derives items from per-subscription stores.
 *
 * Sorting rules:
 * - Default sort is recent-first across columns.
 * - Users can switch to severity, oldest-first, or recently-updated sorting.
 * - Closed issues are additionally filtered by closed_at time window.
 *
 * @param {HTMLElement} mount_element
 * @param {unknown} _data - Unused (legacy param retained for call-compat)
 * @param {(id: string) => void} gotoIssue - Navigate to issue detail.
 * @param {{ getState: () => any, setState: (patch: any) => void, subscribe?: (fn: (s:any)=>void)=>()=>void }} [store]
 * @param {{ selectors: { getIds: (client_id: string) => string[], count?: (client_id: string) => number } }} [subscriptions]
 * @param {{ snapshotFor?: (client_id: string) => any[], subscribe?: (fn: () => void) => () => void }} [issueStores]
 * @param {(type: string, payload: unknown) => Promise<unknown>} [transport] - Transport function for sending updates
 * @returns {{ load: () => Promise<void>, clear: () => void }}
 */
export function createBoardView(
  mount_element,
  _data,
  gotoIssue,
  store,
  subscriptions = undefined,
  issueStores = undefined,
  transport = undefined
) {
  const log = debug('views:board');
  /** @type {IssueLite[]} */
  let list_ready = [];
  /** @type {IssueLite[]} */
  let list_blocked = [];
  /** @type {IssueLite[]} */
  let list_in_progress = [];
  /** @type {IssueLite[]} */
  let list_closed = [];
  /** @type {IssueLite[]} */
  let list_closed_raw = [];

  // Unfiltered lists for label dropdown (so excluded labels remain visible)
  /** @type {IssueLite[]} */
  let list_ready_unfiltered = [];
  /** @type {IssueLite[]} */
  let list_blocked_unfiltered = [];
  /** @type {IssueLite[]} */
  let list_in_progress_unfiltered = [];
  /** @type {IssueLite[]} */
  let list_closed_unfiltered = [];

  // Centralized selection helpers
  const selectors = issueStores ? createListSelectors(issueStores) : null;

  /**
   * Closed column filter mode.
   * 'today' → items with closed_at since local day start
   * '3' → last 3 days; '7' → last 7 days
   *
   * @type {'today'|'3'|'7'}
   */
  let closed_filter_mode = 'today';

  /**
   * Active sort order for all columns.
   *
   * @type {import('../data/sort.js').SortOrder}
   */
  let sort_order = 'recent-first';

  /**
   * @typedef {{
   *   label: string,
   *   mode: 'include' | 'exclude'
   * }} LabelFilter
   */

  /**
   * Active label filters (multi-select with include/exclude mode).
   * Include filters: show issues with ANY included label (OR logic)
   * Exclude filters: hide issues with ANY excluded label (AND logic)
   *
   * @type {LabelFilter[]}
   */
  let label_filters = [];

  /**
   * Label filter dropdown open state.
   *
   * @type {boolean}
   */
  let label_dropdown_open = false;

  /**
   * Locally accepted status moves awaiting authoritative subscription updates.
   *
   * @type {Map<string, { issue: IssueLite, target_column_id: string }>}
   */
  const optimistic_status_moves = new Map();

  if (store) {
    try {
      const s = store.getState();
      const cf =
        s && s.board ? String(s.board.closed_filter || 'today') : 'today';
      if (cf === 'today' || cf === '3' || cf === '7') {
        closed_filter_mode = /** @type {any} */ (cf);
      }
      const so =
        s && s.board
          ? String(s.board.sort_order || 'recent-first')
          : 'recent-first';
      if (so in SORT_ORDER_COMPARATORS) {
        sort_order = /** @type {import('../data/sort.js').SortOrder} */ (so);
      }
      // Normalize label_filters from store (handle legacy string → array → object[] migration)
      const lf = s && s.board && s.board.label_filters;
      if (Array.isArray(lf)) {
        label_filters = lf.map((item) => {
          if (typeof item === 'string') {
            // Legacy string format → convert to include filter
            return { label: item, mode: 'include' };
          }
          if (
            item &&
            typeof item === 'object' &&
            'label' in item &&
            'mode' in item
          ) {
            // New object format
            return {
              label: String(item.label),
              mode: item.mode === 'exclude' ? 'exclude' : 'include'
            };
          }
          // Fallback for malformed entries
          return { label: String(item), mode: 'include' };
        });
      } else if (lf) {
        label_filters = [{ label: String(lf), mode: 'include' }];
      }
    } catch {
      // ignore store init errors
    }
  }

  /**
   * Get display text for dropdown based on selected items.
   *
   * @param {LabelFilter[]} selected
   * @param {string} label
   * @returns {string}
   */
  function getDropdownDisplayText(selected, label) {
    if (selected.length === 0) {
      return `${label}: Any`;
    }
    if (selected.length === 1) {
      const mode_prefix = selected[0].mode === 'exclude' ? '−' : '';
      return `${label}: ${mode_prefix}${selected[0].label}`;
    }
    return `${label} (${selected.length})`;
  }

  /**
   * Get all unique labels from all issues across all columns.
   *
   * @param {IssueLite[]} issues
   * @returns {string[]}
   */
  function getAllUniqueLabels(issues) {
    /** @type {Set<string>} */
    const label_set = new Set();
    for (const issue of issues) {
      if (issue.labels && Array.isArray(issue.labels)) {
        for (const label of issue.labels) {
          label_set.add(label);
        }
      }
    }
    return Array.from(label_set).sort();
  }

  /**
   * Parse a bd timestamp value into epoch milliseconds.
   *
   * @param {unknown} value
   * @returns {number | null}
   */
  function parseIssueTimestamp(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
  }

  /**
   * Normalize an updated issue payload from a mutation reply for local board use.
   *
   * @param {unknown} value
   * @param {IssueLite | null} fallback_issue
   * @param {string} issue_id
   * @param {'open'|'in_progress'|'closed'} new_status
   * @returns {IssueLite}
   */
  function normalizeIssueLite(value, fallback_issue, issue_id, new_status) {
    const payload =
      value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    /** @type {IssueLite} */
    const issue = {
      ...(fallback_issue || {}),
      .../** @type {Record<string, unknown>} */ (payload),
      id: issue_id,
      status: new_status
    };

    const created_at = parseIssueTimestamp(issue.created_at);
    if (created_at !== null) {
      issue.created_at = created_at;
    }
    const updated_at = parseIssueTimestamp(issue.updated_at);
    issue.updated_at = updated_at !== null ? updated_at : Date.now();
    const closed_at = parseIssueTimestamp(issue.closed_at);
    if (new_status === 'closed') {
      issue.closed_at = closed_at !== null ? closed_at : Date.now();
    } else {
      delete issue.closed_at;
    }

    return issue;
  }

  /**
   * Apply label filter to issues.
   * If include filters exist, show issues with any included label.
   * Then apply exclude filters to hide issues with any excluded label.
   *
   * @param {IssueLite[]} issues
   * @returns {IssueLite[]}
   */
  function applyLabelFilter(issues) {
    if (label_filters.length === 0) {
      return issues;
    }

    const include_filters = label_filters
      .filter((f) => f.mode === 'include')
      .map((f) => f.label);
    const exclude_filters = label_filters
      .filter((f) => f.mode === 'exclude')
      .map((f) => f.label);

    let filtered = issues;

    // Step 1: Apply include filters (OR logic)
    if (include_filters.length > 0) {
      filtered = filtered.filter((issue) => {
        if (!issue.labels || !Array.isArray(issue.labels)) {
          return false;
        }
        return issue.labels.some((label) => include_filters.includes(label));
      });
    }

    // Step 2: Apply exclude filters (AND logic)
    if (exclude_filters.length > 0) {
      filtered = filtered.filter((issue) => {
        if (!issue.labels || !Array.isArray(issue.labels)) {
          // Issues without labels pass exclude filter
          return true;
        }
        // Exclude if issue has ANY excluded label
        return !issue.labels.some((label) => exclude_filters.includes(label));
      });
    }

    return filtered;
  }

  /**
   * Find an issue in the current unfiltered board lists.
   *
   * @param {string} issue_id
   * @returns {IssueLite | null}
   */
  function findLocalIssue(issue_id) {
    const lists = [
      list_ready_unfiltered,
      list_blocked_unfiltered,
      list_in_progress_unfiltered,
      list_closed_unfiltered,
      list_ready,
      list_blocked,
      list_in_progress,
      list_closed_raw,
      list_closed
    ];
    for (const list of lists) {
      const found = list.find((issue) => issue.id === issue_id);
      if (found) {
        return found;
      }
    }
    return null;
  }

  /**
   * Remove an issue from every local board source list.
   *
   * @param {string} issue_id
   */
  function removeLocalIssue(issue_id) {
    list_ready_unfiltered = list_ready_unfiltered.filter(
      (issue) => issue.id !== issue_id
    );
    list_blocked_unfiltered = list_blocked_unfiltered.filter(
      (issue) => issue.id !== issue_id
    );
    list_in_progress_unfiltered = list_in_progress_unfiltered.filter(
      (issue) => issue.id !== issue_id
    );
    list_closed_unfiltered = list_closed_unfiltered.filter(
      (issue) => issue.id !== issue_id
    );
  }

  /**
   * Find an issue in the source list for a target column.
   *
   * @param {string} issue_id
   * @param {string} target_column_id
   * @returns {IssueLite | null}
   */
  function findIssueInTargetSource(issue_id, target_column_id) {
    const list =
      target_column_id === 'closed-col'
        ? list_closed_unfiltered
        : target_column_id === 'in-progress-col'
          ? list_in_progress_unfiltered
          : target_column_id === 'blocked-col'
            ? list_blocked_unfiltered
            : list_ready_unfiltered;
    return list.find((issue) => issue.id === issue_id) || null;
  }

  /**
   * Check whether a stale source column still contains an optimistically moved issue.
   *
   * @param {string} issue_id
   * @param {string} target_column_id
   */
  function hasIssueOutsideTargetSource(issue_id, target_column_id) {
    /** @type {IssueLite[][]} */
    const lists = [];
    if (target_column_id !== 'ready-col') {
      lists.push(list_ready_unfiltered);
    }
    if (target_column_id !== 'blocked-col') {
      lists.push(list_blocked_unfiltered);
    }
    if (target_column_id !== 'in-progress-col') {
      lists.push(list_in_progress_unfiltered);
    }
    if (target_column_id !== 'closed-col') {
      lists.push(list_closed_unfiltered);
    }
    return lists.some((list) => list.some((issue) => issue.id === issue_id));
  }

  /**
   * Add an issue to the source list for a target column.
   *
   * @param {IssueLite} issue
   * @param {string} target_column_id
   */
  function addIssueToTargetSource(issue, target_column_id) {
    if (target_column_id === 'closed-col') {
      list_closed_unfiltered = [...list_closed_unfiltered, issue];
    } else if (target_column_id === 'in-progress-col') {
      list_in_progress_unfiltered = [...list_in_progress_unfiltered, issue];
    } else if (target_column_id === 'blocked-col') {
      list_blocked_unfiltered = [...list_blocked_unfiltered, issue];
    } else {
      list_ready_unfiltered = [...list_ready_unfiltered, issue];
    }
  }

  /**
   * Preserve accepted local moves while subscription pushes catch up.
   */
  function applyOptimisticMovesToSources() {
    for (const [issue_id, move] of optimistic_status_moves) {
      const authoritative_issue = findIssueInTargetSource(
        issue_id,
        move.target_column_id
      );
      const has_stale_source = hasIssueOutsideTargetSource(
        issue_id,
        move.target_column_id
      );
      removeLocalIssue(issue_id);
      if (authoritative_issue) {
        addIssueToTargetSource(authoritative_issue, move.target_column_id);
        if (!has_stale_source) {
          optimistic_status_moves.delete(issue_id);
        }
      } else {
        addIssueToTargetSource(move.issue, move.target_column_id);
      }
    }
  }

  /**
   * Recompute visible board lists from local unfiltered source lists.
   */
  function recomputeVisibleLists() {
    const cmp = SORT_ORDER_COMPARATORS[sort_order] ?? cmpPriorityThenCreated;
    list_ready_unfiltered = [...list_ready_unfiltered].sort(cmp);
    list_blocked_unfiltered = [...list_blocked_unfiltered].sort(cmp);
    list_in_progress_unfiltered = [...list_in_progress_unfiltered].sort(cmp);
    list_closed_unfiltered = [...list_closed_unfiltered].sort(cmp);

    list_ready = applyLabelFilter(list_ready_unfiltered);
    list_blocked = applyLabelFilter(list_blocked_unfiltered);
    list_in_progress = applyLabelFilter(list_in_progress_unfiltered);
    list_closed_raw = applyLabelFilter(list_closed_unfiltered);
    applyClosedFilter();
  }

  /**
   * Move an issue locally after the server accepts a status update. Push
   * subscriptions remain authoritative and will reconcile this optimistic view.
   *
   * @param {string} issue_id
   * @param {'open'|'in_progress'|'closed'} new_status
   * @param {string} target_column_id
   * @param {unknown} updated_value
   */
  function applyLocalStatusUpdate(
    issue_id,
    new_status,
    target_column_id,
    updated_value
  ) {
    const fallback_issue = findLocalIssue(issue_id);
    const updated_issue = normalizeIssueLite(
      updated_value,
      fallback_issue,
      issue_id,
      new_status
    );

    optimistic_status_moves.set(issue_id, {
      issue: updated_issue,
      target_column_id
    });
    applyOptimisticMovesToSources();
    recomputeVisibleLists();
    doRender();
  }

  /**
   * Toggle a label in the label filter (add/remove).
   *
   * @param {string} label_name
   */
  function toggleLabelFilter(label_name) {
    const existing_idx = label_filters.findIndex((f) => f.label === label_name);
    if (existing_idx >= 0) {
      // Remove filter
      label_filters = label_filters.filter((f) => f.label !== label_name);
    } else {
      // Add filter with default mode 'include'
      label_filters = [
        ...label_filters,
        { label: label_name, mode: 'include' }
      ];
    }
    if (store) {
      store.setState({ board: { label_filters } });
    }
    refreshFromStores();
  }

  /**
   * Toggle filter mode between include/exclude for a label.
   *
   * @param {string} label_name
   */
  function toggleLabelFilterMode(label_name) {
    const existing = label_filters.find((f) => f.label === label_name);
    if (existing) {
      label_filters = label_filters.map((f) =>
        f.label === label_name
          ? { ...f, mode: f.mode === 'include' ? 'exclude' : 'include' }
          : f
      );
      if (store) {
        store.setState({ board: { label_filters } });
      }
      refreshFromStores();
    }
  }

  /**
   * Toggle label dropdown open/closed state.
   */
  function toggleLabelDropdown() {
    label_dropdown_open = !label_dropdown_open;
    doRender();
  }

  function template() {
    // Use unfiltered lists to get all unique labels (so excluded labels remain visible in dropdown)
    const all_issues_for_labels = [
      ...list_ready_unfiltered,
      ...list_blocked_unfiltered,
      ...list_in_progress_unfiltered,
      ...list_closed_unfiltered
    ];

    return html`
      <div class="board-sort-bar">
        <div class="filter-dropdown ${label_dropdown_open ? 'is-open' : ''}">
          <button
            class="filter-dropdown__trigger"
            @click=${toggleLabelDropdown}
            aria-label="Filter by labels"
            aria-expanded=${label_dropdown_open}
          >
            ${getDropdownDisplayText(label_filters, 'Labels')}
            <span class="filter-dropdown__arrow">▾</span>
          </button>
          <div class="filter-dropdown__menu" role="menu">
            ${getAllUniqueLabels(all_issues_for_labels).map((label) => {
              const filter = label_filters.find((f) => f.label === label);
              const is_active = !!filter;
              const mode = filter?.mode || 'include';

              return html`
                <div class="filter-dropdown__option">
                  <label class="filter-dropdown__option-label">
                    <input
                      type="checkbox"
                      .checked=${is_active}
                      @change=${() => toggleLabelFilter(label)}
                      role="menuitemcheckbox"
                      aria-checked=${is_active}
                    />
                    <span class="filter-dropdown__option-text">${label}</span>
                  </label>
                  ${is_active
                    ? html`
                        <button
                          class="filter-dropdown__mode-toggle"
                          @click=${() => toggleLabelFilterMode(label)}
                          aria-label=${mode === 'include'
                            ? 'Include mode (click to exclude)'
                            : 'Exclude mode (click to include)'}
                          title=${mode === 'include'
                            ? 'Include mode (click to exclude)'
                            : 'Exclude mode (click to include)'}
                        >
                          ${mode === 'include' ? '+' : '−'}
                        </button>
                      `
                    : ''}
                </div>
              `;
            })}
          </div>
        </div>
        <label class="board-sort-selector">
          <span class="board-sort-selector__label">Sort by</span>
          <select
            id="board-sort-order"
            aria-label="Sort order"
            @change=${onSortOrderChange}
          >
            ${Object.entries(SORT_ORDER_LABELS).map(
              ([key, label]) => html`
                <option value=${key} ?selected=${sort_order === key}>
                  ${label}
                </option>
              `
            )}
          </select>
        </label>
      </div>
      <div class="panel__body board-root">
        ${columnTemplate('Blocked', 'blocked-col', list_blocked)}
        ${columnTemplate('Ready', 'ready-col', list_ready)}
        ${columnTemplate('In Progress', 'in-progress-col', list_in_progress)}
        ${columnTemplate('Closed', 'closed-col', list_closed)}
      </div>
    `;
  }

  /**
   * @param {string} title
   * @param {string} id
   * @param {IssueLite[]} items
   */
  function columnTemplate(title, id, items) {
    const item_count = Array.isArray(items) ? items.length : 0;
    const count_label = item_count === 1 ? '1 issue' : `${item_count} issues`;
    return html`
      <section class="board-column" id=${id}>
        <header
          class="board-column__header"
          id=${id + '-header'}
          role="heading"
          aria-level="2"
        >
          <div class="board-column__title">
            <span class="board-column__title-text">${title}</span>
            <span class="badge board-column__count" aria-label=${count_label}>
              ${item_count}
            </span>
          </div>
          ${id === 'closed-col'
            ? html`<label class="board-closed-filter">
                <span class="visually-hidden">Filter closed issues</span>
                <select
                  id="closed-filter"
                  aria-label="Filter closed issues"
                  @change=${onClosedFilterChange}
                >
                  <option
                    value="today"
                    ?selected=${closed_filter_mode === 'today'}
                  >
                    Today
                  </option>
                  <option value="3" ?selected=${closed_filter_mode === '3'}>
                    Last 3 days
                  </option>
                  <option value="7" ?selected=${closed_filter_mode === '7'}>
                    Last 7 days
                  </option>
                </select>
              </label>`
            : ''}
        </header>
        <div
          class="board-column__body"
          role="list"
          aria-labelledby=${id + '-header'}
        >
          ${items.map((it) => cardTemplate(it))}
        </div>
      </section>
    `;
  }

  /**
   * @param {IssueLite} it
   */
  function cardTemplate(it) {
    return html`
      <article
        class="board-card"
        data-issue-id=${it.id}
        role="listitem"
        tabindex="-1"
        draggable="true"
        @click=${(/** @type {MouseEvent} */ ev) => onCardClick(ev, it.id)}
        @dragstart=${(/** @type {DragEvent} */ ev) => onDragStart(ev, it.id)}
        @dragend=${onDragEnd}
      >
        <div class="board-card__title text-truncate">
          ${it.title || '(no title)'}
        </div>
        <div class="board-card__meta">
          ${createTypeBadge(it.issue_type)} ${createPriorityBadge(it.priority)}
          ${createLabelBadges(it.labels)}
          ${createIssueIdRenderer(it.id, { class_name: 'mono' })}
        </div>
      </article>
    `;
  }

  /** @type {string|null} */
  let dragging_id = null;

  /**
   * Handle card click, ignoring clicks during drag operations.
   *
   * @param {MouseEvent} ev
   * @param {string} id
   */
  function onCardClick(ev, id) {
    // Only navigate if this wasn't a drag operation
    if (!dragging_id) {
      gotoIssue(id);
    }
  }

  /**
   * Handle drag start: store issue id in dataTransfer and add dragging class.
   *
   * @param {DragEvent} ev
   * @param {string} id
   */
  function onDragStart(ev, id) {
    dragging_id = id;
    if (ev.dataTransfer) {
      ev.dataTransfer.setData('text/plain', id);
      ev.dataTransfer.effectAllowed = 'move';
    }
    const target = /** @type {HTMLElement} */ (ev.target);
    target.classList.add('board-card--dragging');
    log('dragstart %s', id);
  }

  /**
   * Handle drag end: remove dragging class.
   *
   * @param {DragEvent} ev
   */
  function onDragEnd(ev) {
    const target = /** @type {HTMLElement} */ (ev.target);
    target.classList.remove('board-card--dragging');
    // Clear any highlighted drop target
    clearDropTarget();
    // Clear dragging_id after a short delay to allow click event to check it
    setTimeout(() => {
      dragging_id = null;
    }, 0);
    log('dragend');
  }

  /**
   * Clear the currently highlighted drop target column.
   */
  function clearDropTarget() {
    /** @type {HTMLElement[]} */
    const all_cols = Array.from(
      mount_element.querySelectorAll('.board-column--drag-over')
    );
    for (const c of all_cols) {
      c.classList.remove('board-column--drag-over');
    }
  }

  /**
   * Update issue status via WebSocket transport.
   *
   * @param {string} issue_id
   * @param {'open'|'in_progress'|'closed'} new_status
   * @param {string} target_column_id
   */
  async function updateIssueStatus(issue_id, new_status, target_column_id) {
    if (!transport) {
      log('no transport available, status update skipped');
      showToast('Cannot update status: not connected', 'error');
      return;
    }
    try {
      log('update-status %s → %s', issue_id, new_status);
      const updated = await transport('update-status', {
        id: issue_id,
        status: new_status
      });
      applyLocalStatusUpdate(issue_id, new_status, target_column_id, updated);
      showToast('Status updated', 'success', 1500);
    } catch (err) {
      log('update-status failed: %o', err);
      showToast('Failed to update status', 'error');
    }
  }

  function doRender() {
    render(template(), mount_element);
    postRenderEnhance();
  }

  /**
   * Enhance rendered board with a11y and keyboard navigation.
   * - Roving tabindex per column (first card tabbable).
   * - ArrowUp/ArrowDown within column.
   * - ArrowLeft/ArrowRight to adjacent non-empty column (focus top card).
   * - Enter/Space to open details for focused card.
   */
  function postRenderEnhance() {
    try {
      /** @type {HTMLElement[]} */
      const columns = Array.from(
        mount_element.querySelectorAll('.board-column')
      );
      for (const col of columns) {
        const body = /** @type {HTMLElement|null} */ (
          col.querySelector('.board-column__body')
        );
        if (!body) {
          continue;
        }
        /** @type {HTMLElement[]} */
        const cards = Array.from(body.querySelectorAll('.board-card'));
        // Assign aria-label using column header for screen readers
        const header = /** @type {HTMLElement|null} */ (
          col.querySelector('.board-column__header')
        );
        const col_name = header ? header.textContent?.trim() || '' : '';
        for (const card of cards) {
          const title_el = /** @type {HTMLElement|null} */ (
            card.querySelector('.board-card__title')
          );
          const t = title_el ? title_el.textContent?.trim() || '' : '';
          card.setAttribute(
            'aria-label',
            `Issue ${t || '(no title)'} — Column ${col_name}`
          );
          // Default roving setup
          card.tabIndex = -1;
        }
        if (cards.length > 0) {
          cards[0].tabIndex = 0;
        }
      }
    } catch {
      // non-fatal
    }
  }

  // Delegate keyboard handling from mount_element
  mount_element.addEventListener('keydown', (ev) => {
    const target = ev.target;
    if (!target || !(target instanceof HTMLElement)) {
      return;
    }
    // Do not intercept keys inside editable controls
    const tag = String(target.tagName || '').toLowerCase();
    if (
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      target.isContentEditable === true
    ) {
      return;
    }
    const card = target.closest('.board-card');
    if (!card) {
      return;
    }
    const key = String(ev.key || '');
    if (key === 'Enter' || key === ' ') {
      ev.preventDefault();
      const id = card.getAttribute('data-issue-id');
      if (id) {
        gotoIssue(id);
      }
      return;
    }
    if (
      key !== 'ArrowUp' &&
      key !== 'ArrowDown' &&
      key !== 'ArrowLeft' &&
      key !== 'ArrowRight'
    ) {
      return;
    }
    ev.preventDefault();
    // Column context
    const col = /** @type {HTMLElement|null} */ (card.closest('.board-column'));
    if (!col) {
      return;
    }
    const body = col.querySelector('.board-column__body');
    if (!body) {
      return;
    }
    /** @type {HTMLElement[]} */
    const cards = Array.from(body.querySelectorAll('.board-card'));
    const idx = cards.indexOf(/** @type {HTMLElement} */ (card));
    if (idx === -1) {
      return;
    }
    if (key === 'ArrowDown' && idx < cards.length - 1) {
      moveFocus(cards[idx], cards[idx + 1]);
      return;
    }
    if (key === 'ArrowUp' && idx > 0) {
      moveFocus(cards[idx], cards[idx - 1]);
      return;
    }
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      // Find adjacent column with at least one card
      /** @type {HTMLElement[]} */
      const cols = Array.from(mount_element.querySelectorAll('.board-column'));
      const col_idx = cols.indexOf(col);
      if (col_idx === -1) {
        return;
      }
      const dir = key === 'ArrowRight' ? 1 : -1;
      let next_idx = col_idx + dir;
      /** @type {HTMLElement|null} */
      let target_col = null;
      while (next_idx >= 0 && next_idx < cols.length) {
        const candidate = cols[next_idx];
        const c_body = /** @type {HTMLElement|null} */ (
          candidate.querySelector('.board-column__body')
        );
        const c_cards = c_body
          ? Array.from(c_body.querySelectorAll('.board-card'))
          : [];
        if (c_cards.length > 0) {
          target_col = candidate;
          break;
        }
        next_idx += dir;
      }
      if (target_col) {
        const first = /** @type {HTMLElement|null} */ (
          target_col.querySelector('.board-column__body .board-card')
        );
        if (first) {
          moveFocus(/** @type {HTMLElement} */ (card), first);
        }
      }
      return;
    }
  });

  // Track the currently highlighted column to avoid flicker
  /** @type {HTMLElement|null} */
  let current_drop_target = null;

  // Delegate drag and drop handling for columns
  mount_element.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    if (ev.dataTransfer) {
      ev.dataTransfer.dropEffect = 'move';
    }
    // Find the column being dragged over
    const target = /** @type {HTMLElement} */ (ev.target);
    const col = /** @type {HTMLElement|null} */ (
      target.closest('.board-column')
    );

    // Only update if we've entered a different column
    if (col && col !== current_drop_target) {
      // Remove highlight from previous column
      if (current_drop_target) {
        current_drop_target.classList.remove('board-column--drag-over');
      }
      // Highlight the new column
      col.classList.add('board-column--drag-over');
      current_drop_target = col;
    }
  });

  mount_element.addEventListener('dragleave', (ev) => {
    const related = /** @type {HTMLElement|null} */ (ev.relatedTarget);
    // Only clear if we're leaving the mount element entirely
    if (!related || !mount_element.contains(related)) {
      if (current_drop_target) {
        current_drop_target.classList.remove('board-column--drag-over');
        current_drop_target = null;
      }
    }
  });

  mount_element.addEventListener('drop', (ev) => {
    ev.preventDefault();
    // Clear the drop target highlight
    if (current_drop_target) {
      current_drop_target.classList.remove('board-column--drag-over');
      current_drop_target = null;
    }

    const target = /** @type {HTMLElement} */ (ev.target);
    const col = target.closest('.board-column');
    if (!col) {
      return;
    }

    const col_id = col.id;
    const new_status = COLUMN_STATUS_MAP[col_id];
    if (!new_status) {
      log('drop on unknown column: %s', col_id);
      return;
    }

    const issue_id = ev.dataTransfer?.getData('text/plain');
    if (!issue_id) {
      log('drop without issue id');
      return;
    }

    log('drop %s on %s → %s', issue_id, col_id, new_status);
    void updateIssueStatus(issue_id, new_status, col_id);
  });

  /**
   * @param {HTMLElement} from
   * @param {HTMLElement} to
   */
  function moveFocus(from, to) {
    try {
      from.tabIndex = -1;
      to.tabIndex = 0;
      to.focus();
    } catch {
      // ignore focus errors
    }
  }

  // Sort helpers centralized in app/data/sort.js

  /**
   * Recompute closed list from raw using the current filter and sort.
   */
  function applyClosedFilter() {
    log('applyClosedFilter %s', closed_filter_mode);
    /** @type {IssueLite[]} */
    let items = Array.isArray(list_closed_raw) ? [...list_closed_raw] : [];
    const now = new Date();
    let since_ts = 0;
    if (closed_filter_mode === 'today') {
      const start = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        0,
        0,
        0,
        0
      );
      since_ts = start.getTime();
    } else if (closed_filter_mode === '3') {
      since_ts = now.getTime() - 3 * 24 * 60 * 60 * 1000;
    } else if (closed_filter_mode === '7') {
      since_ts = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    }
    items = items.filter((it) => {
      const s = Number.isFinite(it.closed_at)
        ? /** @type {number} */ (it.closed_at)
        : NaN;
      if (!Number.isFinite(s)) {
        return false;
      }
      return s >= since_ts;
    });
    items.sort(SORT_ORDER_COMPARATORS[sort_order] ?? cmpPriorityThenCreated);
    list_closed = items;
  }

  /**
   * @param {Event} ev
   */
  function onClosedFilterChange(ev) {
    try {
      const el = /** @type {HTMLSelectElement} */ (ev.target);
      const v = String(el.value || 'today');
      closed_filter_mode = v === '3' || v === '7' ? v : 'today';
      log('closed filter %s', closed_filter_mode);
      if (store) {
        try {
          store.setState({ board: { closed_filter: closed_filter_mode } });
        } catch {
          // ignore store errors
        }
      }
      applyClosedFilter();
      doRender();
    } catch {
      // ignore
    }
  }

  /**
   * Handle sort order change from the global selector.
   *
   * @param {Event} ev
   */
  function onSortOrderChange(ev) {
    try {
      const el = /** @type {HTMLSelectElement} */ (ev.target);
      const v = String(el.value || 'most-severe');
      if (v in SORT_ORDER_COMPARATORS) {
        sort_order = /** @type {import('../data/sort.js').SortOrder} */ (v);
      } else {
        sort_order = 'most-severe';
      }
      log('sort order %s', sort_order);
      if (store) {
        try {
          store.setState({ board: { sort_order } });
        } catch {
          // ignore store errors
        }
      }
      refreshFromStores();
    } catch {
      // ignore
    }
  }

  /**
   * Compose lists from subscriptions + issues store and render.
   */
  function refreshFromStores() {
    try {
      if (selectors) {
        const cmp =
          SORT_ORDER_COMPARATORS[sort_order] ?? cmpPriorityThenCreated;
        const in_progress = selectors.selectBoardColumn(
          'tab:board:in-progress',
          'in_progress',
          cmp
        );
        const blocked = selectors.selectBoardColumn(
          'tab:board:blocked',
          'blocked',
          cmp
        );
        const ready_raw = selectors.selectBoardColumn(
          'tab:board:ready',
          'ready',
          cmp
        );
        const closed = selectors.selectBoardColumn(
          'tab:board:closed',
          'closed',
          cmp
        );

        // Ready excludes items that are in progress
        /** @type {Set<string>} */
        const in_prog_ids = new Set(in_progress.map((i) => i.id));
        const ready = ready_raw.filter((i) => !in_prog_ids.has(i.id));

        // Store unfiltered lists for label dropdown (so excluded labels remain visible)
        list_ready_unfiltered = ready;
        list_blocked_unfiltered = blocked;
        list_in_progress_unfiltered = in_progress;
        list_closed_unfiltered = closed;

        applyOptimisticMovesToSources();
        recomputeVisibleLists();
      }
      if (!selectors) {
        recomputeVisibleLists();
      }
      doRender();
    } catch {
      list_ready = [];
      list_blocked = [];
      list_in_progress = [];
      list_closed = [];
      doRender();
    }
  }

  // Live updates: recompose on issue store envelopes
  if (selectors) {
    selectors.subscribe(() => {
      try {
        refreshFromStores();
      } catch {
        // ignore
      }
    });
  }

  return {
    async load() {
      // Compose lists from subscriptions + issues store
      log('load');
      refreshFromStores();
      // If nothing is present yet (e.g., immediately after switching back
      // to the Board and before list-delta arrives), fetch via data layer as
      // a fallback so the board is not empty on initial display.
      try {
        const has_subs = Boolean(subscriptions && subscriptions.selectors);
        /**
         * @param {string} id
         */
        const cnt = (id) => {
          if (!has_subs || !subscriptions) {
            return 0;
          }
          const sel = subscriptions.selectors;
          if (typeof sel.count === 'function') {
            return Number(sel.count(id) || 0);
          }
          try {
            const arr = sel.getIds(id);
            return Array.isArray(arr) ? arr.length : 0;
          } catch {
            return 0;
          }
        };
        const total_items =
          cnt('tab:board:ready') +
          cnt('tab:board:blocked') +
          cnt('tab:board:in-progress') +
          cnt('tab:board:closed');
        const data = /** @type {any} */ (_data);
        const can_fetch =
          data &&
          typeof data.getReady === 'function' &&
          typeof data.getBlocked === 'function' &&
          typeof data.getInProgress === 'function' &&
          typeof data.getClosed === 'function';
        if (total_items === 0 && can_fetch) {
          log('fallback fetch');
          /** @type {[IssueLite[], IssueLite[], IssueLite[], IssueLite[]]} */
          const [ready_raw, blocked_raw, in_prog_raw, closed_raw] =
            await Promise.all([
              data.getReady().catch(() => []),
              data.getBlocked().catch(() => []),
              data.getInProgress().catch(() => []),
              data.getClosed().catch(() => [])
            ]);
          // Normalize and map unknowns to IssueLite shape
          /** @type {IssueLite[]} */
          let ready = Array.isArray(ready_raw) ? ready_raw.map((it) => it) : [];
          /** @type {IssueLite[]} */
          const blocked = Array.isArray(blocked_raw)
            ? blocked_raw.map((it) => it)
            : [];
          /** @type {IssueLite[]} */
          const in_prog = Array.isArray(in_prog_raw)
            ? in_prog_raw.map((it) => it)
            : [];
          /** @type {IssueLite[]} */
          const closed = Array.isArray(closed_raw)
            ? closed_raw.map((it) => it)
            : [];

          // Remove items from Ready that are already In Progress
          /** @type {Set<string>} */
          const in_progress_ids = new Set(in_prog.map((i) => i.id));
          ready = ready.filter((i) => !in_progress_ids.has(i.id));

          // Sort as per active sort order
          const cmp =
            SORT_ORDER_COMPARATORS[sort_order] ?? cmpPriorityThenCreated;
          ready.sort(cmp);
          blocked.sort(cmp);
          in_prog.sort(cmp);
          list_ready_unfiltered = ready;
          list_blocked_unfiltered = blocked;
          list_in_progress_unfiltered = in_prog;
          list_closed_unfiltered = closed;
          applyOptimisticMovesToSources();
          recomputeVisibleLists();
          doRender();
        }
      } catch {
        // ignore fallback errors
      }
    },
    clear() {
      mount_element.replaceChildren();
      list_ready = [];
      list_blocked = [];
      list_in_progress = [];
      list_closed = [];
      list_ready_unfiltered = [];
      list_blocked_unfiltered = [];
      list_in_progress_unfiltered = [];
      list_closed_unfiltered = [];
      list_closed_raw = [];
      optimistic_status_moves.clear();
    }
  };
}
