/**
 * Leadtodeed — pure phone/state library with renderer callback.
 *
 * No built-in UI. The host app provides a `renderer(state)` function
 * that is called on every state change.
 *
 * Usage (ESM via importmap / bundler):
 *   import Leadtodeed from 'leadtodeed-widget'
 *   Leadtodeed({
 *     subdomain: 'homey',
 *     tokenUrl: '/api/leadtodeed/token',
 *     renderer: (state) => updateUI(state),
 *     onIncomingCall: async (number) => fetchCallerInfo(number),
 *   })
 *
 * Usage (IIFE via CDN <script> tag):
 *   <script src="https://cdn.jsdelivr.net/npm/leadtodeed-widget@latest/dist/leadtodeed-widget.iife.js"></script>
 *   <script>Leadtodeed({ subdomain: 'homey', tokenUrl: '/api/leadtodeed/token', renderer: (s) => {} })</script>
 */

import { LeadtodeedPhone } from './phone.js'
import { createCallState, addEvent, transitionPhase } from './state.js'
import { CallEventsSocket } from './call-events-ws.js'

/**
 * Initialize the Leadtodeed phone library.
 *
 * @param {Object} config
 * @param {string} config.subdomain - Tenant subdomain (e.g. "homey" → https://homey.leadtodeed.ai)
 * @param {string} config.tokenUrl - Token endpoint path
 * @param {Function} [config.renderer] - (state) => void — called on every state change
 * @param {Function} [config.onIncomingCall] - async (callerNumber) => enrichmentData | null
 * @param {string} [config.ringtoneUrl] - URL to an .ogg ringtone played on incoming calls
 * @returns {LeadtodeedPhone} The phone instance
 */
export default function Leadtodeed({
  subdomain,
  tokenUrl,
  renderer = null,
  onIncomingCall = null,
  ringtoneUrl = null,
} = {}) {
  const state = createCallState()
  const leadtodeedUrl = `https://${subdomain}.leadtodeed.ai`
  let callEventsSocket = null
  let ringtoneAudio = null

  if (ringtoneUrl) {
    ringtoneAudio = new Audio(ringtoneUrl)
    ringtoneAudio.loop = true
  }

  const phone = new LeadtodeedPhone({
    subdomain,
    tokenUrl,
    onError: (err) => console.error("[Leadtodeed]", err),
  })

  function notify() {
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
      accept: () => phone.answer(),
      decline: () => phone.reject(),
      hangup: () => phone.hangup(),
      sendDTMF: (digit) => phone.sendDTMF(digit),
      toggleMute: () => phone.toggleMute(),
      addParticipant: (userId) => _addParticipant(userId),
    })
  }

  async function _addParticipant(userId) {
    const token = phone._auth?.token
    if (!token) return
    try {
      const resp = await fetch(`${leadtodeedUrl}/api/conference/add`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ target_user_id: userId }),
      })
      if (!resp.ok) {
        console.error('[Leadtodeed] addParticipant failed:', resp.status)
      }
    } catch (e) {
      console.error('[Leadtodeed] addParticipant error:', e)
    }
  }

  function _connectCallEventsWS() {
    const token = phone._auth?.token
    if (!token) return
    const wsUrl = leadtodeedUrl.replace('https://', 'wss://') + '/api/call/events'
    callEventsSocket = new CallEventsSocket({
      url: wsUrl,
      token,
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
      onCallEnded: () => {
        // The bridge ended server-side; let the normal SIP callEnded handle phase transition
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

  phone.on('incomingCall', async ({ callerNumber, participants: initialParticipants }) => {
    transitionPhase(state, 'ringing', { number: callerNumber, direction: 'incoming' })
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
    // Connect participant events WS on SIP registration so both WS are always up
    _connectCallEventsWS()
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

  // BroadcastChannel for cross-tab sync
  let channel = null
  try {
    channel = new BroadcastChannel('leadtodeed-call')
    channel.onmessage = (e) => {
      const msg = e.data
      if (msg.type === 'request-state' && state.phase !== 'idle') {
        channel.postMessage({ type: 'state', phase: state.phase, number: state.number, direction: state.direction, connectedAt: state.connectedAt, events: state.events })
      }
    }
  } catch {
    // BroadcastChannel not available (SSR, old browsers)
  }

  phone.connect().catch((err) => console.error("[Leadtodeed] connect failed:", err))

  return phone
}

export { Leadtodeed, LeadtodeedPhone }
