/**
 * Tab leadership protocol — decides which same-origin tab owns the SIP
 * registration (and the call-events WS), and moves that ownership to
 * wherever the user actually is.
 *
 * Replaces the old first-tab-wins-forever Web Lock: there, a leader tab
 * suspended by the OS/browser kept the lock while its registration rotted,
 * and the FIFO queue promoted the *second-oldest* (usually also frozen) tab
 * on release — the user typed away in the newest tab while the extension
 * sat offline.
 *
 * Roles and locks (both origin-scoped Web Locks, held — never queued):
 *   leader    — holds LEADER_LOCK; runs the registered SIP UA + events WS.
 *   candidate — holds CANDIDATE_LOCK (strictly one at a time); warms a
 *               standby transport and negotiates a takeover.
 *   follower  — holds nothing; may freeze freely.
 *
 * Protocol invariants (agreed 2026-07-09):
 *   - A new tab never affects a ringing/connected, *responsive* leader.
 *   - Candidacy is user-input-gated (the future leader tab needs a gesture
 *     for audio/mic anyway); cold start is the exception — the first tab
 *     leads without input.
 *   - Make-before-break: the candidate REGISTERs (on its pre-warmed socket)
 *     before the leader unregisters. REGISTER is deferred while the leader
 *     is in a call so calls keep single-contact semantics.
 *   - Yield to freshest: candidacy follows the most recent user input.
 *   - Dead leader (no BroadcastChannel reply): steal after a grace period —
 *     short when last seen idle, long (10 min) when last seen in a call.
 *   - Succession after the leader closes: freshest-input tab wins a
 *     staleness-staggered race; tabs without any input ever join the race
 *     last (audio-unlock guarantee).
 */

import { requestHold, isLockHeld } from './leader.js'
import { msSinceLastInputRaw, hasEverHadInput, onUserInput } from './activity.js'

// New lock names (old code queues forever on 'leadtodeed-sip'; sharing a name
// would hand our released locks to old-code tabs mid-rollout).
const LEADER_LOCK = 'leadtodeed-sip-leader'
const CANDIDATE_LOCK = 'leadtodeed-sip-candidate'
const CHANNEL_NAME = 'leadtodeed-leadership'

const LEADER_HEARTBEAT_MS = 10_000
// Leader considered silent after this much quiet. Sits above Chrome's 1/min
// hidden-tab timer throttling so a merely-backgrounded leader isn't flagged.
const LEADER_SILENT_MS = 75_000
const PONG_TIMEOUT_MS = 5_000
// Grace before stealing from a silent leader, by its last known phase.
const DEAD_IDLE_GRACE_MS = 30_000
const DEAD_INCALL_GRACE_MS = 600_000 // 10 min — user-specified
// "Fresh input" — both the candidacy trigger and the leader-active abort.
const INPUT_FRESH_MS = 5_000
const CANDIDACY_DEBOUNCE_MS = 2_000
// A candidate yields only to a tab fresher by at least this margin.
const YIELD_MARGIN_MS = 5_000
const YIELD_TIMEOUT_MS = 5_000
// Succession race: delay ∝ input staleness, so the freshest tab claims first.
// After an explicit lead_bye the leader is KNOWN gone and the stagger only
// has to ORDER the race, not hedge against false positives — so it is
// compressed to ~0-2s (a call arriving seconds after the leader tab closes
// must find a registered successor). Silence-triggered vacancy keeps the
// lazy pace: its false positive (a throttled-but-alive leader) is cheap
// because the candidacy aborts on the first heartbeat/pong anyway.
const BYE_STAGGER_MS_PER_SECOND = 50
const BYE_STAGGER_MAX_MS = 2_000
const BYE_NO_INPUT_STAGGER_MS = 5_000
const VACANCY_STAGGER_MS_PER_SECOND = 250
const VACANCY_STAGGER_MAX_MS = 30_000
const NO_INPUT_STAGGER_MS = 45_000 // zero-input tabs go last
// Health gate: a leader that stays SIP-unregistered this long while idle and
// online is not coming back (its watchdog has had ≥2 restart cycles by now)
// — it self-demotes so the bye-succession can move the phone to a tab whose
// transport works. Leadership alone is worthless without a registration:
// on 2026-07-30 an alive-and-responsive hidden leader sat unregistered for
// minutes, answering probes and thereby fending off every candidacy, while
// inbound calls rang mobiles only.
const UNHEALTHY_AFTER_MS = 60_000
// After self-demoting, sit out succession for a while. The demoted tab
// usually has the freshest lock on "recently was leader" state and would win
// its own bye race, reconnect on the same broken conditions, and loop. Real
// user input overrides this — if the user is HERE, this tab is where the
// phone should be, and a fresh connect() from an input-driven candidacy gets
// a brand-new socket that may well work.
const SELF_DEMOTE_COOLDOWN_MS = 30_000

