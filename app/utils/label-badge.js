import { html } from 'lit-html';

/**
 * Generate a color from a string using a simple hash.
 * Returns HSL values for consistent, readable colors.
 *
 * @param {string} str
 * @returns {{ hue: number, saturation: number, lightness: number }}
 */
function hashToColor(str) {
  // Simple hash function
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Convert hash to hue (0-360)
  const hue = Math.abs(hash % 360);

  // Use moderate saturation and lightness for readability
  // Saturation: 60-70% for vibrant but not overwhelming colors
  // Lightness: 75-85% for light backgrounds that work on dark themes
  const saturation = 60 + (Math.abs(hash >> 8) % 11);
  const lightness = 75 + (Math.abs(hash >> 16) % 11);

  return { hue, saturation, lightness };
}

/**
 * Create label badge element with auto-generated color.
 *
 * @param {string} label_name
 * @returns {import('lit-html').TemplateResult}
 */
export function createLabelBadge(label_name) {
  const { hue, saturation, lightness } = hashToColor(label_name);
  const bg_color = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  // Use darker text for light backgrounds
  const text_color = `hsl(${hue}, ${saturation}%, 25%)`;

  return html`<span
    class="label-badge"
    style="background-color: ${bg_color}; color: ${text_color};"
    title="${label_name}"
    >${label_name}</span
  >`;
}

/**
 * Create label badges container for multiple labels.
 * Shows max 3 labels with "..." indicator if more exist.
 *
 * @param {string[] | undefined} labels
 * @returns {import('lit-html').TemplateResult | null}
 */
export function createLabelBadges(labels) {
  if (!labels || labels.length === 0) {
    return null;
  }

  const MAX_VISIBLE = 3;
  const visible_labels = labels.slice(0, MAX_VISIBLE);
  const has_more = labels.length > MAX_VISIBLE;

  return html`${visible_labels.map((label) => createLabelBadge(label))}
  ${has_more
    ? html`<span
        class="label-badge label-badge--more"
        title="${labels.slice(MAX_VISIBLE).join(', ')}"
        >+${labels.length - MAX_VISIBLE}</span
      >`
    : null}`;
}
