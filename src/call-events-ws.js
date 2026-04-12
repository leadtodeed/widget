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
  constructor({ url, token, onParticipantJoined, onParticipantLeft, onCallEnded }) {
    this._url = url
    this._token = token
    this._ws = null
    this._callbacks = { onParticipantJoined, onParticipantLeft, onCallEnded }
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
    const wsUrl = `${this._url}?token=${encodeURIComponent(this._token)}`
    this._ws = new WebSocket(wsUrl)
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
    }

    this._ws.onclose = () => {
      this._clearTimers()
      this._ws = null
      if (!this._closedByUser) this._scheduleReconnect()
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
