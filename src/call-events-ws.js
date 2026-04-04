/**
 * WebSocket client for real-time call participant events.
 * Connects to the WebRTC backend's /api/call/events endpoint.
 */

export class CallEventsSocket {
  constructor({ url, token, onParticipantJoined, onParticipantLeft, onCallEnded }) {
    this._url = url
    this._token = token
    this._ws = null
    this._callbacks = { onParticipantJoined, onParticipantLeft, onCallEnded }
  }

  connect() {
    if (this._ws) return

    const wsUrl = `${this._url}?token=${encodeURIComponent(this._token)}`
    this._ws = new WebSocket(wsUrl)

    this._ws.onmessage = (event) => {
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
        }
      } catch (e) {
        console.error('[Leadtodeed] WS message parse error:', e)
      }
    }

    this._ws.onerror = (e) => {
      console.error('[Leadtodeed] WS error:', e)
    }

    this._ws.onclose = () => {
      this._ws = null
    }
  }

  disconnect() {
    if (this._ws) {
      this._ws.close()
      this._ws = null
    }
  }
}
