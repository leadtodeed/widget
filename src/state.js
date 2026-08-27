/**
 * Call state machine.
 *
 * Phases: idle → ringing → connected → ended
 * Events: append-only log with { id, type, ts, data }
 */

let nextEventId = 1

const VALID_TRANSITIONS = {
  idle: ['ringing'],
  ringing: ['connected', 'ended'],
  connected: ['ended'],
  ended: ['idle'],
}

export function createCallState() {
  return {
    phase: 'idle',
    number: null,
    direction: null,
    connectedAt: null,
    muted: false,
    events: [],
    participants: [],    // [{ user_id, name, extension }]
    isConference: false,
    callUuid: null,      // from the INVITE's X-Call-Uuid; identifies the call
                         // across surfaces (notification tag, push, pull-answer)
    bridgeId: null,
    did: null,           // the line the customer dialed (X-Did, +E.164)
    didLabel: null,      // its human name (X-Did-Label-B64, e.g. a brand)
    outboundClid: null,  // outgoing: the line WE called from (X-Clid on the
                         // 183/200). The mirror of `did` — that is the line
                         // they dialled, this is the line we asserted.
    outboundLabel: null, // its human name (X-Did-Label-B64 on the response)
    endReason: null,     // why the call ended, when the server gave a reason
                         // ("clid_not_allowed"); null for an ordinary hangup
  }
}

export function addEvent(state, type, data) {
  const event = {
    id: nextEventId++,
    type,
    ts: Date.now(),
    data,
  }
  state.events.push(event)
  return event
}

export function transitionPhase(state, newPhase, attrs = {}) {
  if (state.phase === newPhase) return true // no-op self-transition
  const allowed = VALID_TRANSITIONS[state.phase]
  if (!allowed || !allowed.includes(newPhase)) {
    console.warn(`[Leadtodeed] Invalid phase transition: ${state.phase} → ${newPhase}`)
    return false
  }
  state.phase = newPhase
  Object.assign(state, attrs)
  if (newPhase === 'idle') {
    state.number = null
    state.direction = null
    state.connectedAt = null
    state.muted = false
    state.events = []
    state.participants = []
    state.isConference = false
    state.callUuid = null
    state.bridgeId = null
    state.did = null
    state.didLabel = null
    state.outboundClid = null
    state.outboundLabel = null
    state.endReason = null
  }
  return true
}

/** Reset the event ID counter (for testing). */
export function _resetEventId() {
  nextEventId = 1
}
