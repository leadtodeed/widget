import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { becomeLeader } from '../src/leader.js'

// Minimal navigator.locks fake: a single named lock with FIFO queue.
// Mirrors the spec's behavior closely enough to test our usage.
function installFakeLocks() {
  const queues = new Map() // name -> [{callback, settle}]
  const holder = new Map() // name -> currently running entry

  function tryRun(name) {
    if (holder.get(name)) return
    const queue = queues.get(name) || []
    const entry = queue.shift()
    if (!entry) return
    holder.set(name, entry)
    Promise.resolve()
      .then(() => entry.callback())
      .catch(() => undefined)
      .then((result) => {
        holder.delete(name)
        entry.settle(result)
        tryRun(name)
      })
  }

  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
      request(name, _opts, callback) {
        return new Promise((settle) => {
          const queue = queues.get(name) || []
          queue.push({ callback, settle })
          queues.set(name, queue)
          tryRun(name)
        })
      },
    },
  })
}

function uninstallFakeLocks() {
  try {
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: undefined,
    })
  } catch (_) { /* ignore */ }
}

describe('becomeLeader', () => {
  beforeEach(() => {
    installFakeLocks()
  })

  afterEach(() => {
    uninstallFakeLocks()
  })

  it('first caller acquires the lock immediately', async () => {
    const onAcquired = vi.fn()
    becomeLeader('t', onAcquired)
    await new Promise((r) => setTimeout(r, 10))
    expect(onAcquired).toHaveBeenCalledTimes(1)
  })

  it('second caller queues until the first releases', async () => {
    const onA = vi.fn()
    const onB = vi.fn()
    const releaseA = becomeLeader('t', onA)
    becomeLeader('t', onB)
    await new Promise((r) => setTimeout(r, 10))
    expect(onA).toHaveBeenCalledTimes(1)
    expect(onB).not.toHaveBeenCalled()

    releaseA()
    await new Promise((r) => setTimeout(r, 10))
    expect(onB).toHaveBeenCalledTimes(1)
  })

  it('three callers serialize in order', async () => {
    const order = []
    const releaseA = becomeLeader('t', () => order.push('A'))
    const releaseB = becomeLeader('t', () => order.push('B'))
    becomeLeader('t', () => order.push('C'))

    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['A'])

    releaseA()
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['A', 'B'])

    releaseB()
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['A', 'B', 'C'])
  })

  it('falls back to immediate-leader when navigator.locks is missing', async () => {
    uninstallFakeLocks()
    const onAcquired = vi.fn()
    becomeLeader('t', onAcquired)
    await new Promise((r) => setTimeout(r, 10))
    expect(onAcquired).toHaveBeenCalledTimes(1)
  })

  it('release after no-locks fallback is a no-op', () => {
    uninstallFakeLocks()
    const release = becomeLeader('t', () => {})
    expect(() => release()).not.toThrow()
  })

  it('errors thrown inside onAcquired do not block release', async () => {
    const onA = vi.fn(() => { throw new Error('boom') })
    const onB = vi.fn()
    const releaseA = becomeLeader('t', onA)
    becomeLeader('t', onB)

    await new Promise((r) => setTimeout(r, 10))
    expect(onA).toHaveBeenCalled()
    expect(onB).not.toHaveBeenCalled()

    releaseA()
    await new Promise((r) => setTimeout(r, 10))
    expect(onB).toHaveBeenCalled()
  })
})
