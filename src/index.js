/**
 * Leadtodeed — pure phone/state library with renderer callback.
 *
 * No built-in UI. The host app provides a `renderer(state)` function
 * that is called on every state change.
 *
 * Usage (ESM via importmap / bundler):
 *   import Leadtodeed from 'leadtodeed-widget'
 *   Leadtodeed({
 *     subdomain: 'acme',
 *     tokenUrl: '/api/leadtodeed/token',
 *     renderer: (state) => updateUI(state),
 *     onIncomingCall: async (number) => fetchCallerInfo(number),
 *   })
 *
 * Usage (IIFE via CDN <script> tag):
 *   <script src="https://cdn.jsdelivr.net/npm/leadtodeed-widget@latest/dist/leadtodeed-widget.iife.js"></script>
 *   <script>Leadtodeed({ subdomain: 'acme', tokenUrl: '/api/leadtodeed/token', renderer: (s) => {} })</script>
 */

import { LeadtodeedPhone } from './phone.js'
import { createCallState, addEvent, transitionPhase } from './state.js'
import { CallEventsSocket } from './call-events-ws.js'
import { LeadershipManager } from './leadership.js'
import { installActivityTracker, secondsSinceLastInput } from './activity.js'
import { detectVersion } from './version.js'

const HEARTBEAT_MS = 30_000
const NEIGHBOR_PING_INTERVAL_MS = 30_000

/**
 * Initialize the Leadtodeed phone library.
 *
 * @param {Object} config
 * @param {string} config.subdomain - Tenant subdomain (e.g. "acme" → https://acme.leadtodeed.ai)
 * @param {string} config.tokenUrl - Token endpoint path
 * @param {Function} [config.renderer] - (state) => void — called on every state change
 * @param {Function} [config.onIncomingCall] - async (callerNumber) => enrichmentData | null
 * @param {string} [config.ringtoneUrl] - URL to an .ogg ringtone played on incoming calls
 * @param {{play: Function, stop: Function}} [config.ringtonePlayer] - Custom ringtone player (overrides ringtoneUrl). Use to play via AudioContext so macOS doesn't show Now Playing.
 * @param {Function} [config.getAudioConstraints] - () => audio getUserMedia constraint (typically `{ deviceId: { exact: '<id>' } }`). Called fresh on every call()/answer() so a host-side mic-picker change applies to the next call. Return nullish to use the browser default.
 * @returns {LeadtodeedPhone} The phone instance
 */
