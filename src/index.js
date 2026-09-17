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
import { probeExtension, ExtensionBridge } from './extension-bridge.js'

const HEARTBEAT_MS = 30_000
const NEIGHBOR_PING_INTERVAL_MS = 30_000

/**
 * Initialize the Leadtodeed phone library.
 *
 * @param {Object} config
 * @param {string} config.subdomain - Tenant subdomain (e.g. "acme" → https://acme.leadtodeed.ai)
 * @param {string} [config.tokenUrl] - Token endpoint path (this or tokenProvider is required)
 * @param {Function} [config.tokenProvider] - async () => jwt — replaces the tokenUrl fetch in
 *   contexts with their own auth (the extension offscreen document brokers its tokens)
 * @param {boolean} [config.leadership=true] - Same-origin tab election. The extension offscreen
 *   document passes false: it is structurally the only SIP owner in its context, and its
 *   BroadcastChannel/Web Locks would never see a peer anyway (extension origin ≠ page origins)
 * @param {boolean} [config.extensionFederation=true] - Probe for the l2d-ext bridge and, when a
 *   healthy extension runs as the SAME identity (JWT sub), render its relayed state instead of
 *   registering SIP. Falls back to the normal tab election when the extension dies
 * @param {Function} [config.onRefreshRequested] - (data) => void — overrides the location.reload()
 *   the server-initiated refresh performs; the extension recreates its offscreen document instead
 * @param {Object} [config.capabilities] - Injected controller capabilities. Recognized today:
 *   getEnrichment(number) (alias of onIncomingCall), getAddTargets(). Stored on the returned
 *   phone as `phone.capabilities` for controllers; the core never hardcodes tenant endpoints
 * @param {Function} [config.renderer] - (state) => void — called on every state change
 * @param {Function} [config.onIncomingCall] - async (callerNumber) => enrichmentData | null
 * @param {Function} [config.onAnnotationUpdated] - ({call_uuid, version, annotation}) => void — the call's shared annotation changed on the platform (another participant or an automated agent wrote to it). Fired on every widget tied to the call.
 * @param {Function} [config.onInviteFailed] - ({user_id, name, extension, reason}) => void — an add-participant invite resolved without a join. `reason` is "no_answer" (ring timeout) or "cancelled" (inviter withdrew it). Fired on every widget tied to the bridge, not just the inviter's.
 * @param {string} [config.ringtoneUrl] - URL to an .ogg ringtone played on incoming calls
 * @param {{play: Function, stop: Function}} [config.ringtonePlayer] - Custom ringtone player (overrides ringtoneUrl). Use to play via AudioContext so macOS doesn't show Now Playing.
 * @param {Function} [config.getAudioConstraints] - () => audio getUserMedia constraint (typically `{ deviceId: { exact: '<id>' } }`, optionally with echoCancellation/noiseSuppression/autoGainControl flags). Called fresh on every call()/answer() so a host-side mic-picker or processing-toggle change applies to the next call. Return nullish to use the browser default.
 * @returns {LeadtodeedPhone} The phone instance
 */
