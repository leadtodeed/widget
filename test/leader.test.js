import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { requestHold, isLockHeld } from '../src/leader.js'

// Minimal navigator.locks fake supporting exclusive holds, ifAvailable,
// steal, and query — the surface leadership.js relies on.
export function installFakeLocks() {
  const held = new Map()   // name -> entry
  const queues = new Map() // name -> [entry]

  function settleGrant(name, entry) {
    Promise.resolve()
      .then(() => entry.callback({ name }))
      .then(
        (v) => {
          if (held.get(name) === entry) {
            held.delete(name)
            runNext(name)
          }
          if (!entry.settled) { entry.settled = true; entry.resolve(v) }
        },
        (err) => {
          if (held.get(name) === entry) {
            held.delete(name)
            runNext(name)
          }
          if (!entry.settled) { entry.settled = true; entry.reject(err) }
        }
      )
  }

  function runNext(name) {
    const queue = queues.get(name) || []
    const entry = queue.shift()
    if (!entry) return
    held.set(name, entry)
    settleGrant(name, entry)
  }

  const locks = {
    request(name, opts, callback) {
      if (typeof opts === 'function') {
        callback = opts
        opts = {}
      }
      return new Promise((resolve, reject) => {
        const entry = { callback, resolve, reject, settled: false }
        const holder = held.get(name)
        if (!holder) {
          held.set(name, entry)
          settleGrant(name, entry)
        } else if (opts.steal) {
          held.delete(name)
          if (!holder.settled) {
            holder.settled = true
            holder.reject(new DOMException('lock stolen', 'AbortError'))
          }
          held.set(name, entry)
          settleGrant(name, entry)
        } else if (opts.ifAvailable) {
          // Spec: callback runs with null and the request resolves normally.
          Promise.resolve()
            .then(() => entry.callback(null))
            .then((v) => resolve(v), (err) => reject(err))
        } else {
          const queue = queues.get(name) || []
          queue.push(entry)
          queues.set(name, queue)
        }
      })
    },
    query: async () => ({
      held: [...held.keys()].map((name) => ({ name })),
      pending: [],
    }),
  }

  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: locks,
  })
  return locks
}

export function uninstallFakeLocks() {
  try {
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: undefined,
    })
  } catch { /* ignore */ }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('requestHold', () => {
  beforeEach(() => installFakeLocks())
  afterEach(() => uninstallFakeLocks())

  it('acquires a free lock', async () => {
    const hold = requestHold('t', { ifAvailable: true })
    expect(await hold.acquired).toBe(true)
  })

  it('ifAvailable reports false on a held lock without disturbing the holder', async () => {
    const first = requestHold('t', { ifAvailable: true })
    expect(await first.acquired).toBe(true)

    const second = requestHold('t', { ifAvailable: true })
    expect(await second.acquired).toBe(false)

    // Holder is untouched.
    expect(await isLockHeld('t')).toBe(true)
  })

  it('steal takes the lock and resolves the old holder\'s deposed promise', async () => {
    const victim = requestHold('t', { ifAvailable: true })
    expect(await victim.acquired).toBe(true)
    let deposed = false
    victim.deposed.then(() => { deposed = true })

    const thief = requestHold('t', { steal: true })
    expect(await thief.acquired).toBe(true)
    await tick()
    expect(deposed).toBe(true)
  })

  it('voluntary release does not resolve deposed and frees the lock', async () => {
    const hold = requestHold('t', { ifAvailable: true })
    expect(await hold.acquired).toBe(true)
    let deposed = false
    hold.deposed.then(() => { deposed = true })

    hold.release()
    await tick()
    expect(deposed).toBe(false)
    expect(await isLockHeld('t')).toBe(false)

    const next = requestHold('t', { ifAvailable: true })
    expect(await next.acquired).toBe(true)
  })

  it('falls back to instantly-acquired without navigator.locks', async () => {
    uninstallFakeLocks()
    const hold = requestHold('t')
    expect(await hold.acquired).toBe(true)
    expect(() => hold.release()).not.toThrow()
  })
})

describe('isLockHeld', () => {
  beforeEach(() => installFakeLocks())
  afterEach(() => uninstallFakeLocks())

  it('reflects held state', async () => {
    expect(await isLockHeld('t')).toBe(false)
    const hold = requestHold('t', { ifAvailable: true })
    await hold.acquired
    expect(await isLockHeld('t')).toBe(true)
  })

  it('returns null when the query API is unavailable', async () => {
    uninstallFakeLocks()
    expect(await isLockHeld('t')).toBe(null)
  })
})
