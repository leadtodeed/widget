/**
 * Web Locks primitives for tab leadership.
 *
 * Unlike the previous becomeLeader() (every tab queued on one lock forever,
 * FIFO — so a dead leader's lock passed to the *second-oldest* tab, usually
 * also frozen), these primitives never queue: a request either takes the lock
 * now (`ifAvailable`), takes it by force (`steal`), or reports failure. Who
 * should hold the lock is decided by the negotiation protocol in
 * leadership.js, not by browser queue order.
 *
 * A held lock also exempts the page from Chrome's Energy Saver freezing,
 * which is exactly what we want for the leader and candidate tabs; follower
 * tabs hold nothing and may freeze freely.
 */

/**
 * Request a Web Lock and hold it until release() is called.
 *
 * Returns:
 *   acquired — Promise<boolean>: true once the lock is held, false if
 *              ifAvailable missed or the request failed.
 *   release  — releases the lock voluntarily (idempotent).
 *   deposed  — Promise that resolves if the lock is stolen by another tab
 *              while held. Never resolves for a voluntary release.
 *
 * Browsers without navigator.locks behave as instantly-acquired and never
 * deposed — single-tab semantics, mirroring the previous fallback.
 */
export function requestHold(name, { steal = false, ifAvailable = false } = {}) {
  if (!globalThis.navigator?.locks?.request) {
    return { acquired: Promise.resolve(true), release: () => {}, deposed: new Promise(() => {}) }
  }

  let resolveAcquired
  let resolveDeposed
  let releaseHold
  const acquired = new Promise((r) => { resolveAcquired = r })
  const deposed = new Promise((r) => { resolveDeposed = r })
  const holding = new Promise((r) => { releaseHold = r })
  let wasAcquired = false

  navigator.locks
    .request(name, { mode: 'exclusive', steal, ifAvailable }, async (lock) => {
      if (!lock) {
        // ifAvailable miss — someone else holds it.
        resolveAcquired(false)
        return
      }
      wasAcquired = true
      resolveAcquired(true)
      await holding
    })
    .then(() => {
      // Voluntary release (or ifAvailable miss) — not a depose.
    })
    .catch(() => {
      // AbortError: the held lock was stolen, or the request itself failed.
      resolveAcquired(false)
      if (wasAcquired) resolveDeposed()
    })

  return { acquired, release: () => releaseHold(), deposed }
}

/**
 * Whether some tab currently holds `name`. Returns null when the query API
 * is unavailable — callers must treat that as "unknown", not "free".
 */
export async function isLockHeld(name) {
  try {
    const snapshot = await navigator.locks.query()
    return (snapshot.held || []).some((l) => l.name === name)
  } catch {
    return null
  }
}
