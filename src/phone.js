/**
 * LeadtodeedPhone — Embeddable click-to-call phone widget.
 *
 * A pure event-emitting library with no built-in UI.
 * The host app is responsible for rendering call UI based on events.
 *
 * Events:
 *   registered          — SIP registration succeeded
 *   incomingCall         — { callerName, callerNumber }
 *   callStarted         — { number, direction }
 *   callProgress        — { number } (ringing)
 *   callConnected       — { number }
 *   callEnded           — { number, duration, cause }
 *   error               — Error object
 *
 * Usage:
 *   import { LeadtodeedPhone } from 'leadtodeed-widget'
 *
 *   const phone = new LeadtodeedPhone({
 *     subdomain: 'acme',
 *     tokenUrl: '/api/leadtodeed/token',
 *   })
 *
 *   phone.on('incomingCall', ({ callerName, callerNumber }) => { ... })
 *   phone.on('callStarted', ({ number, direction }) => { ... })
 *   phone.on('callConnected', ({ number }) => { ... })
 *   phone.on('callEnded', ({ number, duration, cause }) => { ... })
 *
 *   await phone.connect()
 *   phone.call('+441234567890')
 *   phone.hangup()
 *   phone.disconnect()
 */

import { EventEmitter } from './events.js'
import { AuthManager } from './auth.js'
import { SipClient } from './sip-client.js'
import { Reporter } from './reporter.js'

// --- SIP registration watchdog ---
//
// With register_expires=60 the UA re-REGISTERs about once a minute, so the
// age of the last successful REGISTER is a liveness probe for the whole SIP
// path: socket + registration + server-side contact. After a tab suspension
// (Safari suspends background tabs wholesale; laptop sleep suspends
// everything) the WebSocket can be a zombie — readyState OPEN while the
// server reaped the contact long ago. JsSIP only discovers that when its
// next REGISTER times out (Timer F, 32s) — longer than a typical Safari
// resume burst — so its built-in recovery can straggle across hours of
// suspend/resume cycles while the extension is unreachable. The watchdog
// short-circuits that: on any wake-up signal (overdue interval tick,
// visibilitychange→visible, pageshow) it checks registration age and, if
// stale, hard-restarts the transport — done in well under a second, i.e.
// within a single awake window.
const WATCHDOG_INTERVAL_MS = 15_000
// A tick arriving this late means the page was suspended. Chrome throttles
// hidden-tab timers to 1/min, so the threshold sits safely above that.
const WATCHDOG_SUSPEND_GAP_MS = 120_000
// Asterisk reaps an idle WSS after ~60s of silence, so ANY suspend longer
// than this leaves a zombie socket no matter how fresh the last REGISTER
// was. The registration-age check alone misses the 60–150s suspend band:
// the watchdog would stand down, JsSIP's flushed refresh timer would
// REGISTER into the dead socket, and the extension stayed deaf for Timer F
// (32s) + up to another age-threshold crossing. Above this gap the socket
// is presumed dead and restarted on wake unconditionally.
const WATCHDOG_SOCKET_DEAD_GAP_MS = 75_000
// ≥2 missed REGISTER refreshes at register_expires=60.
const REGISTRATION_STALE_MS = 150_000
// A transport that has been down this long with no reconnect is not coming
// back on its own — JsSIP's recovery timers are throttled to 1/min in hidden
// tabs and observed to never fire at all after some closes. Without this
// check the watchdog is blind to socket death: a restart whose REGISTER
// succeeds resets the registration age, and when the fresh socket dies
// seconds later the age-based check stands down for the full
// REGISTRATION_STALE_MS while Asterisk holds a 60s contact to a corpse
// (2026-07-30 ext 7172: socket died 1.7s after a successful watchdog
// restart; no reconnect for 2 minutes until the user opened a new tab).
const WATCHDOG_SOCKET_DOWN_MS = 10_000
// Backoff between restarts that fail to bring the registration back — reset
// by the next successful REGISTER.
const WATCHDOG_RESTART_BASE_MS = 30_000
const WATCHDOG_RESTART_MAX_MS = 300_000
// How long a user-initiated dial waits for the revived transport to REGISTER
// before dialling regardless. Deliberately under the call controller's 10s
// no-progress watch: the dial must reach JsSIP while that watch is still
// armed, or the controller paints "Couldn't place call" over a call that is
// in fact about to go out.
const DIAL_REVIVE_TIMEOUT_MS = 6_000

