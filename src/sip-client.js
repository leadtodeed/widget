/**
 * JsSIP wrapper with SDP/ICE patches for Asterisk WebRTC.
 * Extracted and cleaned up from leadtodeed's app.js.j2.
 */
import JsSIP from 'jssip'

const ICE_GATHERING_TIMEOUT = 1000

// Dev-tenant only. Hostnames there always carry a `localhost` label
// (localhost.leadtodeed.ai, collective-london.localhost.leadtodeed.ai); prod
// (homey.leadtodeed.ai, *.homey.co.uk) never does. `window.LEADTODEED_DEBUG =
// true` force-enables it anywhere.
const isDebugHost = () => {
  if (typeof window === 'undefined') return false
  if (window.LEADTODEED_DEBUG === true) return true
  return /(^|\.)localhost(\.|$)/i.test(window.location?.hostname || '')
}

/**
 * Dump the X-headers of an incoming INVITE, on the wire and as parsed.
 *
 * These headers are the hardest thing in the system to debug, because every
 * failure is silent: each read is optional-chained to null, so "the PBX never
 * sent it", "I read it off the wrong object" and "it arrived and was empty" all
 * look identical downstream. Two stacked bugs hid here for months —
 * PJSIP_HEADER() no-oping on the Local channel (nothing sent) and
 * `session.request` being undefined in JsSIP 3.x (nothing read). This prints
 * both halves side by side so they can never be confused again:
 *
 *   - RAW  = what actually arrived on the wire (from the SIP message text)
 *   - READ = what getHeader() returned
 *
 * RAW populated + READ null  → client-side read bug (wrong object/name).
 * RAW empty                  → PBX side: check [meowgent-callee-headers] ran
 *                              and the __X_* vars were inherited.
 */
function debugInviteHeaders(e, parsed) {
  try {
    const request = e.request
    const raw = typeof request?.data === 'string' ? request.data : ''
    const wire = raw
      .split(/\r?\n/)
      .filter(line => /^X-/i.test(line))
      .map(line => line.trim())

    const ok = Boolean(parsed.callUuid)
    console.groupCollapsed(
      `[Leadtodeed] INVITE X-headers — callUuid ${ok ? 'OK' : 'MISSING'}`
    )
    if (!request) {
      console.error(
        'e.request is undefined — cannot read any header. JsSIP 3.x RTCSession ' +
        'has no `request` getter; the INVITE is on the EVENT, not the session.'
      )
    }
    console.log('RAW on the wire:', wire.length ? wire : '(no X- headers at all)')
    console.log('READ via getHeader():', {
      'X-Call-Uuid': parsed.callUuid,
      'X-Bridge-Id': parsed.bridgeId,
      'X-Conference': parsed.isConference,
      'X-Participants-B64': parsed.participants,
    })
    if (wire.length && !ok) {
      console.warn(
        'Header IS on the wire but did not parse → client-side read bug.'
      )
    } else if (!wire.length) {
      console.warn(
        'No X- headers on the wire → PBX side. Check that the Dial in ' +
        '[meowgent-dial-contacts] carries b(meowgent-callee-headers^s^1) and ' +
        'that ARI/webrtc_backend set the __X_* inherited variables.'
      )
    }
    console.groupEnd()
  } catch {
    /* debug output must never break call setup */
  }
}

/**
 * Patch RTCPeerConnection to force ICE gathering completion after timeout.
 * Asterisk WebRTC can take too long to gather ICE candidates.
 */
