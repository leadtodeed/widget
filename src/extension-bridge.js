/**
 * Extension federation — the page side of the l2d-ext bridge.
 *
 * When the leadtodeed Chrome extension is installed, its offscreen document
 * is a strictly more stable SIP holder than any tab (it survives page
 * refreshes, tab closes, and — with the `background` permission — closing
 * the last window). So an in-page widget that finds a healthy extension
 * running as the SAME identity stops competing for SIP entirely and renders
 * the extension's relayed state instead: the super-leader layer above the
 * same-origin tab election in leadership.js, which stays intact underneath
 * as the automatic fallback when the extension goes away.
 *
 * Transport is window.postMessage to the extension's bridge content script
 * (same-window, origin-checked both ways). BroadcastChannel cannot be used:
 * the extension lives on its own origin.
 *
 * Protocol (all messages carry `source` so the two sides can't mistake
 * their own messages for the peer's):
 *   widget → bridge  {source:'l2d-widget', type:'hello', nonce}
 *   bridge → widget  {source:'l2d-ext-bridge', type:'hello-ack', nonce,
 *                     identity:{sub, displayName, tenant}, healthy,
 *                     registered, version}
 *   bridge → widget  {type:'announce', identity, healthy, registered}
 *                     — unsolicited; extension came up / identity switched
 *   bridge → widget  {type:'state', state}       — serialized call state
 *   bridge → widget  {type:'ext-heartbeat', registered}
 *   bridge → widget  {type:'bye'}                — extension going away
 *   widget → bridge  {source:'l2d-widget', type:'action', action, args}
 *   widget → bridge  {source:'l2d-widget', type:'page-phase', phase, ownSip}
 */

const WIDGET_SOURCE = 'l2d-widget'
const BRIDGE_SOURCE = 'l2d-ext-bridge'

// One hello can race the content script's listener registration (page JS may
// run first); a single retry covers the document_idle injection window.
const PROBE_TIMEOUT_MS = 300
const PROBE_RETRY_DELAY_MS = 700

// The offscreen doc heartbeats every 30s and the bridge relays that. Three
// missed beats with no state traffic means the extension is gone (uninstall
// kills content scripts without a bye).
const BRIDGE_DEAD_MS = 90_000
const DEAD_CHECK_INTERVAL_MS = 30_000

function _isBridgeMessage(e) {
  return e.source === window &&
    e.origin === window.location.origin &&
    e.data && typeof e.data === 'object' &&
    e.data.source === BRIDGE_SOURCE
}

/**
 * One-shot presence probe. Resolves with the bridge's hello-ack payload
 * ({identity, healthy, registered, version}) or null when no extension
 * bridge answers.
 */
export function probeExtension({
  timeoutMs = PROBE_TIMEOUT_MS,
  retryDelayMs = PROBE_RETRY_DELAY_MS,
} = {}) {
  if (typeof window === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    let settled = false
    let retryTimer = null
    let giveupTimer = null

    const finish = (ack) => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMessage)
      clearTimeout(retryTimer)
      clearTimeout(giveupTimer)
      resolve(ack)
    }

    const onMessage = (e) => {
      if (!_isBridgeMessage(e)) return
      const msg = e.data
      if (msg.type !== 'hello-ack' || msg.nonce !== nonce) return
      finish({
        identity: msg.identity || null,
        healthy: !!msg.healthy,
        registered: !!msg.registered,
        version: msg.version || null,
      })
    }

    const sendHello = () => {
      try {
        window.postMessage({ source: WIDGET_SOURCE, type: 'hello', nonce }, window.location.origin)
      } catch { /* ignore */ }
    }

    window.addEventListener('message', onMessage)
    sendHello()
    retryTimer = setTimeout(sendHello, retryDelayMs)
    giveupTimer = setTimeout(() => finish(null), retryDelayMs + timeoutMs)
  })
}

/**
 * Long-lived bridge connection. Constructed once per widget; survives mode
 * flips (a widget that started in normal mode keeps listening for a later
 * `announce`, and a follower keeps listening for `bye`).
 */
export class ExtensionBridge {
  constructor({ onState = null, onAnnounce = null, onBye = null, reporter = null } = {}) {
    this._onState = onState
    this._onAnnounce = onAnnounce
    this._onBye = onBye
    this._reporter = reporter
    this._lastSeenAt = 0
    this._deadTimer = null
    this._disposed = false
    this._lastSentPhase = null

    this._listener = (e) => {
      if (!_isBridgeMessage(e)) return
      this._handle(e.data)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('message', this._listener)
    }
  }

  _handle(msg) {
    if (this._disposed) return
    this._lastSeenAt = Date.now()
    switch (msg.type) {
      case 'state':
        this._onState?.(msg.state || null)
        break
      case 'announce':
        this._onAnnounce?.({
          identity: msg.identity || null,
          healthy: !!msg.healthy,
          registered: !!msg.registered,
        })
        break
      case 'bye':
        this._onBye?.('bye')
        break
      case 'ext-heartbeat':
        break // _lastSeenAt update above is the point
      default:
        break
    }
  }

  /** Start declaring the bridge dead after BRIDGE_DEAD_MS of silence —
   *  armed only in follower mode, where silence means falling back to the
   *  tab election. In normal mode silence is the expected steady state. */
  watchLiveness() {
    if (this._deadTimer) return
    this._lastSeenAt = Date.now()
    this._deadTimer = setInterval(() => {
      if (this._disposed) return
      if (Date.now() - this._lastSeenAt > BRIDGE_DEAD_MS) {
        this._report('warn', 'ext_bridge_dead', '', {
          silent_ms: Date.now() - this._lastSeenAt,
        })
        this.unwatchLiveness()
        this._onBye?.('silent')
      }
    }, DEAD_CHECK_INTERVAL_MS)
  }

  unwatchLiveness() {
    if (this._deadTimer) {
      clearInterval(this._deadTimer)
      this._deadTimer = null
    }
  }

  _post(msg) {
    if (typeof window === 'undefined') return
    try {
      window.postMessage({ source: WIDGET_SOURCE, ...msg }, window.location.origin)
    } catch { /* ignore */ }
  }

  /** Forward a user action to the extension's phone. */
  action(action, args = []) {
    this._post({ type: 'action', action, args })
  }

  /** Report this page's own phase while it owns SIP — the extension defers
   *  its first REGISTER while any page reports a non-idle phase, honouring
   *  never-displace across the page/extension boundary. Deduplicated on
   *  phase so notify()-driven callers can fire it unconditionally. */
  reportPagePhase(phase, ownSip) {
    const key = `${phase}:${ownSip}`
    if (key === this._lastSentPhase) return
    this._lastSentPhase = key
    this._post({ type: 'page-phase', phase, ownSip: !!ownSip })
  }

  _report(level, event, message = '', context = {}) {
    try { this._reporter?.report?.(level, event, message, context) } catch { /* ignore */ }
  }

  dispose() {
    this._disposed = true
    this.unwatchLiveness()
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this._listener)
    }
  }
}

export { WIDGET_SOURCE, BRIDGE_SOURCE, BRIDGE_DEAD_MS }
