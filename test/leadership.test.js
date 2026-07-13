import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LeadershipManager } from '../src/leadership.js'
import { installFakeLocks, uninstallFakeLocks } from './leader.test.js'

// Simulates several same-origin tabs in one process: shared fake Web Locks,
// a fake BroadcastChannel bus, and per-tab fake phones + input clocks
// (injected — the real activity module is a per-page singleton, which is
// exactly wrong when many "tabs" live in one test process).

class FakeBroadcastChannel {
  static channels = new Map()

  constructor(name) {
    this.name = name
    this.onmessage = null
    this._closed = false
    if (!FakeBroadcastChannel.channels.has(name)) {
      FakeBroadcastChannel.channels.set(name, new Set())
    }
    FakeBroadcastChannel.channels.get(name).add(this)
  }

  postMessage(msg) {
    for (const other of FakeBroadcastChannel.channels.get(this.name) || []) {
      if (other === this || other._closed) continue
      queueMicrotask(() => {
        if (!other._closed) other.onmessage?.({ data: msg })
      })
    }
  }

  close() {
    this._closed = true
    FakeBroadcastChannel.channels.get(this.name)?.delete(this)
  }

  static reset() {
    FakeBroadcastChannel.channels.clear()
  }
}

function makeFakePhone(name, log) {
  const handlers = {}
  const phone = {
    isInCall: false,
    registered: false,
    connected: false,
    connect: vi.fn(async (opts = {}) => {
      log.push(`${name}.connect(register=${opts.register !== false})`)
      phone.connected = true
      if (opts.register !== false) phone.registered = true
    }),
    register: vi.fn(async () => {
      log.push(`${name}.register`)
      phone.registered = true
    }),
    stopSip: vi.fn(() => {
      log.push(`${name}.stopSip`)
      phone.connected = false
      phone.registered = false
    }),
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn) },
    off: (ev, fn) => { handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn) },
    emit: (ev, data) => { for (const f of (handlers[ev] || []).slice()) f(data) },
    reporter: { report: vi.fn() },
  }
  return phone
}

function makeTab(name, log) {
  const phone = makeFakePhone(name, log)
  const inputSubs = []
  const tab = {
    name,
    phone,
    phase: 'idle',
    inputAt: 0,
    // "Freeze": the tab stops sending and receiving protocol messages, like
    // a Safari-suspended page. Locks stay held — exactly the failure mode.
    freeze() {
      this.manager._send = () => {}
      if (this.manager._channel) this.manager._channel.onmessage = null
    },
    input() {
      this.inputAt = Date.now()
      inputSubs.forEach((f) => f())
    },
  }
  tab.manager = new LeadershipManager({
    phone,
    getPhase: () => tab.phase,
    sessionId: name,
    getInputAgeMs: () => (tab.inputAt ? Date.now() - tab.inputAt : 3600_000),
    getHasEverHadInput: () => tab.inputAt > 0,
    subscribeInput: (fn) => {
      inputSubs.push(fn)
      return () => {}
    },
  })
  return tab
}

const settle = () => vi.advanceTimersByTimeAsync(100)