// Generate a random session identifier. Prefer crypto.randomUUID when
// available (all evergreen browsers + HTTPS contexts); otherwise fall back
// to a non-cryptographic 16-char token — session_id is just a correlation
// key in logs, not a credential, so collision resistance is what matters.
function _makeSessionId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch { /* fall through */ }
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

export class LeadtodeedPhone extends EventEmitter {
  constructor({
    subdomain,
    tokenUrl,
    sessionId,
    telemetryRateLimit,
    getAudioConstraints,
    onRegistered,
    onCallStarted,
    onCallEnded,
    onCallProgress,
    onCallConnected,
    onIncomingCall,
    onError,
  } = {}) {
    super()

    if (!subdomain) throw new Error('subdomain is required')
    if (!tokenUrl) throw new Error('tokenUrl is required')

    this._leadtodeedUrl = `https://${subdomain}.leadtodeed.ai`
    this._auth = new AuthManager({ tokenUrl })
    this._sessionId = sessionId || _makeSessionId()
    this._reporter = new Reporter({
      leadtodeedUrl: this._leadtodeedUrl,
      auth: this._auth,
      sessionId: this._sessionId,
      maxPerMinute: telemetryRateLimit,
    })
    this._callNumber = null
    this._callStartedAt = null
    this._registered = false
    this._callUuid = null
    this._bridgeId = null
    this._isConference = false

    // Watchdog state (see constants at the top of this file)
    this._lastRegisteredAt = null
    this._lastWsClosedAt = null
    this._watchdogTimer = null
    this._watchdogVisHandler = null
    this._watchdogPageshowHandler = null
    this._watchdogLastTickAt = 0
    this._watchdogLastRestartAt = 0
    this._watchdogRestartCount = 0
    this._watchdogRestarting = false
    // Bumped by every disconnect() so an in-flight watchdog restart can tell
    // that teardown won the race and must not leave a fresh UA behind.
    this._disconnectEpoch = 0

    // Wire up callbacks
    if (onRegistered) this.on('registered', onRegistered)
    if (onCallStarted) this.on('callStarted', onCallStarted)
    if (onCallEnded) this.on('callEnded', onCallEnded)
    if (onCallProgress) this.on('callProgress', onCallProgress)
    if (onCallConnected) this.on('callConnected', onCallConnected)
    if (onIncomingCall) this.on('incomingCall', onIncomingCall)
    if (onError) this.on('error', onError)

    this._registerCount = 0

    this._sip = new SipClient({
      getAudioConstraints,
      onWsOpened: () => {
        this._lastWsClosedAt = null
        // First opportunity where sip._ua.configuration.via_host is populated.
        // Publish it into the reporter so ALL subsequent events — including
        // heartbeats and error reports — carry this JsSIP UA's stable id.
        const via = this._sip.viaHost
        if (via) this._reporter.setViaHost(via)
        this._reporter.report('info', 'sip_ws_opened', '', { via_host: via })
      },
      onRegistered: () => {
        this._registered = true
        this._lastRegisteredAt = Date.now()
        this._watchdogRestartCount = 0
        this._registerCount += 1
        if (this._registerCount === 1) {
          this._reporter.report('info', 'register_success', '', {
            via_host: this._sip.viaHost,
          })
        } else {
          this._reporter.report('info', 'sip_register_refresh', '', {
            count: this._registerCount,
          })
        }
        this.emit('registered')
      },
      onUnregistered: () => {
        this._registered = false
      },
      onRegistrationFailed: (e) => {
        this._registered = false
        // A failure while the watchdog is mid-restart is the EXPECTED death
        // rattle of the socket being replaced — log it quietly and don't
        // surface it to the host app's console/Sentry as an error.
        const expected = this._watchdogRestarting
        this._reporter.report(expected ? 'info' : 'error', 'sip_registration_failed',
          e?.cause || 'unknown', {
            response: e?.response?.status_code ?? null,
            during_watchdog_restart: expected,
          })
        // Dedicated event first so register() can reject fast; the generic
        // 'error' emit is kept for host apps that surface failures.
        this.emit('registrationFailed', e)
        if (!expected) {
          this.emit('error', new Error(`SIP registration failed: ${e?.cause || 'unknown'}`))
        }
      },
      onNewSession: (session, meta) => this._handleSession(session, meta),
      onDisconnected: (e) => {
        this._registered = false
        this._lastWsClosedAt = Date.now()
        this._reporter.report('warn', 'sip_ws_closed', e?.reason || '', {
          code: e?.code ?? null,
          was_clean: e?.was_clean ?? null,
          duration_ms: e?.duration_ms ?? null,
        })
      },
    })
  }