export class LeadershipManager {
  constructor({
    phone,
    getPhase,
    onLeader = null,
    onFollower = null,
    reporter = null,
    sessionId = null,
    // Injectable for tests (module-level activity state is shared per page,
    // which is exactly wrong when simulating multiple tabs in one process).
    getInputAgeMs = msSinceLastInputRaw,
    getHasEverHadInput = hasEverHadInput,
    subscribeInput = onUserInput,
    // How many sibling tabs exist (index.js counts them via bc_hello). The
    // health gate only self-demotes when there is someone to succeed us —
    // a lone unhealthy tab keeps trying rather than orphaning the phone.
    getNeighborCount = null,
  }) {
    this._phone = phone
    this._getPhase = getPhase
    this._onLeader = onLeader
    this._onFollower = onFollower
    this._reporter = reporter || phone?.reporter || null
    this._id = sessionId || phone?.sessionId || `${Math.random()}`.slice(2)
    this._getInputAgeMs = getInputAgeMs
    this._getHasEverHadInput = getHasEverHadInput
    this._subscribeInput = subscribeInput
    this._getNeighborCount = getNeighborCount

    this._role = 'follower'
    this._leaderHold = null
    this._candidate = null // { hold, cancelled, warmed }
    this._handingOff = false
    this._shutdown = false

    this._channel = null
    this._waiters = [] // [{ types, filter, resolve, timer }]

    this._heartbeatTimer = null
    this._lastBroadcastPhase = null
    this._vacancyTimer = null
    this._vacancyClaimTimer = null
    this._unsubscribeInput = null
    this._lastCandidacyTriggerAt = 0

    this._startedAt = Date.now()
    this._lastLeaderSeenAt = 0
    this._lastLeaderPhase = null

    // Health-gate state (leader side).
    this._unregisteredSince = null
    this._selfDemotedAt = 0
  }

  get role() {
    return this._role
  }

  get isLeader() {
    return this._role === 'leader'
  }

  /**
   * Cold-start election + protocol listeners. The first tab of a session
   * takes the leader lock immediately (no input gate — someone must
   * register); everyone else stays a lock-free follower.
   */
  async start() {
    try {
      this._channel = new BroadcastChannel(CHANNEL_NAME)
      this._channel.onmessage = (e) => this._onMessage(e.data || {})
    } catch {
      // No BroadcastChannel (SSR/ancient browsers): no negotiation possible.
      // requestHold's no-locks fallback keeps single-tab semantics working.
    }

    this._unsubscribeInput = this._subscribeInput(() => this._onInput())
    this._startVacancyWatch()

    const hold = requestHold(LEADER_LOCK, { ifAvailable: true })
    if (await hold.acquired) {
      this._adoptLeadership(hold, 'cold_start')
      try {
        await this._phone.connect()
      } catch (e) {
        console.error('[Leadtodeed] leader connect failed:', e)
      }
    }
  }

