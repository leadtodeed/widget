/**
 * JsSIP wrapper with SDP/ICE patches for Asterisk WebRTC.
 * Extracted and cleaned up from leadtodeed's app.js.j2.
 */
import JsSIP from 'jssip'

const ICE_GATHERING_TIMEOUT = 1000

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
  constructor({ onRegistered, onUnregistered, onRegistrationFailed, onNewSession, onDisconnected, onWsOpened, onStats, getAudioConstraints }) {
    this._ua = null
    this._currentSession = null
    this._remoteAudio = null
    this._iceServers = []
    this._sipConfig = null
    this._callbacks = { onRegistered, onUnregistered, onRegistrationFailed, onNewSession, onDisconnected, onWsOpened, onStats }
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

  connect(sipConfig, iceServers) {
    // Apply patches once
    patchIceGathering()
    patchSdpRemoteDescription()
    patchJsSipGrammar()

    this._sipConfig = sipConfig
    this._iceServers = iceServers
    // Ordered RTP codec names from the backend (e.g. ['opus','PCMU','PCMA']).
    // Pinned per peer connection so this extension negotiates its assigned codec
    // deterministically instead of relying on browser/Asterisk ordering.
    this._audioCodecs = Array.isArray(sipConfig.audio_codecs) ? sipConfig.audio_codecs : []

    const socket = new JsSIP.WebSocketInterface(sipConfig.wss_url)

    const configuration = {
      sockets: [socket],
      uri: `sip:${sipConfig.extension}@${sipConfig.sip_domain}`,
      password: sipConfig.sip_password,
      display_name: sipConfig.display_name,
      register: true,
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

    // Read X-headers from incoming SIP INVITE for conference context
    const request = session.request
    const bridgeId = request?.getHeader?.('X-Bridge-Id') || null
    const isConference = request?.getHeader?.('X-Conference') === 'true'
    let participants = []
    try {
      const raw = request?.getHeader?.('X-Participants')
      if (raw) participants = JSON.parse(raw)
    } catch { /* ignore parse errors */ }

    this._setupSessionEvents(session)
    this._callbacks.onNewSession?.(session, { bridgeId, isConference, participants })
  }

  _setupSessionEvents(session) {
    // Fix Asterisk recvonly in session SDP
    session.on('sdp', (e) => {
      if (e.originator === 'remote') {
        e.sdp = e.sdp.replace(/a=recvonly/g, 'a=sendrecv')
      } else if (e.originator === 'local') {
        // Fallback to setCodecPreferences: reorder our outgoing m=audio payload
        // list to match the backend codec preference, in case transceivers weren't
        // available when _applyCodecPreferences ran.
        e.sdp = this._reorderAudioCodecs(e.sdp)
      }
    })

    session.on('peerconnection', (e) => {
      this._setupPeerConnection(e.peerconnection)
    })

    if (session.connection) {
      this._setupPeerConnection(session.connection)
    }

    session.on('ended', () => {
      this._stopStatsSampler()
      this._destroyAudioElement()
      this._currentSession = null
    })

    session.on('failed', () => {
      this._stopStatsSampler()
      this._destroyAudioElement()
      this._currentSession = null
    })
  }

  _applyCodecPreferences(pc) {
    // Pin codec negotiation order to this._audioCodecs (backend-driven) before
    // the SDP offer/answer is generated. No-op if the browser lacks the API or
    // transceivers aren't created yet (the session 'sdp' hook reorders as a fallback).
    if (!this._audioCodecs?.length) return
    if (typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return
    if (typeof pc.getTransceivers !== 'function') return
    const caps = RTCRtpReceiver.getCapabilities('audio')?.codecs
    if (!caps?.length) return
    const wanted = this._audioCodecs.map((n) => `audio/${n.toLowerCase()}`)
    const ranked = wanted
      .map((mime) => caps.filter((c) => c.mimeType.toLowerCase() === mime))
      .flat()
    if (!ranked.length) return
    const rest = caps.filter((c) => !ranked.includes(c))
    const ordered = [...ranked, ...rest]
    for (const t of pc.getTransceivers()) {
      const isAudio = t.sender?.track?.kind === 'audio' || t.receiver?.track?.kind === 'audio'
      if (isAudio && typeof t.setCodecPreferences === 'function') {
        try { t.setCodecPreferences(ordered) } catch { /* unsupported codec set; ignore */ }
      }
    }
  }

  _reorderAudioCodecs(sdp) {
    // Reorder the first m=audio payload list so this._audioCodecs come first,
    // preserving the rest. Used as a fallback when setCodecPreferences couldn't run.
    if (!this._audioCodecs?.length) return sdp
    const eol = sdp.includes('\r\n') ? '\r\n' : '\n'
    const lines = sdp.split(/\r\n|\n/)
    const mIdx = lines.findIndex((l) => l.startsWith('m=audio '))
    if (mIdx === -1) return sdp
    const ptName = {}
    for (let i = mIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('m=')) break // next media section
      const m = lines[i].match(/^a=rtpmap:(\d+)\s+([^/]+)\//i)
      if (m) ptName[m[1]] = m[2].toLowerCase()
    }
    const parts = lines[mIdx].split(' ')
    const header = parts.slice(0, 3) // 'm=audio', port, proto
    const pts = parts.slice(3)
    const wanted = this._audioCodecs.map((n) => n.toLowerCase())
    const ranked = []
    for (const w of wanted) {
      for (const pt of pts) {
        if (ptName[pt] === w && !ranked.includes(pt)) ranked.push(pt)
      }
    }
    if (!ranked.length) return sdp
    const rest = pts.filter((pt) => !ranked.includes(pt))
    lines[mIdx] = [...header, ...ranked, ...rest].join(' ')
    return lines.join(eol)
  }

  _setupPeerConnection(pc) {
    this._applyCodecPreferences(pc)
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
    this._startStatsSampler(pc)
  }

  // Poll getStats() every 3s and emit a compact quality sample (jitter, RTT,
  // loss, concealment/freezes, mic + playout audio levels) via onStats. The
  // backend tags it with subdomain/extension/call_uuid and feeds Prometheus.
  // Stops itself when the connection closes; emits a terminal {type:'stats_end'}.
  _startStatsSampler(pc) {
    if (this._statsPc === pc) return   // _setupPeerConnection can fire twice for one pc
    this._stopStatsSampler()
    this._statsPc = pc
    this._statsCallId = this._currentSession?.id || null
    let prev = null

    const sample = async () => {
      let report
      try { report = await pc.getStats() } catch { return }
      let inbound, remoteInbound, source, pair
      report.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') inbound = r
        else if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') remoteInbound = r
        else if (r.type === 'media-source' && r.kind === 'audio') source = r
        else if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || !pair)) pair = r
      })
      const m = {}
      if (inbound) {
        if (typeof inbound.jitter === 'number') m.jitter_recv = inbound.jitter
        if (typeof inbound.audioLevel === 'number') m.level_playout = inbound.audioLevel
        if (typeof inbound.freezeCount === 'number') m.freezes = inbound.freezeCount
        if (inbound.totalSamplesReceived > 0 && typeof inbound.concealedSamples === 'number') {
          m.concealment = inbound.concealedSamples / inbound.totalSamplesReceived
        }
        // packetsLost/Received are cumulative counters — diff to get a rate.
        if (prev && typeof inbound.packetsReceived === 'number' && typeof inbound.packetsLost === 'number') {
          const denom = (inbound.packetsReceived - prev.recv) + (inbound.packetsLost - prev.lost)
          if (denom > 0) m.loss_recv = Math.max(0, (inbound.packetsLost - prev.lost) / denom)
        }
        prev = { recv: inbound.packetsReceived ?? 0, lost: inbound.packetsLost ?? 0 }
      }
      if (remoteInbound) {
        if (typeof remoteInbound.jitter === 'number') m.jitter_send = remoteInbound.jitter
        if (typeof remoteInbound.fractionLost === 'number') m.loss_send = remoteInbound.fractionLost
        if (typeof remoteInbound.roundTripTime === 'number') m.rtt = remoteInbound.roundTripTime
      }
      if (source && typeof source.audioLevel === 'number') m.level_mic = source.audioLevel
      if (m.rtt === undefined && pair && typeof pair.currentRoundTripTime === 'number') m.rtt = pair.currentRoundTripTime
      if (Object.keys(m).length) {
        this._callbacks.onStats?.({ type: 'stats', call_id: this._statsCallId, metrics: m })
      }
    }

    this._statsTimer = setInterval(sample, 3000)
    this._statsOnState = () => {
      if (['closed', 'failed', 'disconnected'].includes(pc.connectionState)) this._stopStatsSampler()
    }
    pc.addEventListener?.('connectionstatechange', this._statsOnState)
  }

  _stopStatsSampler() {
    if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null }
    if (this._statsPc && this._statsOnState) {
      this._statsPc.removeEventListener?.('connectionstatechange', this._statsOnState)
    }
    if (this._statsCallId) {
      this._callbacks.onStats?.({ type: 'stats_end', call_id: this._statsCallId })
      this._statsCallId = null
    }
    this._statsPc = null
    this._statsOnState = null
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
