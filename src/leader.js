/**
 * Single-leader election across browser tabs using the Web Locks API.
 *
 * Only one tab at a time holds the named lock. Followers wait in a queue.
 * When the leader's tab closes (or it explicitly releases), the browser
 * promotes the next waiter — no heartbeats, no stale-leader risk.
 *
 * No-deadlock guarantees:
 *  - Single named lock, single mode → no circular wait
 *  - Lock auto-releases on tab unload, crash, or page navigation
 *  - The promise pattern means the lock is always scoped to a Promise
 *
 * Falls back to "always leader" on browsers without navigator.locks.
 */
export function becomeLeader(name, onAcquired) {
  // Fallback for browsers without Web Locks (very old)
  if (!globalThis.navigator?.locks?.request) {
    Promise.resolve().then(() => onAcquired())
    return () => {} // no-op release
  }

  let releaseFn = null
  navigator.locks.request(name, { mode: 'exclusive' }, async () => {
    try {
      await onAcquired()
    } catch (e) {
      console.error(`[Leadtodeed:leader] onAcquired threw:`, e)
    }
    // Hold the lock until release() is called or the tab unloads.
    await new Promise((resolve) => {
      releaseFn = resolve
    })
  }).catch((e) => {
    console.error(`[Leadtodeed:leader] lock request failed:`, e)
  })

  return () => {
    if (releaseFn) {
      releaseFn()
      releaseFn = null
    }
  }
}
