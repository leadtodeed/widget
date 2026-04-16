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
  constructor({ onRegistered, onUnregistered, onRegistrationFailed, onNewSession, onDisconnected }) {
    this._ua = null
    this._currentSession = null
    this._remoteAudio = null
    this._iceServers = []
    this._sipConfig = null
    this._callbacks = { onRegistered, onUnregistered, onRegistrationFailed, onNewSession, onDisconnected }
  }

  get isRegistered() {
    return this._ua ? this._ua.isRegistered() : false
  }

  get currentSession() {
    return this._currentSession
  }

  connect(sipConfig, iceServers) {
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
      register: true,
      register_expires: 60,
      session_timers: false,
    }

    this._ua = new JsSIP.UA(configuration)

    this._ua.on('registered', () => this._callbacks.onRegistered?.())
    this._ua.on('unregistered', () => this._callbacks.onUnregistered?.())
    this._ua.on('registrationFailed', (e) => this._callbacks.onRegistrationFailed?.(e))
    this._ua.on('disconnected', () => this._callbacks.onDisconnected?.())
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
      mediaConstraints: { audio: true, video: false },
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
      mediaConstraints: { audio: true, video: false },
      pcConfig: {
        iceServers: this._iceServers,
        iceCandidatePoolSize: 10,
        iceTransportPolicy: 'all',
      },
    }

    this._currentSession.answer(options)
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