function patchIceGathering() {
  if (window._leadtodeedIcePatched) return
  window._leadtodeedIcePatched = true

  const OrigPeerConnection = window.RTCPeerConnection
  window.RTCPeerConnection = function (config, constraints) {
    const pc = new OrigPeerConnection(config, constraints)

    let gatheringTimer = null
    let forceComplete = false

    const origGatheringState = Object.getOwnPropertyDescriptor(
      OrigPeerConnection.prototype,
      'iceGatheringState'
    )

    Object.defineProperty(pc, 'iceGatheringState', {
      get() {
        return forceComplete ? 'complete' : origGatheringState.get.call(this)
      },
    })

    const origSetLocalDescription = pc.setLocalDescription.bind(pc)
    pc.setLocalDescription = function (desc) {
      const result = origSetLocalDescription(desc)
      const realState = origGatheringState.get.call(pc)
      if (!forceComplete && realState !== 'complete') {
        gatheringTimer = setTimeout(() => {
          if (!forceComplete) {
            forceComplete = true
            pc.dispatchEvent(new Event('icegatheringstatechange'))
          }
        }, ICE_GATHERING_TIMEOUT)
      }
      return result
    }

    pc.addEventListener('icegatheringstatechange', () => {
      const realState = origGatheringState.get.call(pc)
      if (realState === 'complete' && gatheringTimer) {
        clearTimeout(gatheringTimer)
        gatheringTimer = null
      }
    })

    return pc
  }
  window.RTCPeerConnection.prototype = OrigPeerConnection.prototype
}

/**
 * Patch RTCPeerConnection.setRemoteDescription to fix Asterisk's recvonly SDP bug
 * and add missing ICE credentials when needed.
 */
function patchSdpRemoteDescription() {
  if (window._leadtodeedSdpPatched) return
  window._leadtodeedSdpPatched = true

  const origSetRemoteDescription = RTCPeerConnection.prototype.setRemoteDescription
  RTCPeerConnection.prototype.setRemoteDescription = function (description) {
    let sdp = description.sdp
    let modified = false

    if (sdp.includes('recvonly')) {
      sdp = sdp.replace(/a=recvonly/g, 'a=sendrecv')
      modified = true
    }

    if (!sdp.includes('ice-ufrag') || !sdp.includes('ice-pwd')) {
      const iceUfrag = Math.random().toString(36).substring(2, 10)
      const icePwd =
        Math.random().toString(36).substring(2) +
        Math.random().toString(36).substring(2) +
        Math.random().toString(36).substring(2)

      let remoteIP = ''
      let remotePort = ''
      const cMatch = sdp.match(/c=IN IP4 ([0-9.]+)/)
      const mMatch = sdp.match(/m=audio ([0-9]+)/)
      if (cMatch) remoteIP = cMatch[1]
      if (mMatch) remotePort = mMatch[1]

      const lines = sdp.split('\r\n')
      const newLines = []
      let iceAdded = false

      for (const line of lines) {
        newLines.push(line)
        if (line.startsWith('a=fingerprint:') && !iceAdded) {
          newLines.push('a=ice-ufrag:' + iceUfrag)
          newLines.push('a=ice-pwd:' + icePwd)
          newLines.push('a=ice-options:ice-lite')
          if (remoteIP && remotePort) {
            newLines.push(
              'a=candidate:1 1 UDP 2130706431 ' + remoteIP + ' ' + remotePort + ' typ host'
            )
          }
          iceAdded = true
        }
      }
      sdp = newLines.join('\r\n')
      modified = true
    }

    if (modified) {
      description = new RTCSessionDescription({ type: description.type, sdp })
    }

    return origSetRemoteDescription.apply(this, [description])
  }
}

/**
 * Patch JsSIP Grammar.parse to fix recvonly before JsSIP parses SDP.
 */
function patchJsSipGrammar() {
  const origParse = JsSIP.Grammar.parse
  JsSIP.Grammar.parse = function (input, startRule) {
    if (typeof input === 'string' && input.includes('a=recvonly')) {
      input = input.replace(/a=recvonly/g, 'a=sendrecv')
    }
    return origParse.call(this, input, startRule)
  }
}

export class SipClient {
  constructor({ onRegistered, onUnregistered, onRegistrationFailed, onNewSession, onDisconnected, onWsOpened, getAudioConstraints }) {
    this._ua = null
    this._currentSession = null
    this._remoteAudio = null
    this._iceServers = []
    this._sipConfig = null
    this._callbacks = { onRegistered, onUnregistered, onRegistrationFailed, onNewSession, onDisconnected, onWsOpened }
    // Host-supplied callback returning the `audio` value for getUserMedia /
    // JsSIP mediaConstraints — typically `{ deviceId: { exact: '<id>' } }`
    // when the user has picked a specific microphone, or undefined to fall
    // back to the browser default. Called fresh at every call()/answer() so
    // a localStorage change takes effect on the next call.
    this._getAudioConstraints = typeof getAudioConstraints === 'function' ? getAudioConstraints : null
  }

