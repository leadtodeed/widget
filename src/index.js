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

/**
 * Initialize the Leadtodeed phone library.
 *
 * @param {Object} config
 * @param {string} config.subdomain - Tenant subdomain (e.g. "homey" → https://homey.leadtodeed.ai)
 * @param {string} config.tokenUrl - Token endpoint path
 * @param {Function} [config.renderer] - (state) => void — called on every state change
 * @param {Function} [config.onIncomingCall] - async (callerNumber) => enrichmentData | null
 * @returns {LeadtodeedPhone} The phone instance
 */
export default function Leadtodeed({
  subdomain,
  tokenUrl,
  renderer = null,
  onIncomingCall = null,
} = {}) {
  const state = createCallState()

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
      events: state.events,
      accept: () => phone.answer(),
      decline: () => phone.reject(),
      hangup: () => phone.hangup(),
      sendDTMF: (digit) => phone.sendDTMF(digit),
    })
  }

  phone.on('incomingCall', async ({ callerNumber }) => {
    transitionPhase(state, 'ringing', { number: callerNumber, direction: 'incoming' })
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

  phone.on('callConnected', () => {
    transitionPhase(state, 'connected', { connectedAt: Date.now() })
    notify()
  })

  phone.on('callEnded', () => {
    transitionPhase(state, 'ended')
    notify()

    setTimeout(() => {
      transitionPhase(state, 'idle')
      notify()
    }, 2000)
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