  /** Host-initiated full stop (page teardown / phone.disconnect). */
  shutdown() {
    if (this._shutdown) return
    this._shutdown = true
    if (this._role === 'leader') {
      this._report('info', 'leader_released', 'shutdown')
      // Accelerate succession: followers race on the bye instead of waiting
      // out the silence threshold.
      this._send({ type: 'lead_bye', from: this._id })
    }
    this._stopHeartbeat()
    if (this._vacancyTimer) {
      clearInterval(this._vacancyTimer)
      this._vacancyTimer = null
    }
    if (this._vacancyClaimTimer) {
      clearTimeout(this._vacancyClaimTimer)
      this._vacancyClaimTimer = null
    }
    if (this._unsubscribeInput) {
      this._unsubscribeInput()
      this._unsubscribeInput = null
    }
    // Candidate teardown without stopSip — the host's disconnect() follows.
    if (this._candidate) {
      this._candidate.cancelled = true
      this._candidate.hold.release()
      this._candidate = null
    }
    this._leaderHold?.release()
    this._leaderHold = null
    this._role = 'follower'
    for (const w of this._waiters.splice(0)) {
      clearTimeout(w.timer)
      w.resolve(null)
    }
    try { this._channel?.close() } catch { /* ignore */ }
    this._channel = null
  }

  /**
   * Called by the orchestrator on every state render. The leader broadcasts
   * phase transitions immediately so a deferred candidate can complete its
   * takeover the moment a call ends (post-call rebalance).
   */
  onPhaseChange(phase) {
    if (this._role !== 'leader') return
    if (phase === this._lastBroadcastPhase) return
    this._lastBroadcastPhase = phase
    this._sendHeartbeat()
  }

  // --- Messaging ---

  _send(msg) {
    try { this._channel?.postMessage(msg) } catch { /* ignore */ }
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.from === this._id) return

    // Passive leader tracking — any leader-originated message counts.
    if (msg.type === 'lead_heartbeat' || msg.type === 'lead_pong') {
      this._lastLeaderSeenAt = Date.now()
      if (msg.phase) this._lastLeaderPhase = msg.phase
    }
    if (msg.type === 'lead_bye') {
      this._lastLeaderSeenAt = 0
      this._lastLeaderPhase = null
      this._scheduleVacancyClaim('bye')
    }

    // Targeted/awaited replies.
    for (const w of this._waiters.slice()) {
      if (w.types.includes(msg.type) && (!w.filter || w.filter(msg))) {
        this._waiters = this._waiters.filter((x) => x !== w)
        clearTimeout(w.timer)
        w.resolve(msg)
      }
    }

    if (this._role === 'leader') {
      if (msg.type === 'lead_ping') {
        this._send({
          type: 'lead_pong',
          from: this._id,
          to: msg.from,
          phase: this._getPhase(),
          input_age_ms: this._getInputAgeMs(),
          registered: !!this._phone?.isRegistered,
        })
      } else if (msg.type === 'handoff_request') {
        if (this._getPhase() === 'idle') {
          this._handoffTo(msg.from)
        } else {
          this._send({ type: 'handoff_busy', from: this._id, to: msg.from, phase: this._getPhase() })
        }
      }
    }