  /** JsSIP UA's via_host (the `<token>.invalid` hostname), or null before connect. */
  get viaHost() {
    return this._sip?.viaHost || null
  }

  /** Stable random id for this widget instance. Used as the correlation key
   *  across session_start, heartbeat, session_end, and every reporter event. */
  get sessionId() {
    return this._sessionId
  }

  /** Exposed so telemetry orchestration in index.js can emit its own events
   *  without reaching into a private field. */
  get reporter() {
    return this._reporter
  }

  /** Current backend JWT, or null before connect() has fetched one.
   *
   *  Exposed so the host controller can call webrtc_backend's authenticated
   *  APIs (e.g. /api/push/subscriptions) without reaching into `_auth`, which
   *  index.js already does in three places. In-memory only and refreshed on a
   *  timer — a service worker cannot read it, so anything a SW needs must go
   *  through an endpoint that doesn't require it. */
  get token() {
    return this._auth?.token || null
  }

  /** Base URL of this tenant's webrtc_backend (https://{subdomain}.leadtodeed.ai). */
  get backendUrl() {
    return this._leadtodeedUrl
  }

  get isRegistered() {
    return this._registered
  }

  get isInCall() {
    return this._sip.currentSession !== null
  }

  get callUuid() {
    return this._callUuid
  }

  get bridgeId() {
    return this._bridgeId
  }

  get isConference() {
    return this._isConference
  }

  get callDuration() {
    if (!this._callStartedAt) return 0
    return Math.floor((Date.now() - this._callStartedAt) / 1000)
  }

  // `register: false` warms the transport (token + config + WebSocket)
  // without REGISTERing — a leadership candidate's standby mode. Complete
  // with register() at takeover.
  async connect({ register = true } = {}) {
    try {
      await this._auth.fetchToken()
      const config = await this._auth.fetchSipConfig(this._leadtodeedUrl)
      this._sip.connect(config.sip, config.ice_servers, { register })
      this._startWatchdog()
    } catch (e) {
      this.emit('error', e)
      throw e
    }
  }

