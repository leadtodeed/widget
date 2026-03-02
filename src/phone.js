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

export class LeadtodeedPhone extends EventEmitter {
  constructor({
    subdomain,
    tokenUrl,
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
    this._callNumber = null
    this._callStartedAt = null
    this._registered = false

    // Wire up callbacks
    if (onRegistered) this.on('registered', onRegistered)
    if (onCallStarted) this.on('callStarted', onCallStarted)
    if (onCallEnded) this.on('callEnded', onCallEnded)
    if (onCallProgress) this.on('callProgress', onCallProgress)
    if (onCallConnected) this.on('callConnected', onCallConnected)
    if (onIncomingCall) this.on('incomingCall', onIncomingCall)
    if (onError) this.on('error', onError)

    this._sip = new SipClient({
      onRegistered: () => {
        this._registered = true
        this.emit('registered')
      },
      onUnregistered: () => {
        this._registered = false
      },
      onRegistrationFailed: (e) => {
        this._registered = false
        this.emit('error', new Error(`SIP registration failed: ${e?.cause || 'unknown'}`))
      },
      onNewSession: (session) => this._handleSession(session),
      onDisconnected: () => {
        this._registered = false
      },
    })
  }

  get isRegistered() {
    return this._registered
  }

  get isInCall() {
    return this._sip.currentSession !== null
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

  _handleSession(session) {
    const direction = session.direction

    if (direction === 'incoming') {
      const remoteIdentity = session.remote_identity
      const callerName = remoteIdentity?.display_name || ''
      const callerNumber = remoteIdentity?.uri?.user || 'Unknown'
      this._callNumber = callerNumber

      this.emit('incomingCall', { callerName, callerNumber })
    }

    session.on('accepted', () => {
      this.emit('callStarted', { number: this._callNumber, direction })
    })

    session.on('progress', () => {
      this.emit('callProgress', { number: this._callNumber })
    })

    session.on('confirmed', () => {
      this._callStartedAt = Date.now()
      this.emit('callConnected', { number: this._callNumber })
    })

    const onEnd = (e) => {
      const duration = this.callDuration
      this._callStartedAt = null
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