  /**
   * Resolve the `audio` constraint for getUserMedia. Returns either an object
   * (when the host has nominated a specific device) or `true` (browser default).
   * The host callback is allowed to throw / return nullish — we fall back to
   * default audio so a busted picker never blocks a call.
   */
  _audioConstraint() {
    if (!this._getAudioConstraints) return true
    try {
      const c = this._getAudioConstraints()
      if (c && typeof c === 'object' && Object.keys(c).length) return c
    } catch {
      /* host picker threw — fall back to default device */
    }
    return true
  }

  get isRegistered() {
    return this._ua ? this._ua.isRegistered() : false
  }

  get currentSession() {
    return this._currentSession
  }

  /**
   * JsSIP's random `<token>.invalid` used as Via host — stable for this UA's
   * life. Matches the `x-ast-orig-host=<token>.invalid` parameter in the
   * contact URI that Asterisk stores per-AOR, so it's the join key between
   * widget-side telemetry and server-side AOR state.
   */
  get viaHost() {
    return this._ua?.configuration?.via_host || null
  }

  // `register: false` connects the WebSocket without REGISTERing — used by a
  // leadership candidate warming up its transport; register() completes the
  // takeover later.
  connect(sipConfig, iceServers, { register = true } = {}) {
    // Apply patches once
    patchIceGathering()
    patchSdpRemoteDescription()
    patchJsSipGrammar()

    this._sipConfig = sipConfig
    this._iceServers = iceServers

    const socket = new JsSIP.WebSocketInterface(sipConfig.wss_url)

    const configuration = {
      sockets: [socket],
      uri: `sip:${sipConfig.extension}@${sipConfig.sip_domain}`,
      password: sipConfig.sip_password,
      display_name: sipConfig.display_name,
      register,
      register_expires: 60,
      session_timers: false,
    }

    this._ua = new JsSIP.UA(configuration)
    this._wsOpenedAt = null

    this._ua.on('connected', () => {
      this._wsOpenedAt = Date.now()
      this._callbacks.onWsOpened?.()
    })
    this._ua.on('registered', () => this._callbacks.onRegistered?.())
    this._ua.on('unregistered', () => this._callbacks.onUnregistered?.())
    this._ua.on('registrationFailed', (e) => this._callbacks.onRegistrationFailed?.(e))
    this._ua.on('disconnected', (e) => {
      // `disconnected` fires with a reason/code object on abrupt closes.
      // Pass through so callers can report code/reason/duration.
      const durationMs = this._wsOpenedAt ? (Date.now() - this._wsOpenedAt) : null
      this._wsOpenedAt = null
      this._callbacks.onDisconnected?.({
        code: e?.code ?? null,
        reason: e?.reason ?? null,
        was_clean: typeof e?.wasClean === 'boolean' ? e.wasClean : null,
        duration_ms: durationMs,
      })
    })
    this._ua.on('newRTCSession', (e) => this._handleNewSession(e))

    this._ua.start()
  }

  disconnect() {
    this._destroyAudioElement()
    if (this._currentSession) {
      try { this._currentSession.terminate() } catch { /* ignore termination errors */ }
      this._currentSession = null
    }
    if (this._ua) {
      this._ua.stop()
      this._ua = null
    }
  }

