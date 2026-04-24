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
 *     subdomain: 'homey',
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
    this._bridgeId = null
    this._isConference = false

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
      onWsOpened: () => {
        // First opportunity where sip._ua.configuration.via_host is populated.
        // Publish it into the reporter so ALL subsequent events — including
        // heartbeats and error reports — carry this JsSIP UA's stable id.
        const via = this._sip.viaHost
        if (via) this._reporter.setViaHost(via)
        this._reporter.report('info', 'sip_ws_opened', '', { via_host: via })
      },
      onRegistered: () => {
        this._registered = true
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
        this._reporter.report('error', 'sip_registration_failed', e?.cause || 'unknown', {
          response: e?.response?.status_code ?? null,
        })
        this.emit('error', new Error(`SIP registration failed: ${e?.cause || 'unknown'}`))
      },
      onNewSession: (session, meta) => this._handleSession(session, meta),
      onDisconnected: (e) => {
        this._registered = false
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

  get isRegistered() {
    return this._registered
  }

  get isInCall() {
    return this._sip.currentSession !== null
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

  async connect() {
    try {
      await this._auth.fetchToken()
      const config = await this._auth.fetchSipConfig(this._leadtodeedUrl)
      this._sip.connect(config.sip, config.ice_servers)
    } catch (e) {
      this.emit('error', e)
      throw e
    }
  }

  disconnect() {
    this._sip.disconnect()
    this._auth.destroy()
    this._registered = false
  }

  call(number) {
    if (!number) return

    this._callNumber = number.replace(/[^\d+]/g, '')

    try {
      this._sip.call(this._callNumber)
      this.emit('callStarted', { number: this._callNumber, direction: 'outgoing' })
    } catch (e) {
      this.emit('error', e)
    }
  }

  hangup() {
    this._sip.hangup()
  }

  answer() {
    this._sip.answer()
  }

  reject() {
    this._sip.reject()
  }

  sendDTMF(digit) {
    this._sip.sendDTMF(digit)
  }

  mute() {
    this._sip.mute()
    this.emit('muted', { muted: true })
  }

  unmute() {
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

    // Store conference metadata from SIP X-headers
    if (meta.bridgeId) this._bridgeId = meta.bridgeId
    if (meta.isConference) this._isConference = meta.isConference

    if (direction === 'incoming') {
      const remoteIdentity = session.remote_identity
      const callerName = remoteIdentity?.display_name || ''
      const callerNumber = remoteIdentity?.uri?.user || 'Unknown'
      this._callNumber = callerNumber

      this.emit('incomingCall', {
        callerName, callerNumber,
        bridgeId: meta.bridgeId || null,
        isConference: meta.isConference || false,
        participants: meta.participants || [],
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