export default function Leadtodeed({
  subdomain,
  tokenUrl,
  renderer = null,
  onIncomingCall = null,
  ringtoneUrl = null,
  ringtonePlayer = null,
  // Max telemetry reports per minute per tab. Default 600 (= 10/sec); set
  // higher for deep debugging, lower if traffic to /api/client-log is hot.
  telemetryRateLimit = undefined,
  getAudioConstraints = null,
} = {}) {
  const state = createCallState()
  const leadtodeedUrl = `https://${subdomain}.leadtodeed.ai`
  let callEventsSocket = null
  let ringtoneAudio = null

  if (ringtonePlayer) {
    // Custom player provided — delegate play/stop to it
    ringtoneAudio = { play: () => ringtonePlayer.play(), pause: () => ringtonePlayer.stop(), currentTime: 0 }
  } else if (ringtoneUrl) {
    ringtoneAudio = new Audio(ringtoneUrl)
    ringtoneAudio.loop = true
  }

  const phone = new LeadtodeedPhone({
    subdomain,
    tokenUrl,
    telemetryRateLimit,
    getAudioConstraints,
    onError: (err) => console.error("[Leadtodeed]", err),
  })

  // Assigned below (after the state/render plumbing it needs); declared here
  // so earlier closures can reference it safely.
  let leadership = null

  function notify() {
    // Leaders broadcast phase transitions to the protocol channel so a
    // deferred candidate can take over the moment a call ends.
    leadership?.onPhaseChange(state.phase)
    if (!renderer) return
    renderer({
      phase: state.phase,
      number: state.number,
      direction: state.direction,
      connectedAt: state.connectedAt,
      muted: state.muted,
      events: state.events,
      participants: state.participants,
      isConference: state.isConference,
      callUuid: state.callUuid,
      accept: () => phone.answer(),
      decline: () => phone.reject(),
      hangup: () => phone.hangup(),
      sendDTMF: (digit) => phone.sendDTMF(digit),
      toggleMute: () => phone.toggleMute(),
      addParticipant: (userId, opts) => _addParticipant(userId, opts),
      cancelInvite: (userId) => _cancelInvite(userId),
      // Live-switch the input device on the active call. No-op when idle —
      // the host should still persist the choice and `getAudioConstraints`
      // will pick it up on the next call/answer.
      setMicrophone: (deviceId) => phone.setMicrophone(deviceId),
    })
  }

  async function _addParticipant(userId, opts) {
    const token = phone._auth?.token
    if (!token) return
    try {
      const body = { target_user_id: userId }
      if (opts?.phone) body.target_user_phone = opts.phone
      if (opts?.name) body.target_user_name = opts.name
      const resp = await fetch(`${leadtodeedUrl}/api/conference/add`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        console.error('[Leadtodeed] addParticipant failed:', resp.status)
        return { status: 'error' }
      }
      // Return the server's outcome so the host can react. status is
      // 'ringing' (normal) or 'busy' (target already on a call — the host
      // shows "<name> is on a call" and drops the optimistic row).
      return await resp.json().catch(() => ({}))
    } catch (e) {
      console.error('[Leadtodeed] addParticipant error:', e)
      return { status: 'error' }
    }
  }

  // Cancel a still-pending conference invite this user just issued.
  // Server is idempotent — a cancel that arrives when no pending invite
  // exists (already joined / already missed / never sent / double-click)
  // is a 200 noop, so the FE doesn't have to reconcile state. UI removal
  // is optimistic and happens in the controller before this fires.
  async function _cancelInvite(userId) {
    const token = phone._auth?.token
    if (!token) return
    try {
      const resp = await fetch(`${leadtodeedUrl}/api/conference/cancel`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ target_user_id: userId }),
      })
      if (!resp.ok) {
        console.error('[Leadtodeed] cancelInvite failed:', resp.status)
      }
    } catch (e) {
      console.error('[Leadtodeed] cancelInvite error:', e)
    }
  }

  function _connectCallEventsWS() {
    const token = phone._auth?.token
    if (!token) return
    // Avoid leaking orphan CallEventsSockets on every SIP re-register. If
    // one exists, tear it down cleanly before opening the new one.
    if (callEventsSocket) {
      try { callEventsSocket.disconnect() } catch { /* ignore */ }
      callEventsSocket = null
    }
    const wsUrl = leadtodeedUrl.replace('https://', 'wss://') + '/api/call/events'
    callEventsSocket = new CallEventsSocket({
      url: wsUrl,
      token,
      reporter: phone.reporter,
      onParticipantJoined: (data) => {
        state.participants = [...state.participants.filter(p => p.user_id !== data.user_id), {
          user_id: data.user_id,
          name: data.name,
          extension: data.extension,
        }]
        state.isConference = state.participants.length > 1
        notify()
      },
      onParticipantLeft: (data) => {
        state.participants = state.participants.filter(p => p.user_id !== data.user_id)
        notify()
      },
      onParticipantInviteFailed: (data) => {
        // Invite resolved without a join (timeout or cancellation). The
        // invitee was never in `participants` — they were a "Connecting…"
        // placeholder in the controller's _pendingParticipants. Clear
        // both to be defensive: if the controller already removed it
        // (optimistic on cancel click), the filters below are no-ops.
        state.participants = state.participants.filter(p => p.user_id !== data.user_id)
        notify()
      },
      onCallEnded: () => {
        // The bridge ended server-side; let the normal SIP callEnded handle phase transition
      },
      onRefresh: (data) => {
        // Server (admin) asked every widget tied to this ext to reload. Log
        // what we're about to do, then reload — but never drop a live call.
        phone.reporter.report('warn', 'got_refresh', data?.reason || '', {
          in_call: phone.isInCall,
          triggered_at: data?.triggered_at || null,
        })
        const doReload = () => {
          try { location.reload() } catch { /* ignore */ }
        }
        if (phone.isInCall) {
          // Deferred path — reload fires once the current call ends.
          phone.on('callEnded', doReload)
        } else {
          doReload()
        }
      },
    })
    callEventsSocket.connect()
  }

  function _stopRingtone() {
    if (ringtoneAudio) {
      ringtoneAudio.pause()
      ringtoneAudio.currentTime = 0
    }
  }

  phone.on('incomingCall', async ({ callerNumber, callUuid, participants: initialParticipants, did, didLabel }) => {
    transitionPhase(state, 'ringing', {
      number: callerNumber, direction: 'incoming', callUuid: callUuid || null,
      did: did || null, didLabel: didLabel || null,
    })
    if (initialParticipants?.length) {
      state.participants = initialParticipants
      state.isConference = true
    }
    if (ringtoneAudio) {
      ringtoneAudio.play().catch(() => {})
    }
    notify()

    if (onIncomingCall) {
      try {
        const enrichment = await onIncomingCall(callerNumber)
        if (enrichment && state.phase !== 'idle') {
          addEvent(state, 'transcript', enrichment)
          notify()
        }
      } catch (e) {
        console.error("[Leadtodeed] onIncomingCall error:", e)
      }
    }
  })

  phone.on('callStarted', ({ number, direction }) => {
    if (direction === 'outgoing') {
      transitionPhase(state, 'ringing', { number, direction })
      notify()
    }
  })

  phone.on('registered', () => {
    // Connect participant events WS on SIP registration so the socket is always up —
    // otherwise server-emitted participant events between bridge setup and SIP connect
    // would be lost. The socket has its own heartbeat + reconnect to stay alive.
    // Leader-only: a candidate REGISTERs moments before its takeover completes;
    // its events WS opens via the onLeader callback right after.
    if (!leadership || leadership.isLeader) _connectCallEventsWS()
  })

  phone.on('callConnected', ({ bridgeId }) => {
    _stopRingtone()
    transitionPhase(state, 'connected', { connectedAt: Date.now() })
    if (bridgeId) state.bridgeId = bridgeId
    notify()
  })

  phone.on('callEnded', () => {
    _stopRingtone()
    transitionPhase(state, 'ended')
    notify()

    setTimeout(() => {
      transitionPhase(state, 'idle')
      notify()
    }, 2000)
  })

  phone.on('muted', ({ muted }) => {
    state.muted = muted
    notify()
  })

  phone.on('event', (event) => {
    state.events.push(event)
    notify()
  })

  // BroadcastChannel for cross-tab sync, wrapped with telemetry logging and
  // a neighbor-count protocol (`bc_hello` / `bc_hello_ack`) that lets the
  // heartbeat know how many other same-origin tabs of this widget exist.
  let channel = null
  const neighborSessions = new Set()    // session_ids of other tabs we've heard from
  let lastNeighborPingAt = 0

  // Extract safe, debuggable fields from a BroadcastChannel message for the
  // telemetry sidecar. Picks ONLY non-PII fields — specifically excludes the
  // `number` and `events` fields of state messages, which carry phone numbers
  // and transcript data. Action messages get the `action` subtype + `digit`
  // (DTMF key, already in Asterisk logs).
  function _bcContext(msg) {
    if (!msg || typeof msg !== 'object') return { msg_type: 'unknown' }
    const ctx = { msg_type: msg.type || 'unknown' }
    if (msg.session_id && msg.session_id !== phone.sessionId) {
      ctx.neighbor_session_id = msg.session_id
    }
    if (msg.type === 'action') {
      if (msg.action) ctx.action = String(msg.action).slice(0, 40)
      if (msg.action === 'sendDTMF' && msg.digit) ctx.digit = String(msg.digit).slice(0, 4)
    } else if (msg.type === 'state') {
      if (msg.phase) ctx.phase = String(msg.phase).slice(0, 40)
      if (msg.direction) ctx.direction = String(msg.direction).slice(0, 20)
      // Explicitly NOT: msg.number, msg.events — those carry PII / transcript.
    }
    return ctx
  }

  function _sendBC(msg) {
    if (!channel) return
    try {
      channel.postMessage(msg)
      phone.reporter.report('info', 'bc_sent', '', _bcContext(msg))
    } catch { /* ignore */ }
  }

  try {
    channel = new BroadcastChannel('leadtodeed-call')
    channel.onmessage = (e) => {
      const msg = e.data || {}
      phone.reporter.report('info', 'bc_received', '', _bcContext(msg))
      // Track neighbors by session_id; evict stale entries in heartbeat.
      if (msg.session_id && msg.session_id !== phone.sessionId) {
        neighborSessions.add(msg.session_id)
      }
      if (msg.type === 'request-state' && state.phase !== 'idle') {
        _sendBC({
          type: 'state',
          session_id: phone.sessionId,
          phase: state.phase,
          number: state.number,
          direction: state.direction,
          connectedAt: state.connectedAt,
          events: state.events,
          callUuid: state.callUuid,
        })
      }
      // Respond to hello with our own session_id so counting converges.
      if (msg.type === 'bc_hello' && msg.session_id !== phone.sessionId) {
        _sendBC({ type: 'bc_hello_ack', session_id: phone.sessionId })
      }
    }
  } catch {
    // BroadcastChannel not available (SSR, old browsers)
  }

  // Tab leadership: only one tab connects to SIP + call-events at a time, and
  // leadership follows the user — a tab they interact with becomes a candidate
  // (second short-lived lock, strictly one at a time), warms a standby
  // transport, and negotiates a make-before-break takeover from an idle
  // leader. Ringing/connected leaders are never displaced while responsive;
  // frozen/dead leaders are stolen from after a grace period. Cross-tab UI
  // sync continues via BroadcastChannel above: the host controller broadcasts
  // state and relays user actions, follower tabs render remotely-pushed state.
  leadership = new LeadershipManager({
    phone,
    getPhase: () => state.phase,
    onLeader: () => _connectCallEventsWS(),
    onFollower: () => {
      // Only the leader may hold the events WS (single-socket budget).
      if (callEventsSocket) {
        try { callEventsSocket.disconnect() } catch { /* ignore */ }
        callEventsSocket = null
      }
    },
  })
  leadership.start()

  // Wrap disconnect so an explicit teardown (pagehide) also releases the
  // leadership locks, letting another tab take over without this tab closing.
  const originalDisconnect = phone.disconnect.bind(phone)
  phone.disconnect = () => {
    leadership.shutdown()
    originalDisconnect()
  }

  // -----------------------------------------------------------------------
  // Telemetry orchestration
  // -----------------------------------------------------------------------
  // Fires session_start now, heartbeats every 30s, visibility_change on
  // foreground/background, bc_hello periodically to count neighbor tabs,
  // and session_end via keepalive-fetch on pagehide.
  //
  // All events carry the stable session_id via the Reporter; via_host is
  // populated by phone.js as soon as SIP connects, so heartbeats after the
  // first ~second include it.

  installActivityTracker()

  // Stamp the lib's own build hash (from the content-addressed URL it
  // loaded from) into every client_log line. The host controller adds
  // its controller_version via the same setStaticContext — the reporter
  // merges both. import.meta.url is rewritten/dropped by bundlers in
  // IIFE output; detectVersion's fallback chain covers those cases.
  phone.reporter.setStaticContext({
    widget_version: detectVersion({
      metaUrl: import.meta.url,
      filename: 'leadtodeed-widget',
      overrideKey: 'widget',
    }),
  })

  phone.reporter.report('info', 'session_start', '', {
    is_leader: leadership.isLeader,
    role: leadership.role,
    is_visible: typeof document !== 'undefined' ? document.visibilityState === 'visible' : null,
    has_focus: typeof document !== 'undefined' ? document.hasFocus() : null,
    ua: typeof navigator !== 'undefined' ? (navigator.userAgent || '').slice(0, 200) : '',
  })

  // Ping neighbors so we can count them on the next heartbeat.
  _sendBC({ type: 'bc_hello', session_id: phone.sessionId })
  lastNeighborPingAt = Date.now()

  const _heartbeat = () => {
    // Re-ping neighbors periodically and evict entries that haven't
    // responded within the ping interval. Prevents stale session_ids from
    // inflating the count forever.
    if (Date.now() - lastNeighborPingAt > NEIGHBOR_PING_INTERVAL_MS) {
      neighborSessions.clear()
      _sendBC({ type: 'bc_hello', session_id: phone.sessionId })
      lastNeighborPingAt = Date.now()
    }

    phone.reporter.report('info', 'heartbeat', '', {
      is_leader: leadership.isLeader,
      role: leadership.role,
      is_visible: typeof document !== 'undefined' ? document.visibilityState === 'visible' : null,
      has_focus: typeof document !== 'undefined' ? document.hasFocus() : null,
      sip_registered: phone.isRegistered,
      seconds_since_last_input: secondsSinceLastInput(),
      neighbor_tabs: neighborSessions.size,
    })
  }
  setInterval(_heartbeat, HEARTBEAT_MS)

  // Visibility / focus transitions — tiny events, mostly useful for
  // correlating WS flaps against "tab went background 4 seconds earlier".
  const _visHandler = () => {
    phone.reporter.report('info', 'visibility_change', '', {
      new_state: document.visibilityState,
    })
  }
  const _focusHandler = () => {
    phone.reporter.report('info', 'focus_change', '', { has_focus: true })
  }
  const _blurHandler = () => {
    phone.reporter.report('info', 'focus_change', '', { has_focus: false })
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', _visHandler)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', _focusHandler)
    window.addEventListener('blur', _blurHandler)
  }

  // Final ping on page unload. `pagehide` is the reliable choice per MDN
  // (beforeunload is flaky on mobile / bfcache). keepalive: true on the
  // underlying fetch lets the POST finish even as the page is unloading.
  const _unloadHandler = (e) => {
    phone.reporter.report('warn', 'session_end', '', {
      reason: e?.persisted ? 'bfcache' : 'unload',
    })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', _unloadHandler)
  }

  return phone
}

export { Leadtodeed, LeadtodeedPhone }
