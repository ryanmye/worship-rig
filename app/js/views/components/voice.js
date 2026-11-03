// The page's voice (v11-polish): shared/voice.js words for the theme on html[data-theme], and a change hook so a
// view re-renders its strings when the theme switches (boot.js / main.js applyTheme set the attribute).
import { voiceText, voiceOf } from '../../shared/voice.js';

const listeners = new Set();
let observer = null;
let lastVoice = null;

const themeNow = () => (typeof document === 'undefined' ? null : document.documentElement.dataset.theme || null);

/**
 * The current theme's words for `key` (shared/voice.js VOICE_KEYS).
 * @param {string} key
 * @param {Record<string, any>} [vars]
 * @returns {string|null}
 */
export function say(key, vars) {
  return voiceText(themeNow(), key, vars);
}

/** @returns {string} the current voice id ('classic', 'sanctuary', …) */
export function currentVoice() {
  return voiceOf(themeNow());
}

/**
 * Call `cb` whenever the page's voice changes (a switch between themes of one voice, e.g. Daylight Stage ↔ Day,
 * calls nothing). One MutationObserver for the page, made on first use.
 * @param {() => void} cb
 * @returns {() => void} unsubscribe
 */
export function onVoiceChange(cb) {
  listeners.add(cb);
  if (!observer && typeof MutationObserver === 'function' && typeof document !== 'undefined') {
    lastVoice = currentVoice();
    observer = new MutationObserver(() => {
      const v = currentVoice();
      if (v === lastVoice) return;
      lastVoice = v;
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch (err) {
          console.warn('[ui] voice listener failed:', err);
        }
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && observer) {
      observer.disconnect();
      observer = null;
    }
  };
}
