/**
 * Minimal, privacy-safe user-activity tracker.
 *
 * Captures NOTHING about what the user typed or clicked — only the wall-clock
 * timestamp of the most recent input event. Heartbeats report the integer
 * `min(5, floor((now - lastInput) / 1000))`, which collapses to a coarse
 * "active in the last 5 seconds / idle" signal. That's enough to tell an
 * alive-and-interacting user from a backgrounded-forgotten tab without
 * collecting anything that could fingerprint or reveal behaviour.
 *
 * Events listened to (minimal set that covers desktop + mobile + trackpad):
 *   - `pointerdown` — clicks, taps, stylus down
 *   - `keydown`     — keyboard
 *   - `wheel`       — trackpad scroll / mouse wheel
 *   - `touchstart`  — mobile taps
 *
 * Intentionally NOT listened to:
 *   - `mousemove` — fires thousands of times/sec, feels creepy, and tells us
 *     nothing `pointerdown` doesn't already cover.
 *   - `input`/`change` — could leak content via timing.
 */

const CAP_SECONDS = 5

let lastInputTs = (typeof Date !== 'undefined') ? Date.now() : 0
let installed = false

function touch() { lastInputTs = Date.now() }

/**
 * Register the activity listeners. Idempotent and silently skipped in
 * non-DOM environments (SSR / test runners that don't polyfill document).
 */
export function installActivityTracker() {
  if (installed) return
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
  const opts = { passive: true, capture: true }
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    try { document.addEventListener(ev, touch, opts) } catch { /* ignore */ }
  }
  installed = true
}

/**
 * Integer 0..CAP_SECONDS. 0 means "input happened < 1s ago",
 * CAP_SECONDS means "≥ CAP_SECONDS since last input" — doesn't distinguish
 * 6 seconds from 6 hours.
 */
export function secondsSinceLastInput() {
  const delta = Math.floor((Date.now() - lastInputTs) / 1000)
  if (delta < 0) return 0
  if (delta > CAP_SECONDS) return CAP_SECONDS
  return delta
}