describe('LeadershipManager', () => {
  let log

  beforeEach(() => {
    vi.useFakeTimers()
    installFakeLocks()
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    log = []
  })

  afterEach(() => {
    FakeBroadcastChannel.reset()
    uninstallFakeLocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('cold start: first tab leads and registers, later tabs stay lock-free followers', async () => {
    const a = makeTab('A', log)
    await a.manager.start()
    await settle()
    expect(a.manager.role).toBe('leader')
    expect(a.phone.connect).toHaveBeenCalledTimes(1)
    expect(a.phone.registered).toBe(true)

    const b = makeTab('B', log)
    await b.manager.start()
    await settle()
    expect(b.manager.role).toBe('follower')
    expect(b.phone.connect).not.toHaveBeenCalled()
  })

  it('input in a follower hands leadership over from an idle leader, make-before-break', async () => {
    const a = makeTab('A', log)
    const b = makeTab('B', log)
    await a.manager.start()
    await b.manager.start()
    await settle()

    b.input()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(b.manager.role).toBe('leader')
    expect(a.manager.role).toBe('follower')
    // Candidate registered on its warm socket BEFORE the old leader tore down.
    expect(log.indexOf('B.register')).toBeGreaterThan(-1)
    expect(log.indexOf('B.register')).toBeLessThan(log.indexOf('A.stopSip'))
    // Warm-up was registerless; REGISTER happened at takeover.
    expect(log).toContain('B.connect(register=false)')
  })

  it('aborts candidacy when the leader itself has fresh input', async () => {
    const a = makeTab('A', log)
    const b = makeTab('B', log)
    await a.manager.start()
    await b.manager.start()
    await settle()

    a.input()
    b.input()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(a.manager.role).toBe('leader')
    expect(b.manager.role).toBe('follower')
    expect(b.phone.connect).not.toHaveBeenCalled()
  })

  it('holds candidacy through a call (no REGISTER) and takes over on the idle transition', async () => {
    const a = makeTab('A', log)
    const b = makeTab('B', log)
    await a.manager.start()
    await b.manager.start()
    await settle()

    a.phase = 'connected'
    b.input()
    await vi.advanceTimersByTimeAsync(5_000)

    // Warm standby, unregistered, still not the leader.
    expect(b.manager.role).toBe('candidate')
    expect(log).toContain('B.connect(register=false)')
    expect(b.phone.registered).toBe(false)
    expect(a.manager.role).toBe('leader')

    // Long call: candidate keeps holding.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(a.manager.role).toBe('leader')
    expect(b.phone.registered).toBe(false)

    // Call ends — leader broadcasts the idle transition, candidate completes.
    a.phase = 'idle'
    a.manager.onPhaseChange('idle')
    await vi.advanceTimersByTimeAsync(3_000)

    expect(b.manager.role).toBe('leader')
    expect(a.manager.role).toBe('follower')
    expect(log.indexOf('B.register')).toBeLessThan(log.indexOf('A.stopSip'))
  })

  it('steals from a frozen idle leader after the short grace', async () => {
    const a = makeTab('A', log)
    const b = makeTab('B', log)
    await a.manager.start()
    await b.manager.start()
    await settle()

    a.freeze()
    b.input()
    // Probe times out (5s), then grace (30s from last heartbeat) must pass.
    await vi.advanceTimersByTimeAsync(60_000)

    expect(b.manager.role).toBe('leader')
    // Deposed frozen leader tears its SIP down (it wasn't in a call).
    expect(a.phone.stopSip).toHaveBeenCalled()
    expect(a.manager.role).toBe('follower')
  })

  it('waits the long grace for a frozen in-call leader, and a deposed in-call leader keeps SIP until the call ends', async () => {
    const a = makeTab('A', log)
    const b = makeTab('B', log)
    await a.manager.start()
    await b.manager.start()
    await settle()

    a.phase = 'connected'
    a.manager.onPhaseChange('connected') // followers learn the phase
    await settle()
    a.phone.isInCall = true
    a.freeze()

    b.input()
    await vi.advanceTimersByTimeAsync(120_000)
    // 2 minutes of silence: still inside the 10-minute in-call grace.
    expect(b.manager.role).not.toBe('leader')
    expect(a.manager.role).toBe('leader')

    await vi.advanceTimersByTimeAsync(600_000)
    expect(b.manager.role).toBe('leader')

    // Invariant: the deposed leader's (theoretical) live call is untouched.
    expect(a.phone.stopSip).not.toHaveBeenCalled()
    a.phone.isInCall = false
    a.phone.emit('callEnded')
    expect(a.phone.stopSip).toHaveBeenCalled()
  })

  it('succession on clean shutdown goes to the freshest-input tab', async () => {
    const a = makeTab('A', log)
    const b = makeTab('B', log)
    const c = makeTab('C', log)
    await a.manager.start()
    await b.manager.start()
    await c.manager.start()
    await settle()

    c.input()
    await vi.advanceTimersByTimeAsync(60_000) // C's input is now 60s old
    b.input()
    await vi.advanceTimersByTimeAsync(500)

    // B's fresh input starts an ordinary handoff — complete it, then close B
    // to test succession... instead, keep A leader by closing B's candidacy
    // window: simpler — shut A down and let the stagger race decide.
    a.manager.shutdown()
    // The bye race must converge fast — a call arriving seconds after the
    // leader closed needs a registered successor (observed prod miss at +4s).
    await vi.advanceTimersByTimeAsync(2_000)

    expect(b.manager.role).toBe('leader')
    expect(b.phone.registered).toBe(true)
    expect(c.manager.role).toBe('follower')
  })

  it('a tab with no input ever only claims as a last resort', async () => {
    const a = makeTab('A', log)
    const b = makeTab('B', log)
    await a.manager.start()
    await b.manager.start()
    await settle()

    a.manager.shutdown()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(b.manager.role).toBe('follower') // still inside the no-input bye stagger

    await vi.advanceTimersByTimeAsync(5_000)
    expect(b.manager.role).toBe('leader')
    expect(b.phone.registered).toBe(true)
  })

  it('yield to freshest: a fresher tab takes the candidacy from a staler one', async () => {
    const a = makeTab('A', log)
    const b = makeTab('B', log)
    const c = makeTab('C', log)
    await a.manager.start()
    await b.manager.start()
    await c.manager.start()
    await settle()

    a.phase = 'connected' // keep the leader busy so candidacy holds
    c.input()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(c.manager.role).toBe('candidate')

    await vi.advanceTimersByTimeAsync(30_000) // C's user wanders off
    b.input()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(c.manager.role).toBe('follower')
    expect(c.phone.stopSip).toHaveBeenCalled() // dropped its warm socket
    expect(b.manager.role).toBe('candidate')
  })

  it('a declined yield does not steal the candidacy (no ping-pong)', async () => {
    const a = makeTab('A', log)
    const b = makeTab('B', log)
    const c = makeTab('C', log)
    await a.manager.start()
    await b.manager.start()
    await c.manager.start()
    await settle()

    a.phase = 'connected' // busy leader keeps the candidacy held
    c.input()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(c.manager.role).toBe('candidate')

    // B's input is fresher, but not by the yield margin — C declines.
    b.input()
    await vi.advanceTimersByTimeAsync(10_000) // well past the yield timeout

    expect(c.manager.role).toBe('candidate')
    expect(c.phone.stopSip).not.toHaveBeenCalled()
    expect(b.manager.role).toBe('follower')
  })

  it('a frozen candidate is stolen from after the yield timeout', async () => {
    const a = makeTab('A', log)
    const b = makeTab('B', log)
    const c = makeTab('C', log)
    await a.manager.start()
    await b.manager.start()
    await c.manager.start()
    await settle()

    a.phase = 'connected'
    c.input()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(c.manager.role).toBe('candidate')

    c.freeze() // can't answer the yield request
    b.input()
    await vi.advanceTimersByTimeAsync(7_000) // yield timeout + steal

    expect(b.manager.role).toBe('candidate')
    expect(c.phone.stopSip).toHaveBeenCalled() // deposed candidate dropped its warm socket
  })

  it('debounces candidacy triggers', async () => {
    const a = makeTab('A', log)
    const b = makeTab('B', log)
    await a.manager.start()
    await b.manager.start()
    await settle()

    a.phase = 'connected'
    b.input()
    await vi.advanceTimersByTimeAsync(500)
    b.input()
    b.input()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(b.phone.connect).toHaveBeenCalledTimes(1)
  })

  it('shutdown releases everything', async () => {
    const a = makeTab('A', log)
    await a.manager.start()
    await settle()
    expect(a.manager.role).toBe('leader')

    a.manager.shutdown()
    expect(a.manager.role).toBe('follower')
    await settle() // lock release resolves through a microtask chain

    const b = makeTab('B', log)
    await b.manager.start()
    await settle()
    expect(b.manager.role).toBe('leader')
  })
})
