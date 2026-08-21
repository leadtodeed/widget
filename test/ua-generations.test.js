import { describe, it, expect, vi, afterEach } from 'vitest'
import { SipClient } from '../src/sip-client.js'

// A watchdog restart replaces the JsSIP UA, but `ua.stop()` is asynchronous:
// the old UA un-REGISTERs, drains its transactions and only then closes its
// socket, so it emits `disconnected` a second or two AFTER connect() has
// already stood a fresh UA up and registered it.
//
// Before the generation guard that late event ran against the new UA's state:
// it reported a ~1.6s lifetime for a healthy socket, nulled the shared
// wsOpenedAt so the next genuine close reported duration_ms=null, and drove
// the phone's `_registered` to false on a live registration — which the leader
// health gate then tore down 60s later. Asterisk's transport log showed no
// close at all at that moment; the socket never died.

/** Minimal stand-in for JsSIP.UA: records handlers, lets a test fire them. */
function makeUA(name) {
  const handlers = {}
  return {
    name,
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn) },
    emit: (ev, arg) => (handlers[ev] || []).forEach((fn) => fn(arg)),
    stop: vi.fn(),
    listenerCount: (ev) => (handlers[ev] || []).length,
  }
}

function makeClient() {
  const calls = { onWsOpened: [], onRegistered: [], onDisconnected: [], onNewSession: [] }
  const sip = new SipClient({
    onWsOpened: () => calls.onWsOpened.push(Date.now()),
    onRegistered: () => calls.onRegistered.push(Date.now()),
    onDisconnected: (e) => calls.onDisconnected.push(e),
    onNewSession: () => calls.onNewSession.push(true),
  })
  return { sip, calls }
}

afterEach(() => vi.restoreAllMocks())

describe('UA generations do not clobber each other', () => {
  it('ignores the previous UA\'s late disconnected', () => {
    const { sip, calls } = makeClient()

    const uaA = makeUA('A')
    sip._ua = uaA
    sip._attachUaHandlers(uaA)
    uaA.emit('connected')
    uaA.emit('registered')
    expect(calls.onWsOpened).toHaveLength(1)

    // Watchdog restart: disconnect() disowns A, then a fresh B comes up.
    sip.disconnect()
    expect(uaA.stop).toHaveBeenCalled()

    const uaB = makeUA('B')
    sip._ua = uaB
    sip._attachUaHandlers(uaB)
    uaB.emit('connected')
    uaB.emit('registered')

    // ...and only NOW does A's socket finally close.
    uaA.emit('disconnected', { code: undefined, reason: undefined })

    expect(calls.onDisconnected).toEqual([])          // the phantom is suppressed
    expect(calls.onRegistered).toHaveLength(2)        // B's registration survives
  })

  it('still reports a genuine close on the current UA, with its own lifetime', () => {
    vi.useFakeTimers()
    try {
      const { sip, calls } = makeClient()
      const ua = makeUA('only')
      sip._ua = ua
      sip._attachUaHandlers(ua)

      ua.emit('connected')
      vi.advanceTimersByTime(45_000)
      ua.emit('disconnected', { code: 1006, wasClean: false })

      expect(calls.onDisconnected).toHaveLength(1)
      expect(calls.onDisconnected[0].code).toBe(1006)
      expect(calls.onDisconnected[0].duration_ms).toBe(45_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('measures each generation against its own open time, not a shared field', () => {
    vi.useFakeTimers()
    try {
      const { sip, calls } = makeClient()

      const uaA = makeUA('A')
      sip._ua = uaA
      sip._attachUaHandlers(uaA)
      uaA.emit('connected')
      vi.advanceTimersByTime(300_000)          // A has been up for 5 minutes

      const uaB = makeUA('B')
      sip._ua = uaB                            // B takes over
      sip._attachUaHandlers(uaB)
      uaB.emit('connected')
      vi.advanceTimersByTime(1_600)            // the phantom's signature delay
      uaA.emit('disconnected', {})             // A's close lands late: ignored

      vi.advanceTimersByTime(10_000)
      uaB.emit('disconnected', {})             // B's own close, 11.6s after open

      expect(calls.onDisconnected).toHaveLength(1)
      expect(calls.onDisconnected[0].duration_ms).toBe(11_600)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops an INVITE that arrives on a UA we have already disowned', () => {
    const { sip, calls } = makeClient()
    const uaA = makeUA('A')
    sip._ua = uaA
    sip._attachUaHandlers(uaA)

    sip.disconnect()
    uaA.emit('newRTCSession', { session: {}, request: null })

    expect(calls.onNewSession).toEqual([])
  })
})
