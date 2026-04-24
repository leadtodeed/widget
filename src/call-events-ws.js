/**
 * WebSocket client for real-time call participant events.
 * Connects to the WebRTC backend's /api/call/events endpoint.
 *
 * Resilience:
 * - Application-level heartbeat: sends {"type":"ping"} every HEARTBEAT_INTERVAL
 *   to keep idle intermediaries from dropping the TCP connection.
 * - Stuck detection: if no message has been received for STUCK_TIMEOUT the
 *   connection is considered dead even if readyState still says OPEN, the
 *   socket is closed and a reconnect is scheduled.
 * - Auto-reconnect with exponential backoff on any close (graceful or not),
 *   unless disconnect() was called explicitly.
 */

const HEARTBEAT_INTERVAL = 25_000   // 25s — below typical 30–60s proxy idle timeouts
const STUCK_TIMEOUT = 60_000        // 60s without any inbound message → force reconnect
const RECONNECT_BASE_DELAY = 1_000  // 1s
const RECONNECT_MAX_DELAY = 30_000  // 30s cap

export class CallEventsSocket {
  constructor({ url, token, reporter, onParticipantJoined, onParticipantLeft, onCallEnded, onRefresh }) {
    this._url = url
    this._token = token
    this._reporter = reporter
    this._ws = null
    this._callbacks = { onParticipantJoined, onParticipantLeft, onCallEnded, onRefresh }
    this._closedByUser = false
    this._reconnectAttempts = 0
    this._heartbeatTimer = null
    this._stuckTimer = null
    this._reconnectTimer = null
    this._lastMessageAt = 0
  }

  connect() {
    if (this._ws) return
    this._closedByUser = false
    this._openSocket()
  }

  disconnect() {
    this._closedByUser = true
    this._clearTimers()
    if (this._ws) {
      try { this._ws.close() } catch { /* ignore */ }
      this._ws = null
    }
  }

  _openSocket() {
    // Pass JWT via Sec-WebSocket-Protocol ("bearer.<jwt>") instead of a query
    // string so the token never appears in URLs or access logs. Server echoes
    // the same protocol back to accept the handshake.
    this._ws = new WebSocket(this._url, [`bearer.${this._token}`])
    this._lastMessageAt = Date.now()

    this._ws.onopen = () => {
      this._reconnectAttempts = 0
      this._startHeartbeat()
      this._armStuckTimer()
    }

    this._ws.onmessage = (event) => {
      this._lastMessageAt = Date.now()
      this._armStuckTimer()
      try {
        const data = JSON.parse(event.data)
        switch (data.type) {
          case 'participant_joined':
            this._callbacks.onParticipantJoined?.(data)
            break
          case 'participant_left':
            this._callbacks.onParticipantLeft?.(data)
            break
          case 'call_ended':
            this._callbacks.onCallEnded?.(data)
            break
          case 'refresh':
            // Server-initiated force-reload. The orchestrator (index.js)
            // decides whether to reload immediately or defer until the
            // current call ends.
            this._callbacks.onRefresh?.(data)
            break
          case 'pong':
            // Heartbeat ack — already refreshed above
            break
        }
      } catch (e) {
        console.error('[Leadtodeed] WS message parse error:', e)
      }
    }

    this._ws.onerror = (e) => {
      console.error('[Leadtodeed] WS error:', e)
      this._reporter?.report('error', 'call_events_ws_error', 'WebSocket error', {
        readyState: this._ws?.readyState ?? null,
        attempts: this._reconnectAttempts,
      })
    }

    this._ws.onclose = (e) => {
      this._clearTimers()
      this._ws = null
      if (!this._closedByUser) {
        this._reporter?.report('warn', 'call_events_ws_closed', e?.reason || 'closed', {
          code: e?.code ?? null,
          wasClean: e?.wasClean ?? null,
          attempts: this._reconnectAttempts,
        })
        this._scheduleReconnect()
      }
    }
  }

  _startHeartbeat() {
    this._clearHeartbeat()
    this._heartbeatTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        try { this._ws.send(JSON.stringify({ type: 'ping' })) } catch { /* will be caught by onclose */ }
      }
    }, HEARTBEAT_INTERVAL)
  }

  _armStuckTimer() {
    this._clearStuckTimer()
    this._stuckTimer = setTimeout(() => {
      console.warn('[Leadtodeed] WS stuck — no messages for', STUCK_TIMEOUT, 'ms, reconnecting')
      this._reporter?.report('warn', 'call_events_ws_stuck', `no messages for ${STUCK_TIMEOUT}ms`)
      this._forceReconnect()
    }, STUCK_TIMEOUT)
  }

  _forceReconnect() {
    // Close whatever we have; onclose handler will schedule a reconnect.
    if (this._ws) {
      try { this._ws.close() } catch { /* ignore */ }
    }
  }

  _scheduleReconnect() {
    this._clearReconnect()
    const delay = Math.min(
      RECONNECT_BASE_DELAY * (2 ** this._reconnectAttempts),
      RECONNECT_MAX_DELAY
    )
    this._reconnectAttempts += 1
    // Tripwires: we keep retrying forever, but flag to backend so ops see
    // "this widget has been trying to reconnect for a long time".
    if (this._reconnectAttempts === 20 || this._reconnectAttempts === 100) {
      this._reporter?.report('warn', 'call_events_ws_struggling', 'repeated reconnect attempts', {
        attempts: this._reconnectAttempts,
        next_delay_ms: delay,
      })
    }
    this._reconnectTimer = setTimeout(() => {
      if (!this._closedByUser) this._openSocket()
    }, delay)
  }

  _clearTimers() {
    this._clearHeartbeat()
    this._clearStuckTimer()
    this._clearReconnect()
  }

  _clearHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }

  _clearStuckTimer() {
    if (this._stuckTimer) {
      clearTimeout(this._stuckTimer)
      this._stuckTimer = null
    }
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }
}
