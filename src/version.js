/**
 * Build-version detection.
 *
 * Deploys serve the widget files content-addressed
 * (/widget/<sha8>/<name>.js) and a file cannot embed its own hash (it
 * would change the hash), so the version is derived at runtime from the
 * URL the code ACTUALLY loaded from. That's the point: a stale cached
 * build reports its true old hash, which is exactly what fleet-version
 * telemetry needs to show.
 *
 * Non-ESM environments are covered by a fallback chain:
 *   1. window.LEADTODEED_VERSIONS = { widget, controller } — explicit
 *      declaration for fully bundled/inlined setups with no useful URLs.
 *   2. metaUrl — pass import.meta.url from the module entry (bundlers
 *      rewrite or drop it in IIFE output; harmless either way).
 *   3. document.currentScript — classic <script src> loading; captured
 *      during initial synchronous evaluation (it is null afterwards).
 *   4. DOM scan — script[src] and importmap entries whose URL contains
 *      our filename (covers the host page loading us while the code
 *      itself lost its URL to bundling).
 * Nothing matches → "dev".
 */

const HASH_RE = /\/widget\/([0-9a-f]{8})\//

// Must be read during initial synchronous evaluation — see (3) above.
const CURRENT_SCRIPT_SRC =
  typeof document !== 'undefined' ? document.currentScript?.src || null : null

export function detectVersion({ metaUrl = null, filename, overrideKey }) {
  try {
    const override = typeof window !== 'undefined' ? window.LEADTODEED_VERSIONS : null
    if (override && typeof override[overrideKey] === 'string' && override[overrideKey]) {
      return override[overrideKey]
    }
  } catch {
    /* sandboxed window access can throw — keep falling back */
  }

  const candidates = [metaUrl, CURRENT_SCRIPT_SRC]
  try {
    for (const s of document.querySelectorAll('script[src]')) {
      if (s.src.includes(filename)) candidates.push(s.src)
    }
    for (const im of document.querySelectorAll('script[type="importmap"]')) {
      const map = JSON.parse(im.textContent || '{}')
      for (const url of Object.values(map.imports || {})) {
        if (typeof url === 'string' && url.includes(filename)) candidates.push(url)
      }
    }
  } catch {
    /* no DOM (SSR) or malformed importmap — candidates so far still count */
  }

  for (const u of candidates) {
    const m = typeof u === 'string' ? u.match(HASH_RE) : null
    if (m) return m[1]
  }
  return 'dev'
}