  /** REGISTER on a warm (connect({register: false})) transport. Resolves on
   *  the 'registered' event; rejects on registrationFailed or timeout so a
   *  takeover attempt over a socket that died while on standby fails fast
   *  instead of hanging. */
  register({ timeoutMs = 10_000 } = {}) {
    if (this._registered) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const onRegistered = () => {
        cleanup()
        resolve()
      }
      const onFailed = (e) => {
        cleanup()
        reject(new Error(`SIP registration failed: ${e?.cause || 'unknown'}`))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('SIP register timeout'))
      }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        this.off('registered', onRegistered)
        this.off('registrationFailed', onFailed)
      }
      this.on('registered', onRegistered)
      this.on('registrationFailed', onFailed)
      this._sip.register()
    })
  }

  /** Tear down the SIP side only — watchdog, socket, registration — keeping
   *  auth (and with it telemetry) alive. Used for leadership handoffs and
   *  candidate aborts; full disconnect() is for page teardown. */
  stopSip() {
    // The epoch bump also cancels any in-flight watchdog restart.
    this._disconnectEpoch += 1
    this._stopWatchdog()
    this._sip.disconnect()
    this._registered = false
    this._lastRegisteredAt = null
  }

  disconnect() {
    this.stopSip()
    this._auth.destroy()
  }

  // --- SIP registration watchdog (see constants at the top of this file) ---

  _startWatchdog() {
    if (this._watchdogTimer) return
    this._watchdogLastTickAt = Date.now()
    this._watchdogTimer = setInterval(() => {
      const now = Date.now()
      const gap = now - this._watchdogLastTickAt
      this._watchdogLastTickAt = now
      // An overdue tick is itself the resume signal: suspended pages fire
      // their missed interval once, immediately on resume.
      this._watchdogCheck(gap > WATCHDOG_SUSPEND_GAP_MS ? 'resume' : 'interval', gap)
    }, WATCHDOG_INTERVAL_MS)
    // The event-driven wake signals measure the sleep gap off the same
    // tick clock WITHOUT resetting it — the interval remains the only
    // writer, so a visible+pageshow+online burst on one resume all see
    // the same gap instead of the first one zeroing it for the rest.
    const gapNow = () => Date.now() - this._watchdogLastTickAt
    if (typeof document !== 'undefined') {
      this._watchdogVisHandler = () => {
        if (document.visibilityState === 'visible') this._watchdogCheck('visible', gapNow())
      }
      document.addEventListener('visibilitychange', this._watchdogVisHandler)
    }
    if (typeof window !== 'undefined') {
      this._watchdogPageshowHandler = () => this._watchdogCheck('pageshow', gapNow())
      window.addEventListener('pageshow', this._watchdogPageshowHandler)
      // Network came back (wifi switch, VPN flap, wake without visibility
      // change) — the old socket is dead by definition.
      this._watchdogOnlineHandler = () => this._watchdogCheck('online', gapNow())
      window.addEventListener('online', this._watchdogOnlineHandler)
    }
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer)
      this._watchdogTimer = null
    }
    if (this._watchdogVisHandler) {
      document.removeEventListener('visibilitychange', this._watchdogVisHandler)
      this._watchdogVisHandler = null
    }
    if (this._watchdogPageshowHandler) {
      window.removeEventListener('pageshow', this._watchdogPageshowHandler)
      this._watchdogPageshowHandler = null
    }
    if (this._watchdogOnlineHandler) {
      window.removeEventListener('online', this._watchdogOnlineHandler)
      this._watchdogOnlineHandler = null
    }
  }

  _watchdogCheck(reason, sleepGapMs = 0) {
    if (!this._watchdogTimer || this._watchdogRestarting) return
    // A live session means the media path is up (the zombie scenario cannot
    // coexist with flowing RTP) — and restarting the UA would kill the call.
    if (this.isInCall) return
    // Until the first REGISTER succeeds, initial-connect failures are
    // JsSIP's to retry; restarting here would loop on bad credentials.
    if (this._lastRegisteredAt === null) return
    const registeredAgoMs = Date.now() - this._lastRegisteredAt
    // Two independent reasons to restart:
    //  - stale registration (the original zombie detector), OR
    //  - a suspend longer than the server's WSS idle reap: the socket is
    //    presumed dead even when the last REGISTER looks fresh. Without
    //    this, a 60–150s sleep woke into JsSIP refreshing over the corpse
    //    and a Timer F (32s) "Request Timeout" before recovery.
    const presumeDead = sleepGapMs > WATCHDOG_SOCKET_DEAD_GAP_MS
    // Third trigger: the transport is verifiably down and stayed down. This
    // is independent of registration age on purpose — a successful restart
    // resets the age, so a socket that dies right after would otherwise put
    // the watchdog back to sleep for REGISTRATION_STALE_MS.
    const socketDown = this._sip.hasUA && !this._sip.isConnected &&
      this._lastWsClosedAt !== null &&
      Date.now() - this._lastWsClosedAt > WATCHDOG_SOCKET_DOWN_MS
    if (!presumeDead && !socketDown && registeredAgoMs < REGISTRATION_STALE_MS) return
    // No network at all (fresh wake from sleep) — cycling the transport now
    // just burns the backoff budget; the next tick retries once online.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    const cooldown = Math.min(
      WATCHDOG_RESTART_BASE_MS * 2 ** this._watchdogRestartCount,
      WATCHDOG_RESTART_MAX_MS
    )
    if (Date.now() - this._watchdogLastRestartAt < cooldown) return
    this._watchdogLastRestartAt = Date.now()
    this._watchdogRestartCount += 1
    this._reporter.report('warn', 'sip_watchdog_stale', reason, {
      registered_ago_ms: registeredAgoMs,
      sleep_gap_ms: Math.round(sleepGapMs),
      presumed_dead: presumeDead,
      socket_down: socketDown,
      // JsSIP's belief — expected to be a stale `true` in the zombie case.
      registered: this._registered,
      restart_count: this._watchdogRestartCount,
    })
    this._watchdogRestart()
  }

  async _watchdogRestart() {
    this._watchdogRestarting = true
    const epoch = this._disconnectEpoch
    try {
      // Hard-drop the (possibly zombie) socket instead of waiting for JsSIP
      // to time out on it, then rebuild from scratch: fresh token, fresh
      // config, fresh WebSocket, fresh REGISTER. Recovery shows up in
      // telemetry as the usual sip_ws_opened + sip_register_refresh, and the
      // 'registered' handler resets the restart backoff.
      this._sip.disconnect()
      await this.connect()
      if (this._disconnectEpoch !== epoch) {
        // disconnect() was called while we were reconnecting (page teardown,
        // leadership release) — honour it instead of leaving a fresh UA
        // registered on a tab that gave up its SIP role.
        this._stopWatchdog()
        this._sip.disconnect()
      }
    } catch (e) {
      this._reporter.report('error', 'sip_watchdog_restart_failed', e?.message || 'unknown', {
        restart_count: this._watchdogRestartCount,
      })
    } finally {
      this._watchdogRestarting = false
    }
  }

  call(number) {
    if (!number) return
    // Defense-in-depth against duplicate dial. SipClient sets _currentSession
    // synchronously inside _ua.call(), so a back-to-back call() in the same
    // tick still trips this. Host apps typically debounce too, but a second
    // layer here means any caller bypassing them can't accidentally issue
    // two INVITEs for one click.
    if (this.isInCall) {
      this._reporter.report('warn', 'duplicate_call_blocked', '', {
        number: this._callNumber || null,
      })
      return
    }

    this._callNumber = number.replace(/[^\d+]/g, '')

    // Dialling into a dead transport is the 2026-08-05 ext 7934/7935
    // pathology: the INVITE goes nowhere, the PBX logs no StasisStart, and
    // the agent gets a button that does nothing. Gate on the SOCKET, not on
    // _registered: that flag is routinely a stale false while the line still
    // works (Asterisk kept those contacts Available throughout), and making
    // every such dial pay for a teardown would trade a broken button for a
    // slow one. A live socket gets its INVITE immediately; only a verifiably
    // down one is worth rebuilding first.
    if (!this._registered && !this._sip.isConnected) {
      this._dialAfterRevive(this._callNumber)
      return
    }

    this._placeInvite()
  }

  _placeInvite() {
    try {
      this._sip.call(this._callNumber)
      this.emit('callStarted', { number: this._callNumber, direction: 'outgoing' })
    } catch (e) {
      this.emit('error', e)
    }
  }

  /** A user-initiated dial outranks the watchdog's backoff ladder. By the
   *  time an agent complains, restart_count has usually climbed far enough
   *  that the cooldown is minutes long (WATCHDOG_RESTART_MAX_MS), so the tab
   *  sits unregistered and every click is silently dropped. The user being
   *  HERE is the strongest evidence this tab is where the phone belongs —
   *  the same reasoning leadership.js already applies to input-driven
   *  candidacy — so rebuild the transport now rather than waiting our turn. */
  async _dialAfterRevive(number) {
    const startedAt = Date.now()
    this._reporter.report('warn', 'dial_revive_started', '', {
      socket_connected: this._sip.isConnected,
      restart_count: this._watchdogRestartCount,
    })
    // This restart is user-driven, not another automatic retry: it must
    // neither be delayed by the ladder nor charged against it.
    this._watchdogRestartCount = 0
    this._watchdogLastRestartAt = Date.now()
    try {
      if (!this._watchdogRestarting) await this._watchdogRestart()
      await this._waitForRegistered(DIAL_REVIVE_TIMEOUT_MS)
    } catch { /* fall through to the unregistered check below */ }

    // The user may have hung up, dialled again, or an inbound call may have
    // landed while we were rebuilding — any of those owns the phone now.
    if (this.isInCall || this._callNumber !== number) {
      this._reporter.report('warn', 'dial_revive_abandoned', '', {
        elapsed_ms: Date.now() - startedAt,
      })
      return
    }
    if (!this._registered) {
      this._reporter.report('error', 'dial_revive_failed', '', {
        elapsed_ms: Date.now() - startedAt,
        socket_connected: this._sip.isConnected,
      })
      // Dial anyway. Asterisk authenticates the INVITE on its own digest and
      // will accept one from a contact it still considers valid, so a stale
      // `registered=false` is not proof the line is dead — and a doomed
      // INVITE is still strictly better than the silent drop it replaced.
      this._placeInvite()
      return
    }
    this._reporter.report('info', 'dial_revive_ok', '', {
      elapsed_ms: Date.now() - startedAt,
    })
    this._placeInvite()
  }

  /** Force an immediate transport rebuild, bypassing the backoff ladder.
   *  For callers outside the watchdog that have their own reason to believe
   *  waiting is pointless — today the sole-tab health gate in leadership.js,
   *  which has no successor to hand the phone to and so must repair in
   *  place. Fire-and-forget: the 'registered' handler resets the backoff. */
  reviveTransport() {
    if (this._watchdogRestarting || this.isInCall) return
    this._watchdogRestartCount = 0
    this._watchdogLastRestartAt = Date.now()
    this._watchdogRestart()
  }

  /** Resolve once REGISTER lands, or after timeoutMs regardless. Polled
   *  rather than event-driven: the 'registered' handler is several layers
   *  down in SipClient and a missed edge here would hang the dial. */
  async _waitForRegistered(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (!this._registered && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    return this._registered
  }

  hangup() {
    this._sip.hangup()
  }

  /** Returns true when a session was actually answered. False means the
   *  ring the user clicked was a ghost — the UI rang (broadcast/state
   *  driven) but this tab holds no SIP session. Loud on purpose: this
   *  exact silence hid the dead-leader pathology for months. */
  answer() {
    const ok = this._sip.answer()
    if (!ok) {
      this._reporter.report('warn', 'accept_no_session', '', {
        registered: this._registered,
      })
    }
    return ok
  }

  reject() {
    this._sip.reject()
  }

  sendDTMF(digit) {
    this._sip.sendDTMF(digit)
  }

  // Mute/unmute are hard no-ops without a live session. Relayed toggleMute
  // actions from the cross-tab UI reach EVERY tab; only the session owner
  // may act. If an idle tab fabricated a 'muted' state change here, its
  // widget would do a local render of phase=idle — which the host controller
  // broadcasts, wiping the call owner's popup mid-call.
  mute() {
    if (!this.isInCall) return
    this._sip.mute()
    this.emit('muted', { muted: true })
  }

  unmute() {
    if (!this.isInCall) return
    this._sip.unmute()
    this.emit('muted', { muted: false })
  }

  toggleMute() {
    if (this._sip.isMuted) {
      this.unmute()
    } else {
      this.mute()
    }
  }

  /**
   * Switch the input microphone for the active call. No-op if there's no
   * call in progress — the next call/answer will pick up whichever device
   * the host's `getAudioConstraints` callback returns at that point.
   *
   * Returns the boolean result from SipClient so callers can flash an
   * error UI when the swap fails (device unplugged, permission revoked).
   */
  setMicrophone(deviceId) {
    return this._sip.setMicrophone(deviceId)
  }

  /**
   * Re-read the host's `getAudioConstraints()` and swap the active call's mic
   * track to match — how a processing-flag toggle (noise suppression etc.)
   * lands mid-call. No-op false without a live session; the next
   * call/answer picks the flags up anyway.
   */
  refreshAudioConstraints() {
    return this._sip.refreshAudioConstraints()
  }

  /** Live call's send codec + applied mic processing settings for telemetry;
   *  null when idle. */
  getAudioPath() {
    return this._sip.getAudioPath()
  }

  get isMuted() {
    return this._sip.isMuted
  }

  addEvent(type, data) {
    const event = {
      id: Date.now() + Math.random(),
      type,
      ts: Date.now(),
      data,
    }
    this.emit('event', event)
    return event
  }

  // --- Simulation API (no SIP required) ---

  simulateIncomingCall({ callerName = 'Test Caller', callerNumber = '+441234567890' } = {}) {
    this._callNumber = callerNumber
    this.emit('incomingCall', { callerName, callerNumber })
    return this
  }

  simulateOutgoingCall(number = '+441234567890') {
    this._callNumber = number.replace(/[^\d+]/g, '')
    this.emit('callStarted', { number: this._callNumber, direction: 'outgoing' })

    setTimeout(() => {
      this.emit('callProgress', { number: this._callNumber })
      setTimeout(() => {
        this._callStartedAt = Date.now()
        this.emit('callConnected', { number: this._callNumber })
      }, 1500)
    }, 500)

    return this
  }

  simulateAnswer() {
    this._callStartedAt = Date.now()
    this.emit('callStarted', { number: this._callNumber, direction: 'incoming' })
    this.emit('callConnected', { number: this._callNumber })
    return this
  }

  simulateEnd(cause = 'completed') {
    const duration = this.callDuration
    this._callStartedAt = null
    this.emit('callEnded', {
      number: this._callNumber,
      duration,
      cause,
    })
    this._callNumber = null
    return this
  }

  _handleSession(session, meta = {}) {
    const direction = session.direction

    // Store call identity + conference metadata from SIP X-headers
    if (meta.callUuid) this._callUuid = meta.callUuid
    if (meta.bridgeId) this._bridgeId = meta.bridgeId
    if (meta.isConference) this._isConference = meta.isConference

    if (direction === 'incoming') {
      const remoteIdentity = session.remote_identity
      const callerName = remoteIdentity?.display_name || ''
      const callerNumber = remoteIdentity?.uri?.user || 'Unknown'
      this._callNumber = callerNumber

      this.emit('incomingCall', {
        callerName, callerNumber,
        callUuid: meta.callUuid || null,
        bridgeId: meta.bridgeId || null,
        isConference: meta.isConference || false,
        participants: meta.participants || [],
        did: meta.did || null,
        didLabel: meta.didLabel || null,
      })
    }

    session.on('accepted', () => {
      this.emit('callStarted', { number: this._callNumber, direction })
    })

    session.on('progress', () => {
      this.emit('callProgress', { number: this._callNumber })
    })

    session.on('confirmed', () => {
      this._callStartedAt = Date.now()
      this.emit('callConnected', { number: this._callNumber, bridgeId: this._bridgeId })
    })

    const onEnd = (e) => {
      const duration = this.callDuration
      this._callStartedAt = null
      this._callUuid = null
      this._bridgeId = null
      this._isConference = false
      this.emit('callEnded', {
        number: this._callNumber,
        duration,
        cause: e?.cause || 'completed',
      })
      this._callNumber = null
    }

    session.on('ended', onEnd)
    session.on('failed', onEnd)
  }
}