export default function Leadtodeed({
  subdomain,
  tokenUrl = null,
  tokenProvider = null,
  renderer = null,
  onIncomingCall = null,
  onInviteFailed = null,
  onRefreshRequested = null,
  onAnnotationUpdated = null,
  ringtoneUrl = null,
  ringtonePlayer = null,
  // Max telemetry reports per minute per tab. Default 600 (= 10/sec); set
  // higher for deep debugging, lower if traffic to /api/client-log is hot.
  telemetryRateLimit = undefined,
  getAudioConstraints = null,
  leadership: leadershipEnabled = true,
  extensionFederation = true,
  capabilities = null,
} = {}) {
  const state = createCallState()
  const leadtodeedUrl = `https://${subdomain}.leadtodeed.ai`
  let callEventsSocket = null
  let ringtoneAudio = null

  // getEnrichment is the capability-shaped name for the same hook; the
  // explicit onIncomingCall option wins when both are given.
  if (!onIncomingCall && capabilities?.getEnrichment) {
    onIncomingCall = capabilities.getEnrichment
  }

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
    tokenProvider,
    telemetryRateLimit,
    getAudioConstraints,
    onError: (err) => console.error("[Leadtodeed]", err),
  })

  // Injected controller capabilities travel on the phone so a controller can
  // reach them without new plumbing (`phone.capabilities.getAddTargets`).
  phone.capabilities = { ...(capabilities || {}) }

  // Assigned below (after the state/render plumbing it needs); declared here
  // so earlier closures can reference it safely.
  let leadership = null

  // Extension federation state (see extension-bridge.js). extBridge listens
  // for the extension's messages for the page's whole life; extFollower is
  // set (to the same bridge) only while relaying the extension's state.
  let extBridge = null
  let extFollower = null
  let extIdentity = null

  function notify() {
    // Leaders broadcast phase transitions to the protocol channel so a
    // deferred candidate can take over the moment a call ends.
    leadership?.onPhaseChange(state.phase)
    // The extension defers its first REGISTER while any page tab that owns
    // SIP reports a non-idle phase (never-displace across the boundary).
    extBridge?.reportPagePhase(state.phase, !!leadership?.isLeader)
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
      did: state.did,
      didLabel: state.didLabel,
      outboundClid: state.outboundClid,
      outboundLabel: state.outboundLabel,
      endReason: state.endReason,
      // Identity the extension announced, when one is present but NOT being
      // followed (sub mismatch) — the controller can hint "extension is
      // signed in as <name>". Null when absent or federated.
      extensionIdentity: extFollower ? null : extIdentity,
      viaExtension: false,
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
      // Re-apply the host's getAudioConstraints() to the active call (mic
      // processing-flag toggles). Same idle contract as setMicrophone.
      refreshAudioConstraints: () => phone.refreshAudioConstraints(),
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
        // Invite resolved without a join. `data.reason` is the server's
        // account of why ("no_answer" | "cancelled") — the host labels its
        // retry affordance from it, so pass the payload through verbatim
        // rather than collapsing it to a participants mutation.
        //
        // Host first, then notify: the host's handler is what records the
        // failure, so the render that follows paints the resolved state in
        // one pass instead of flashing an un-resolved row.
        //
        // The invitee was never in `participants` — they were a "Connecting…"
        // placeholder held by the host. The filter is defensive only.
        onInviteFailed?.(data)
        state.participants = state.participants.filter(p => p.user_id !== data.user_id)
        notify()
      },
      onAnnotationUpdated: (data) => {
        // Host-only: nothing about the phone changes when the annotation does.
        try { onAnnotationUpdated?.(data) } catch { /* host callback must not break us */ }
      },
      onCallEnded: () => {
        // The bridge ended server-side; let the normal SIP callEnded handle phase transition
      },
      onOutboundRejected: (data) => {
        // Record WHY only. The SIP rejection that follows drives the phase
        // transition, so this must not touch `phase` — the two race, and a
        // phase change from here would fight the state machine. Survives into
        // the 'ended' render because transitionPhase only clears on 'idle'.
        state.endReason = data?.reason || 'rejected'
        state.outboundClid = data?.clid || state.outboundClid
        notify()
      },
      onRefresh: (data) => {
        // Server (admin) asked every widget tied to this ext to reload. Log
        // what we're about to do, then reload — but never drop a live call.
        phone.reporter.report('warn', 'got_refresh', data?.reason || '', {
          in_call: phone.isInCall,
          triggered_at: data?.triggered_at || null,
        })
        const doReload = () => {
          // The extension overrides this: reloading its offscreen document
          // would come back empty (init arrives by message), so its handler
          // tears down and recreates the document instead.
          if (onRefreshRequested) {
            try { onRefreshRequested(data) } catch { /* host callback must not break us */ }
            return
          }
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

  phone.on('callStarted', ({ number, direction, callerId }) => {
    if (direction === 'outgoing') {
      // The number we ASKED to assert. Replaced by the server's answer on the
      // 183/200 below if it sends one — showing the request in the meantime
      // beats showing nothing while the call rings.
      //
      // Only ever SET, never cleared: callStarted fires twice on an outgoing
      // call — once at dial with the requested clid, and again on the 200 OK,
      // where the session has no clid to report. Treating the second one as
      // "no caller id" wiped a perfectly good value at the moment the call was
      // answered, so a tel: link's ;clid= showed "via <number>" all through
      // ringing and then lost it exactly when the two parties started talking.
      // The state is cleared on idle, which is the only place it should be.
      if (callerId) state.outboundClid = callerId
      transitionPhase(state, 'ringing', { number, direction })
      notify()
    }
  })

  // The server's answer: which line the call actually went out on, and its
  // brand label. Arrives on the first 183, so the "via <brand>" line can paint
  // while the call is still ringing.
  phone.on('callProgress', ({ outboundClid, outboundLabel }) => {
    if (!outboundClid && !outboundLabel) return
    if (outboundClid) state.outboundClid = outboundClid
    if (outboundLabel) state.outboundLabel = outboundLabel
    notify()
  })

  phone.on('registered', () => {
    // Connect participant events WS on SIP registration so the socket is always up —
    // otherwise server-emitted participant events between bridge setup and SIP connect
    // would be lost. The socket has its own heartbeat + reconnect to stay alive.
    // Leader-only: a candidate REGISTERs moments before its takeover completes;
    // its events WS opens via the onLeader callback right after.
    if (!leadership || leadership.isLeader) _connectCallEventsWS()
  })

  phone.on('callConnected', ({ bridgeId, outboundClid, outboundLabel }) => {
    _stopRingtone()
    transitionPhase(state, 'connected', { connectedAt: Date.now() })
    if (bridgeId) state.bridgeId = bridgeId
    if (outboundClid) state.outboundClid = outboundClid
    if (outboundLabel) state.outboundLabel = outboundLabel
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
  //
  // Above that election sits extension federation: a healthy l2d-ext running
  // as the SAME identity outranks every tab (its offscreen document survives
  // refreshes, tab closes, and window closes), so tabs that find one skip the
  // election entirely and render its relayed state. The election below is the
  // fallback layer and starts the moment the extension disappears.
  let torndown = false

  function startLocalLeadership() {
    if (!leadershipEnabled || leadership || extFollower || torndown) return
    leadership = new LeadershipManager({
      phone,
      getPhase: () => state.phase,
      // Health gate: an unregistered leader only self-demotes when a sibling
      // exists to succeed it. The bc_hello census is eventually consistent
      // (30s ping cycle) — good enough, the gate itself waits 60s.
      getNeighborCount: () => neighborSessions.size,
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
  }

  function stopLocalLeadership() {
    if (leadership) {
      leadership.shutdown()
      leadership = null
    }
    // shutdown() releases locks but leaves SIP up (its other caller is page
    // teardown, where disconnect() follows) — here the extension already
    // holds a registration, so drop ours and the events socket explicitly.
    phone.stopSip()
    if (callEventsSocket) {
      try { callEventsSocket.disconnect() } catch { /* ignore */ }
      callEventsSocket = null
    }
  }

  // Render a state snapshot relayed from the extension. Same shape as
  // notify()'s, with the function props dispatching over the bridge —
  // presentation cannot tell who owns SIP.
  function renderExtensionState(s) {
    if (!renderer || !s || !extFollower) return
    renderer({
      ...s,
      extensionIdentity: null,
      viaExtension: true,
      accept: () => extFollower?.action('accept'),
      decline: () => extFollower?.action('decline'),
      hangup: () => extFollower?.action('hangup'),
      sendDTMF: (digit) => extFollower?.action('sendDTMF', [digit]),
      toggleMute: () => extFollower?.action('toggleMute'),
      addParticipant: (userId, opts) => extFollower?.action('addParticipant', [userId, opts]),
      cancelInvite: (userId) => extFollower?.action('cancelInvite', [userId]),
      setMicrophone: (deviceId) => extFollower?.action('setMicrophone', [deviceId]),
      refreshAudioConstraints: () => extFollower?.action('refreshAudioConstraints'),
    })
  }

  function enterFollowerMode() {
    extFollower = extBridge
    extBridge.watchLiveness()
    phone.reporter.report('info', 'ext_follower_mode', '', {
      ext_sub: extIdentity?.sub || null,
    })
    // Snapshot request so a page loaded mid-call paints immediately.
    extBridge.action('request-state')
  }

  // Verify the announced extension identity against our own token's sub.
  // True = follower mode entered. False = mismatch (or no token) — stay on
  // the local path; notify() paints the extensionIdentity hint.
  async function tryAdoptExtension(info) {
    extIdentity = info.identity || null
    try {
      // Follower tabs still need the JWT — for the sub comparison here and
      // for the reporter. AuthManager schedules its own refresh.
      if (!phone.token) await phone._auth.fetchToken()
    } catch {
      return false // token endpoint down — the local path will surface it
    }
    const mySub = phone._auth.sub
    const extSub = info.identity?.sub
    if (!mySub || !extSub || String(mySub) !== String(extSub)) {
      phone.reporter.report('warn', 'ext_identity_mismatch', '', {
        page_sub: mySub || null,
        ext_sub: extSub || null,
      })
      notify()
      return false
    }
    enterFollowerMode()
    return true
  }

  // The extension came up after page load (or switched identity). A leader
  // mid-call is never displaced: wait out the call, then yield. The
  // extension is already registered when it announces (make-before-break —
  // both contacts briefly coexist, which PJSIP's max_contacts permits).
  async function handleAnnounce(info) {
    if (torndown) return
    extIdentity = info.identity || null
    if (extFollower) {
      // Identity switched under us — refuse to keep rendering someone else's
      // phone; fall back and let the mismatch hint explain.
      const mySub = phone._auth.sub
      if (mySub && info.identity?.sub && String(mySub) !== String(info.identity.sub)) {
        handleExtGone('identity_switch')
      }
      return
    }
    if (!info.healthy || !info.registered) {
      notify() // repaint the hint on identity change even when not adopting
      return
    }
    if (phone.isInCall) {
      const onEnd = () => {
        phone.off('callEnded', onEnd)
        handleAnnounce(info)
      }
      phone.on('callEnded', onEnd)
      return
    }
    const adopted = await tryAdoptExtension(info)
    if (adopted) stopLocalLeadership()
  }

  // Follower path collapsed: extension sent bye, went silent past the dead
  // threshold, or switched identity. Resume the normal tab election.
  function handleExtGone(why) {
    if (!extFollower) return
    extFollower = null
    extBridge.unwatchLiveness()
    phone.reporter.report('warn', 'ext_follower_fallback', why || '')
    notify() // repaint from local (idle) state so the last relayed frame doesn't stick
    startLocalLeadership()
  }

  // Public phone methods forward to the extension while federated, so
  // controllers (tel: interception, window.leadtodeedCall) work unchanged.
  const FORWARDED_ACTIONS = [
    'call', 'hangup', 'answer', 'reject', 'sendDTMF',
    'toggleMute', 'mute', 'unmute', 'setMicrophone', 'refreshAudioConstraints',
  ]
  for (const name of FORWARDED_ACTIONS) {
    const orig = phone[name].bind(phone)
    phone[name] = (...args) => {
      if (extFollower) return extFollower.action(name, args)
      return orig(...args)
    }
  }
  const origConnect = phone.connect.bind(phone)
  phone.connect = (...args) => {
    // While federated the extension owns the registration; a host-initiated
    // connect() must not stand up a competing one.
    if (extFollower) return Promise.resolve()
    return origConnect(...args)
  }

  async function initFederation() {
    extBridge = new ExtensionBridge({
      reporter: phone.reporter,
      onState: (s) => renderExtensionState(s),
      onAnnounce: (info) => { handleAnnounce(info) },
      onBye: (why) => handleExtGone(why),
    })
    const ack = await probeExtension()
    if (torndown) return
    if (ack && ack.healthy && await tryAdoptExtension(ack)) return
    startLocalLeadership()
  }

  if (leadershipEnabled) {
    if (extensionFederation && typeof window !== 'undefined') {
      // Async by necessity (the probe is a postMessage round-trip); SIP
      // registration on a cold start is delayed by at most ~1s.
      initFederation()
    } else {
      startLocalLeadership()
    }
  }
  // leadership === false (the extension's own offscreen document): no
  // election, no federation — the host drives connect() directly.

  // Wrap disconnect so an explicit teardown (pagehide) also releases the
  // leadership locks, letting another tab take over without this tab closing.
  const originalDisconnect = phone.disconnect.bind(phone)
  phone.disconnect = () => {
    torndown = true
    extBridge?.dispose()
    extBridge = null
    extFollower = null
    leadership?.shutdown()
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

  // Role for telemetry when no LeadershipManager exists: the extension's
  // offscreen doc is the sole owner; a federated tab is an ext_follower; a
  // tab whose federation probe is still in flight reads as follower.
  const _telemetryRole = () => {
    if (leadership) return leadership.role
    if (extFollower) return 'ext_follower'
    return leadershipEnabled ? 'follower' : 'sole'
  }

  phone.reporter.report('info', 'session_start', '', {
    is_leader: !!leadership?.isLeader,
    role: _telemetryRole(),
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
      is_leader: !!leadership?.isLeader,
      role: _telemetryRole(),
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
// Bridge primitives, exported for the l2d-ext content script (which speaks
// the other half of the same protocol) and for host-app diagnostics.
export { probeExtension, ExtensionBridge, WIDGET_SOURCE, BRIDGE_SOURCE } from './extension-bridge.js'