    if (this._candidate && msg.type === 'yield_request') {
      // Yield to freshest: hand the candidacy over when the requester's user
      // is clearly more recent than ours.
      if (msg.input_age_ms + YIELD_MARGIN_MS < this._getInputAgeMs()) {
        this._abortCandidacy('yielded')
        this._send({ type: 'yield_done', from: this._id, to: msg.from })
      } else {
        // Decline EXPLICITLY. A silent decline is indistinguishable from a
        // frozen candidate, and the requester's no-reply timeout would steal
        // the candidacy — two alive tabs then ping-pong steals at each other
        // and neither ever finishes a takeover (observed in prod).
        this._send({ type: 'yield_denied', from: this._id, to: msg.from })
      }
    }
  }

  _waitMessage(types, { timeoutMs, filter = null } = {}) {
    return new Promise((resolve) => {
      const waiter = { types, filter, resolve, timer: null }
      waiter.timer = setTimeout(() => {
        this._waiters = this._waiters.filter((x) => x !== waiter)
        resolve(null)
      }, timeoutMs)
      this._waiters.push(waiter)
    })
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  _report(level, event, message = '', context = {}) {
    try { this._reporter?.report?.(level, event, message, context) } catch { /* ignore */ }
  }

  // --- Leader side ---

  _adoptLeadership(hold, via) {
    this._leaderHold = hold
    hold.deposed.then(() => this._onDeposed())
    this._role = 'leader'
    this._lastBroadcastPhase = null
    this._unregisteredSince = null
    this._startHeartbeat()
    this._report('info', 'leader_acquired', via)
    try { this._onLeader?.() } catch { /* host callback must not break us */ }
  }

  _startHeartbeat() {
    this._stopHeartbeat()
    this._sendHeartbeat()
    this._heartbeatTimer = setInterval(() => this._sendHeartbeat(), LEADER_HEARTBEAT_MS)
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }

  _sendHeartbeat() {
    this._send({
      type: 'lead_heartbeat',
      from: this._id,
      phase: this._getPhase(),
      input_age_ms: this._getInputAgeMs(),
      registered: !!this._phone?.isRegistered,
    })
    // Piggybacked on the heartbeat: it is the leader's only periodic timer,
    // and hidden-tab throttling slows both identically (the health window is
    // wall-clock, so late ticks still cross it).
    this._checkHealth()
  }

  /** Leader-side health gate: leadership without a SIP registration is a
   *  black hole — probes get answered (fending off candidacies) while calls
   *  ring nobody. When the registration has been gone past the grace and the
   *  watchdog clearly isn't winning, hand the phone to a tab that can. */
  _checkHealth() {
    if (this._role !== 'leader' || this._shutdown) return
    if (this._phone?.isRegistered) {
      this._unregisteredSince = null
      return
    }
    // Non-idle phases keep leadership: media can outlive a dead signalling
    // socket, and never-kill-a-live-call outranks the health gate.
    if (this._getPhase() !== 'idle') return
    if (this._unregisteredSince === null) {
      this._unregisteredSince = Date.now()
      return
    }
    if (Date.now() - this._unregisteredSince < UNHEALTHY_AFTER_MS) return
    // Offline means every tab would fail the same way — churning leadership
    // buys nothing; the watchdog retries once the network returns.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    // A lone tab has nobody to succeed it, so demoting would orphan the phone
    // outright. That is why this used to bail — but bailing left the black
    // hole this gate exists to close: on 2026-08-05 exts 7934/7935 sat here
    // for hours with neighbor_tabs=0, unregistered, answering probes while
    // every click-to-call was dropped. With no successor the only move left
    // is to fix ourselves, so kick the transport instead of standing down.
    if ((this._getNeighborCount?.() ?? 0) < 1) {
      this._reviveAlone()
      return
    }
    this._selfDemote()
  }

  /** Sole-tab self-heal: rebuild our own transport rather than hand over.
   *  Rate-limited by resetting _unregisteredSince, so this retries on the
   *  same UNHEALTHY_AFTER_MS cadence the demotion path uses rather than
   *  firing on every heartbeat. */
  _reviveAlone() {
    this._report('warn', 'leader_revive_alone', 'unhealthy', {
      unregistered_ms: Date.now() - (this._unregisteredSince || Date.now()),
    })
    this._unregisteredSince = null
    try {
      this._phone?.reviveTransport?.()
    } catch { /* best effort — the watchdog is still running underneath */ }
  }

  _selfDemote() {
    this._report('warn', 'leader_released', 'unhealthy', {
      unregistered_ms: Date.now() - (this._unregisteredSince || Date.now()),
      neighbor_tabs: this._getNeighborCount?.() ?? null,
    })
    this._selfDemotedAt = Date.now()
    this._unregisteredSince = null
    // Same shape as shutdown's succession kick: bye first so followers race
    // immediately, then teardown + release so the winner's lock grab finds
    // it free (and steals if the release is still in flight).
    this._send({ type: 'lead_bye', from: this._id })
    this._demote()
    this._phone.stopSip()
    this._leaderHold?.release()
    this._leaderHold = null
  }

  _demote() {
    this._stopHeartbeat()
    this._role = 'follower'
    try { this._onFollower?.() } catch { /* ignore */ }
  }

  /** Cooperative handoff to a registered candidate. Candidate REGISTERed
   *  before asking (make-before-break), so teardown-then-ack leaves no gap. */
  _handoffTo(to) {
    if (this._role !== 'leader' || this._handingOff) return
    this._handingOff = true
    try {
      this._report('info', 'leader_handoff', '', { to })
      this._demote()
      this._phone.stopSip()
      this._leaderHold?.release()
      this._leaderHold = null
      this._send({ type: 'handoff_ack', from: this._id, to })
    } finally {
      this._handingOff = false
    }
  }

  /** Our leader lock was stolen — we were silent past the grace period
   *  (frozen, or resumed too late). */
  _onDeposed() {
    if (this._role !== 'leader') return
    this._report('warn', 'leader_deposed')
    this._leaderHold = null
    this._demote()
    if (this._phone.isInCall) {
      // Invariant: never kill a live call. If media is somehow still up,
      // keep the SIP session until it ends, then release the transport.
      const onEnd = () => {
        this._phone.off?.('callEnded', onEnd)
        this._phone.stopSip()
      }
      this._phone.on('callEnded', onEnd)
    } else {
      this._phone.stopSip()
    }
  }

  // --- Candidate side ---

  _onInput() {
    if (this._shutdown || this._role !== 'follower' || this._candidate) return
    const now = Date.now()
    if (now - this._lastCandidacyTriggerAt < CANDIDACY_DEBOUNCE_MS) return
    this._lastCandidacyTriggerAt = now
    this._startCandidacy('input')
  }

  async _startCandidacy(trigger, { stealCandidateLock = false } = {}) {
    if (this._shutdown || this._role !== 'follower' || this._candidate) return
    // A freshly self-demoted tab sits out silence/bye races — it would win
    // on recency and loop right back into the same broken transport. Real
    // user input here overrides the cooldown: the phone belongs with the
    // user, and an input-driven candidacy rebuilds the stack from scratch.
    if (trigger.startsWith('vacancy') &&
        this._selfDemotedAt &&
        Date.now() - this._selfDemotedAt < SELF_DEMOTE_COOLDOWN_MS) return
    const hold = requestHold(CANDIDATE_LOCK, {
      ifAvailable: !stealCandidateLock,
      steal: stealCandidateLock,
    })
    if (!(await hold.acquired)) {
      this._requestYield()
      return
    }
    const candidate = { hold, cancelled: false, warmed: false }
    this._candidate = candidate
    this._role = 'candidate'
    hold.deposed.then(() => {
      // A fresher tab stole the candidacy from us (we were frozen or slow).
      if (this._candidate === candidate) this._abortCandidacy('candidacy_stolen')
    })
    this._report('info', 'leader_candidacy_started', trigger)
    try {
      await this._runCandidacy(trigger)
    } catch (e) {
      this._report('warn', 'leader_candidacy_failed', e?.message || 'error')
      this._abortCandidacy('error')
    }
  }

  _cancelled(candidate) {
    return this._shutdown || this._candidate !== candidate || candidate.cancelled
  }

  async _runCandidacy(trigger) {
    const candidate = this._candidate
    // A vacancy race already believes the leader is gone — when the lock is
    // verifiably free, take over immediately instead of spending a probe
    // timeout waiting for a pong from a dead tab. (Held-or-unknown falls
    // through to the probe loop: the "vacancy" may be a false positive.)
    if (trigger.startsWith('vacancy')) {
      const held = await isLockHeld(LEADER_LOCK)
      if (this._cancelled(candidate)) return
      if (held === false) return this._takeover('vacancy')
    }
    while (!this._cancelled(candidate)) {
      const pong = await this._probeLeader()
      if (this._cancelled(candidate)) return

      if (pong) {
        // A vacancy/bye race that found a live leader stands down — unless
        // the leader admits its registration is gone: alive-but-unregistered
        // is exactly the black hole the health gate exists for, and its own
        // self-demotion may be a broken build away. `!== false` keeps the
        // old deference for pre-health-gate leaders that don't send the flag.
        const unhealthy = pong.registered === false
        if (trigger.startsWith('vacancy') && !unhealthy) {
          return this._abortCandidacy('leader_alive')
        }
        if (!unhealthy &&
            typeof pong.input_age_ms === 'number' && pong.input_age_ms < INPUT_FRESH_MS) {
          // The user is at the leader right now — no point moving it.
          return this._abortCandidacy('leader_active')
        }
        if (pong.phase === 'idle') return this._takeover('handoff')
        // Leader is on a call: warm up without REGISTER (single contact
        // during calls) and hold until the idle transition.
        await this._ensureWarm(candidate)
        if (this._cancelled(candidate)) return
        const outcome = await this._waitLeaderIdle(candidate)
        if (this._cancelled(candidate)) return
        if (outcome === 'idle') return this._takeover('handoff')
        continue // leader went silent mid-call — loop into the dead-leader path
      }

      // No reply. Distinguish a vacant lock from a held-but-frozen leader.
      const held = await isLockHeld(LEADER_LOCK)
      if (this._cancelled(candidate)) return
      if (held === false) return this._takeover('vacancy')
      const anchor = this._lastLeaderSeenAt || this._startedAt
      const grace = this._lastLeaderPhase && this._lastLeaderPhase !== 'idle'
        ? DEAD_INCALL_GRACE_MS
        : DEAD_IDLE_GRACE_MS
      const silentFor = Date.now() - anchor
      if (silentFor >= grace) return this._takeover('steal')
      await this._sleep(Math.min(PONG_TIMEOUT_MS, Math.max(1000, grace - silentFor)))
    }
  }

  async _probeLeader() {
    this._send({ type: 'lead_ping', from: this._id })
    // Any heartbeat counts as proof of life, not just our targeted pong.
    return this._waitMessage(['lead_pong', 'lead_heartbeat'], {
      timeoutMs: PONG_TIMEOUT_MS,
      filter: (m) => m.type === 'lead_heartbeat' || m.to === this._id,
    })
  }

  async _ensureWarm(candidate) {
    if (candidate.warmed) return
    await this._phone.connect({ register: false })
    candidate.warmed = true
  }

  /** Wait for the leader's phase to hit idle (heartbeats broadcast phase
   *  transitions immediately). Returns 'idle' or 'silent'. */
  async _waitLeaderIdle(candidate) {
    for (;;) {
      if (this._cancelled(candidate)) return 'cancelled'
      if (this._lastLeaderPhase === 'idle') return 'idle'
      if (Date.now() - this._lastLeaderSeenAt > LEADER_SILENT_MS) return 'silent'
      const msg = await this._waitMessage(['lead_heartbeat'], { timeoutMs: LEADER_HEARTBEAT_MS })
      if (msg === null) continue // re-check silence on timeout
    }
  }

  async _takeover(mode) {
    const candidate = this._candidate
    if (!candidate || this._cancelled(candidate)) return

    await this._ensureWarm(candidate)
    if (this._cancelled(candidate)) return
    // Make-before-break: REGISTER (adds our contact alongside the leader's)
    // before asking the leader to drop out. A standby socket that died while
    // we held candidacy fails here fast — abort and retry on the next input.
    await this._phone.register()
    if (this._cancelled(candidate)) {
      this._phone.stopSip()
      return
    }

    if (mode === 'handoff') {
      this._send({ type: 'handoff_request', from: this._id })
      const reply = await this._waitMessage(['handoff_ack', 'handoff_busy'], {
        timeoutMs: PONG_TIMEOUT_MS,
        filter: (m) => m.to === this._id,
      })
      if (this._cancelled(candidate)) {
        this._phone.stopSip()
        return
      }
      if (!reply) {
        mode = 'steal' // leader died between the pong and our request
      } else if (reply.type === 'handoff_busy') {
        // A call arrived in the instant between the idle pong and our
        // request. We're already registered (that fork briefly rings us too
        // — where the user is, so acceptable); wait out the call, then ask
        // again.
        const outcome = await this._waitLeaderIdle(candidate)
        if (this._cancelled(candidate)) {
          this._phone.stopSip()
          return
        }
        return this._takeover(outcome === 'idle' ? 'handoff' : 'steal')
      }
    }

    let hold
    if (mode === 'steal') {
      hold = requestHold(LEADER_LOCK, { steal: true })
    } else {
      hold = requestHold(LEADER_LOCK, { ifAvailable: true })
      if (!(await hold.acquired)) {
        // Should be free after an ack/vacancy — a holder here is a stale
        // hold from a tab that no longer answers. Take it.
        hold = requestHold(LEADER_LOCK, { steal: true })
      }
    }
    if (!(await hold.acquired)) {
      this._report('warn', 'leader_takeover_failed', mode)
      return this._abortCandidacy('lock_failed')
    }
    if (this._cancelled(candidate)) {
      hold.release()
      this._phone.stopSip()
      return
    }

    this._candidate = null
    candidate.hold.release()
    this._adoptLeadership(hold, mode)
  }

  _abortCandidacy(reason) {
    const candidate = this._candidate
    if (!candidate) return
    candidate.cancelled = true
    candidate.hold.release()
    this._candidate = null
    if (this._role === 'candidate') this._role = 'follower'
    if (candidate.warmed) this._phone.stopSip()
    this._report('info', 'leader_candidacy_aborted', reason)
  }

  /** Another tab holds the candidacy. Ask it to yield; if it's frozen and
   *  never answers while our user is active, take the candidacy by force.
   *  An explicit yield_denied means it's alive and staying — back off until
   *  the next input instead of stealing from a healthy candidate. */
  _requestYield() {
    this._send({ type: 'yield_request', from: this._id, input_age_ms: this._getInputAgeMs() })
    this._waitMessage(['yield_done', 'yield_denied'], {
      timeoutMs: YIELD_TIMEOUT_MS,
      filter: (m) => m.to === this._id,
    }).then((reply) => {
      if (this._shutdown || this._role !== 'follower' || this._candidate) return
      if (reply?.type === 'yield_done') {
        this._startCandidacy('yield')
      } else if (!reply && this._getInputAgeMs() < YIELD_TIMEOUT_MS + INPUT_FRESH_MS) {
        // Only total silence past the timeout counts as "frozen".
        this._startCandidacy('yield_steal', { stealCandidateLock: true })
      }
    })
  }

  // --- Succession (leader tab closed or froze) ---

  _startVacancyWatch() {
    this._vacancyTimer = setInterval(() => {
      if (this._shutdown || this._role !== 'follower' || this._candidate) return
      const anchor = this._lastLeaderSeenAt || this._startedAt
      if (Date.now() - anchor > LEADER_SILENT_MS) this._scheduleVacancyClaim('silence')
    }, LEADER_HEARTBEAT_MS + 5_000)
  }

  _scheduleVacancyClaim(why) {
    if (this._shutdown || this._role !== 'follower' || this._candidate) return
    if (this._vacancyClaimTimer) return
    // Staleness-staggered race: the freshest-input tab claims first; tabs the
    // user never touched go last (they can't play audio without a gesture).
    const inputAgeS = this._getInputAgeMs() / 1000
    const delay = why === 'bye'
      ? (this._getHasEverHadInput()
        ? Math.min(inputAgeS * BYE_STAGGER_MS_PER_SECOND, BYE_STAGGER_MAX_MS)
        : BYE_NO_INPUT_STAGGER_MS)
      : (this._getHasEverHadInput()
        ? Math.min(inputAgeS * VACANCY_STAGGER_MS_PER_SECOND, VACANCY_STAGGER_MAX_MS)
        : NO_INPUT_STAGGER_MS)
    const jitter = Math.random() * (why === 'bye' ? 250 : 500)
    this._vacancyClaimTimer = setTimeout(() => {
      this._vacancyClaimTimer = null
      if (this._shutdown || this._role !== 'follower' || this._candidate) return
      // Someone fresher may have already claimed during our stagger.
      const anchor = this._lastLeaderSeenAt
      if (anchor && Date.now() - anchor < LEADER_SILENT_MS) return
      this._startCandidacy(`vacancy_${why}`)
    }, delay + jitter)
  }
}