  /** REGISTER on the already-connected UA (candidate takeover after a
   *  connect({register: false}) warm-up). JsSIP keeps auto-refreshing after
   *  a manual register(), same as register: true.
   *
   *  connect() only *initiates* the WebSocket — registering before the
   *  transport is up makes JsSIP fail the transaction immediately with
   *  "Connection Error". Defer until the UA reports connected. */
  register() {
    const ua = this._ua
    if (!ua) return
    if (ua.isConnected()) {
      ua.register()
      return
    }
    if (this._pendingRegister) return
    this._pendingRegister = true
    ua.once('connected', () => {
      this._pendingRegister = false
      // The UA may have been stopped while we waited (candidacy aborted).
      try { this._ua?.register() } catch { /* transport raced away */ }
    })
  }

  call(number) {
    if (!this._ua || !this._ua.isRegistered()) {
      throw new Error('Not registered')
    }

    const options = {
      mediaConstraints: { audio: this._audioConstraint(), video: false },
      pcConfig: {
        iceServers: this._iceServers,
        iceCandidatePoolSize: 10,
        iceTransportPolicy: 'all',
      },
      rtcOfferConstraints: {
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      },
    }

    this._currentSession = this._ua.call(
      `sip:${number}@${this._sipConfig.sip_domain}`,
      options
    )
  }

  hangup() {
    if (this._currentSession) {
      this._currentSession.terminate()
    }
  }

  answer() {
    if (!this._currentSession) return

    const options = {
      mediaConstraints: { audio: this._audioConstraint(), video: false },
      pcConfig: {
        iceServers: this._iceServers,
        iceCandidatePoolSize: 10,
        iceTransportPolicy: 'all',
      },
    }

    this._currentSession.answer(options)
  }

