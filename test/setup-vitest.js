/* global console, window */
import { afterEach } from 'vitest';

/**
 * Create an in-memory Storage implementation for jsdom runs where
 * `window.localStorage` is unavailable or incomplete.
 *
 * @returns {Storage}
 */
function createMemoryStorage() {
  /** @type {Map<string, string>} */
  const items = new Map();
  return /** @type {Storage} */ ({
    get length() {
      return items.size;
    },
    /** @param {number} index */
    key(index) {
      return Array.from(items.keys())[index] ?? null;
    },
    /** @param {string} key */
    getItem(key) {
      return items.get(String(key)) ?? null;
    },
    /** @param {string} key */
    removeItem(key) {
      items.delete(String(key));
    },
    /**
     * @param {string} key
     * @param {string} value
     */
    setItem(key, value) {
      items.set(String(key), String(value));
    },
    clear() {
      items.clear();
    }
  });
}

function ensureLocalStorage() {
  try {
    if (typeof window.localStorage?.setItem === 'function') {
      return;
    }
  } catch {
    // Replace inaccessible storage below.
  }
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: createMemoryStorage()
  });
}

ensureLocalStorage();

afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // ignore storage cleanup errors
  }
});

// Suppress Lit dev-mode warning in Vitest
// Provided snippet: overrides console.warn but forwards all other messages
const { warn } = console;
console.warn = /** @type {function(...*): void} */ (
  (...args) => {
    // Filter out the noisy Lit dev-mode banner in tests
    const message = String(args[0] ?? '');
    if (!message.startsWith('Lit is in dev mode.')) {
      warn.call(console, ...args);
    }
  }
);
