import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LeadtodeedPhone } from '../src/phone.js'

// The watchdog lives on LeadtodeedPhone; these tests drive it with fake
// timers and never touch the network or JsSIP: connect() is mocked, the SIP
// layer is poked through SipClient's stored callbacks (phone._sip._callbacks),
// exactly the path real JsSIP events take.

function makePhone() {
  const phone = new LeadtodeedPhone({ subdomain: 'test', tokenUrl: '/token' })
  const reports = []
  vi.spyOn(phone._reporter, 'report').mockImplementation((level, event, message, context) => {
    reports.push({ level, event, message, context })
  })
  vi.spyOn(phone._sip, 'disconnect').mockImplementation(() => {})
  const connectSpy = vi.spyOn(phone, 'connect').mockImplementation(async () => {})
  return { phone, reports, connectSpy }
}

function simulateRegistered(phone) {
  phone._sip._callbacks.onRegistered()
}

const eventsOf = (reports, name) => reports.filter((r) => r.event === name)

describe('SIP registration watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('stays quiet while REGISTER refreshes keep arriving', () => {
    const { phone, reports, connectSpy } = makePhone()
    phone._startWatchdog()
    simulateRegistered(phone)

    // Refresh just under the stale threshold, repeatedly.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(60_000)
      simulateRegistered(phone)
    }

    expect(connectSpy).not.toHaveBeenCalled()
    expect(eventsOf(reports, 'sip_watchdog_stale')).toHaveLength(0)
    phone._stopWatchdog()
  })

  it('restarts the transport when the registration goes stale', () => {
    const { phone, reports, connectSpy } = makePhone()
    phone._startWatchdog()
    simulateRegistered(phone)

    vi.advanceTimersByTime(160_000)

    expect(connectSpy).toHaveBeenCalledTimes(1)
    const stale = eventsOf(reports, 'sip_watchdog_stale')
    expect(stale).toHaveLength(1)
    expect(stale[0].context.registered_ago_ms).toBeGreaterThanOrEqual(150_000)
    phone._stopWatchdog()
  })

  it('labels the trigger as resume after a suspension-sized tick gap', () => {
    const { phone, reports } = makePhone()
    phone._startWatchdog()
    simulateRegistered(phone)

    // A single 3h jump = the page was frozen and the missed interval fires
    // once on resume. setSystemTime moves the clock without draining ticks,
    // then one advance delivers that single overdue tick.
    vi.setSystemTime(Date.now() + 3 * 3600_000)
    vi.advanceTimersByTime(15_000)

    const stale = eventsOf(reports, 'sip_watchdog_stale')
    expect(stale).toHaveLength(1)
    expect(stale[0].message).toBe('resume')
    phone._stopWatchdog()
  })

  it('never restarts during a live call', () => {
    const { phone, connectSpy } = makePhone()
    phone._startWatchdog()
    simulateRegistered(phone)
    phone._sip._currentSession = {} // isInCall → true

    vi.advanceTimersByTime(600_000)

    expect(connectSpy).not.toHaveBeenCalled()
    phone._sip._currentSession = null
    phone._stopWatchdog()
  })

  it('does nothing before the first successful REGISTER', () => {
    const { phone, connectSpy } = makePhone()
    phone._startWatchdog()

    vi.advanceTimersByTime(600_000)

    expect(connectSpy).not.toHaveBeenCalled()
    phone._stopWatchdog()
  })

  it('backs off between restarts that do not recover, and a REGISTER resets the backoff', async () => {
    const { phone, connectSpy } = makePhone()
    phone._startWatchdog()
    simulateRegistered(phone)

    // Async advance so the awaited connect() inside the restart settles and
    // clears _watchdogRestarting between ticks.
    await vi.advanceTimersByTimeAsync(160_000)
    expect(connectSpy).toHaveBeenCalledTimes(1)

    // First restart bumps the cooldown to 60s: nothing at +45s, retry by +75s.
    await vi.advanceTimersByTimeAsync(45_000)
    expect(connectSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(connectSpy).toHaveBeenCalledTimes(2)
    expect(phone._watchdogRestartCount).toBe(2)

    simulateRegistered(phone)
    expect(phone._watchdogRestartCount).toBe(0)
    phone._stopWatchdog()
  })

  it('checks immediately when the tab becomes visible', () => {
    const { phone, reports, connectSpy } = makePhone()
    phone._startWatchdog()
    simulateRegistered(phone)

    // Go stale without any interval tick having fired yet.
    phone._lastRegisteredAt = Date.now() - 200_000
    document.dispatchEvent(new Event('visibilitychange'))

    expect(connectSpy).toHaveBeenCalledTimes(1)
    expect(eventsOf(reports, 'sip_watchdog_stale')[0].message).toBe('visible')
    phone._stopWatchdog()
  })

  it('reports restart failures and keeps the backoff counting', async () => {
    const { phone, reports, connectSpy } = makePhone()
    connectSpy.mockRejectedValue(new Error('token fetch failed'))
    phone._startWatchdog()
    simulateRegistered(phone)

    vi.advanceTimersByTime(160_000)
    await Promise.resolve() // let the rejected connect() settle
    await Promise.resolve()

    expect(eventsOf(reports, 'sip_watchdog_restart_failed')).toHaveLength(1)
    expect(phone._watchdogRestartCount).toBe(1)
    phone._stopWatchdog()
  })

  it('disconnect() stops the watchdog', () => {
    const { phone, connectSpy } = makePhone()
    phone._startWatchdog()
    simulateRegistered(phone)
    phone.disconnect()

    vi.advanceTimersByTime(600_000)

    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('a disconnect() racing an in-flight restart wins: no UA is left behind', async () => {
    const { phone, connectSpy } = makePhone()
    let releaseConnect
    connectSpy.mockImplementation(() => new Promise((resolve) => { releaseConnect = resolve }))
    phone._startWatchdog()
    simulateRegistered(phone)

    vi.advanceTimersByTime(160_000)
    expect(connectSpy).toHaveBeenCalledTimes(1)
    const disconnectsBefore = phone._sip.disconnect.mock.calls.length

    phone.disconnect() // teardown while the restart awaits connect()
    releaseConnect()
    await Promise.resolve()
    await Promise.resolve()

    // The restart noticed the epoch bump and tore the fresh UA down again.
    expect(phone._sip.disconnect.mock.calls.length).toBeGreaterThan(disconnectsBefore + 1)
    expect(phone._watchdogTimer).toBeNull()
  })
})