  /**
   * Live-switch the microphone used by the current SIP session, if any. Pulls
   * a new MediaStream from getUserMedia and swaps it into the audio sender
   * via replaceTrack() — the call's signalling/SDP is untouched, only the
   * upstream track changes.
   *
   * Returns `true` if the swap succeeded, `false` if there's no active session,
   * no audio sender, or getUserMedia rejected (e.g. device disappeared).
   *
   * JsSIP 3.x mute operates on `sender.track.enabled`, so subsequent
   * mute()/unmute() calls continue to work after the swap without touching
   * `session._localMediaStream`. Mute state is preserved by mirroring the
   * old track's `enabled` flag onto the new track before replaceTrack.
   *
   * `deviceId` may be falsy/'default' — that yields `{ audio: true }` and lets
   * the browser pick its current default device.
   */
  async setMicrophone(deviceId) {
    if (!this._currentSession || !this._currentSession.connection) return false
    const pc = this._currentSession.connection
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio')
    if (!sender) return false

    const audioConstraint = deviceId && deviceId !== 'default'
      ? { deviceId: { exact: deviceId } }
      : true
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false })
    } catch {
      return false
    }
    const newTrack = stream.getAudioTracks()[0]
    if (!newTrack) return false

    const oldTrack = sender.track
    // Preserve mute: enabled=false on the old track means the user had
    // muted; the new track must come up in the same state or the swap
    // would silently un-mute mid-call.
    if (oldTrack) newTrack.enabled = oldTrack.enabled

    try {
      await sender.replaceTrack(newTrack)
    } catch {
      // Roll back: stop the unused new track so the mic indicator goes away.
      try { newTrack.stop() } catch { /* ignore */ }
      return false
    }

    // Release the previous mic so the OS indicator clears and the device
    // can be picked up by another tab/app.
    if (oldTrack && oldTrack !== newTrack) {
      try { oldTrack.stop() } catch { /* ignore */ }
    }
    return true
  }

  reject() {
    if (this._currentSession) {
      this._currentSession.terminate({ status_code: 486, reason_phrase: 'Busy Here' })
    }
  }

  sendDTMF(digit) {
    if (this._currentSession) {
      this._currentSession.sendDTMF(digit)
    }
  }

  mute() {
    if (this._currentSession) {
      this._currentSession.mute({ audio: true })
    }
  }

  unmute() {
    if (this._currentSession) {
      this._currentSession.unmute({ audio: true })
    }
  }

  get isMuted() {
    return this._currentSession ? this._currentSession.isMuted().audio : false
  }

  _handleNewSession(e) {
    const session = e.session
    this._currentSession = session

    // Read X-headers from the incoming SIP INVITE. These are set by the
    // [meowgent-callee-headers] pre-dial handler on the PBX — NOT by the ARI /
    // backend originate, whose PJSIP_HEADER() writes land on a Local channel
    // and silently no-op. callUuid identifies the call across surfaces (page
    // notification tag, Web Push payload, pull-answer matching).
    //
    // The INVITE comes off the EVENT, not the session. JsSIP 3.x RTCSession
    // keeps it as the private `_request` and exposes no `request` getter
    // (getters: causes/id/connection/contact/direction/local_identity/
    // remote_identity/start_time/end_time/data/status), so `session.request` is
    // undefined and every getHeader() below optional-chains silently to null.
    // `_newRTCSession()` emits {originator, session, request} — use e.request.
    const request = e.request
    const callUuid = request?.getHeader?.('X-Call-Uuid') || null
    const bridgeId = request?.getHeader?.('X-Bridge-Id') || null
    const isConference = request?.getHeader?.('X-Conference') === 'true'
    // Which line the customer dialed. The label is base64 for the same
    // reason X-Participants is: it's free text (spaces today, maybe commas
    // or non-ASCII tomorrow) and must survive the dialplan's Set() argument
    // parsing. TextDecoder, not bare atob — atob yields latin1.
    const did = request?.getHeader?.('X-Did') || null
    let didLabel = null
    try {
      const rawLabel = request?.getHeader?.('X-Did-Label-B64')
      if (rawLabel) {
        const bytes = Uint8Array.from(atob(rawLabel), c => c.charCodeAt(0))
        didLabel = new TextDecoder().decode(bytes) || null
      }
    } catch { /* ignore malformed header */ }
    let participants = []
    try {
      // Base64, not raw JSON: JSON can't traverse the dialplan safely (its
      // quotes break ast_expr2, its colons break ExecIf's branch split), and
      // its commas collide with SIP's list-header separator. Decode via
      // TextDecoder rather than JSON.parse(atob(...)) — atob yields latin1, so
      // the naive form mangles any non-ASCII name ("Renée").
      const raw = request?.getHeader?.('X-Participants-B64')
      if (raw) {
        const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0))
        participants = JSON.parse(new TextDecoder().decode(bytes))
      }
    } catch { /* ignore malformed header */ }

    if (isDebugHost()) debugInviteHeaders(e, { callUuid, bridgeId, isConference, participants })

    this._setupSessionEvents(session)
    this._callbacks.onNewSession?.(session, { callUuid, bridgeId, isConference, participants, did, didLabel })
  }

  _setupSessionEvents(session) {
    // Fix Asterisk recvonly in session SDP
    session.on('sdp', (e) => {
      if (e.originator === 'remote') {
        e.sdp = e.sdp.replace(/a=recvonly/g, 'a=sendrecv')
      }
    })

    session.on('peerconnection', (e) => {
      this._setupPeerConnection(e.peerconnection)
    })

    if (session.connection) {
      this._setupPeerConnection(session.connection)
    }

    session.on('ended', () => {
      this._destroyAudioElement()
      this._currentSession = null
    })

    session.on('failed', () => {
      this._destroyAudioElement()
      this._currentSession = null
    })
  }

  _setupPeerConnection(pc) {
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') {
        this._ensureAudioElement()
        if (e.streams && e.streams[0]) {
          this._remoteAudio.srcObject = e.streams[0]
        } else {
          this._remoteAudio.srcObject = new MediaStream([e.track])
        }
        this._remoteAudio.play().catch(() => {})
      }
    }
  }

  _ensureAudioElement() {
    if (!this._remoteAudio) {
      this._remoteAudio = document.createElement('audio')
      this._remoteAudio.autoplay = true
      this._remoteAudio.id = 'leadtodeed-remote-audio'
      document.body.appendChild(this._remoteAudio)
    }
  }

  _destroyAudioElement() {
    if (this._remoteAudio) {
      this._remoteAudio.srcObject = null
      this._remoteAudio.remove()
      this._remoteAudio = null
    }
  }
}
