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
    events: [],
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
    state.events = []
  }
  return true
}

/** Reset the event ID counter (for testing). */
export function _resetEventId() {
  nextEventId = 1
}
