/**
 * Ships client-side events (errors, heartbeats, lifecycle) to the backend's
 * /api/client-log endpoint so ops can see widget failures and state without
 * asking a user to open devtools.
 *
 * Every report carries two promoted fields recognised by the backend schema
 * so they're grep-able as top-level log keys:
 *   - session_id  — random per-widget-init UUID; stable for this tab's life
 *   - via_host    — JsSIP UA's random `.invalid` hostname; stable per UA
 *
 * Rate-limited to avoid flooding the server if something loops. Failures to
 * report are swallowed — telemetry must never break the app.
 */

// Default ceiling: 600 reports per minute per widget tab (10/sec sustained).
// High enough that normal telemetry bursts (a page init + a wave of BC traffic
// from sibling tabs + a few state transitions) never get clipped. Override per
// init via `new Reporter({ maxPerMinute: ... })` or `Leadtodeed({ telemetryRateLimit })`.
// The ceiling exists purely as an infinite-loop guard — no server-side cost
// concern at our scale.
const DEFAULT_MAX_PER_MINUTE = 600
const WINDOW_MS = 60_000

export class Reporter {
  constructor({ leadtodeedUrl, auth, sessionId, maxPerMinute }) {
    this._url = `${leadtodeedUrl}/api/client-log`
    this._auth = auth
    this._sessionId = sessionId || null
    this._viaHost = null
    this._maxPerWindow = Number.isFinite(maxPerMinute) && maxPerMinute > 0
      ? Math.floor(maxPerMinute)
      : DEFAULT_MAX_PER_MINUTE
    this._sentTimestamps = []
  }

  /** Set once the SIP UA is constructed. Subsequent reports carry via_host. */
  setViaHost(host) {
    this._viaHost = host || null
  }

  get sessionId() { return this._sessionId }
  get viaHost()   { return this._viaHost }

  report(level, event, message, context = {}) {
    if (!this._allow()) return

    const token = this._auth?.token
    if (!token) return

    const body = JSON.stringify({
      level,
      event,
      session_id: this._sessionId,
      via_host: this._viaHost,
      message: String(message ?? '').slice(0, 500),
      context: {
        ...context,
        url: typeof location !== 'undefined' ? location.href : '',
      },
    })

    try {
      fetch(this._url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
        // keepalive lets the request finish even if the page is unloading,
        // which is exactly what we want for session_end / final-error beats.
        keepalive: true,
      }).catch(() => { /* best-effort */ })
    } catch { /* best-effort */ }
  }

  _allow() {
    const now = Date.now()
    this._sentTimestamps = this._sentTimestamps.filter(t => now - t < WINDOW_MS)
    if (this._sentTimestamps.length >= this._maxPerWindow) return false
    this._sentTimestamps.push(now)
    return true
  }
}
