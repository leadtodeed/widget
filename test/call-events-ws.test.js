import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { CallEventsSocket } = await import('../src/call-events-ws.js')

// Minimal WebSocket stand-in: records what was constructed and lets the test
// push server frames in via _emit(). Nothing here talks to a network.
class FakeWebSocket {
  static last = null
  constructor(url, protocols) {
    this.url = url
    this.protocols = protocols
    this.readyState = 1
    this.sent = []
    this.closed = false
    FakeWebSocket.last = this
  }
  send(data) { this.sent.push(data) }
  close() { this.closed = true }
  _emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }) }
}

describe('CallEventsSocket message dispatch', () => {
  let socket
  let callbacks

  beforeEach(() => {
    FakeWebSocket.last = null
    vi.stubGlobal('WebSocket', FakeWebSocket)
    callbacks = {
      onParticipantJoined: vi.fn(),
      onParticipantLeft: vi.fn(),
      onParticipantInviteFailed: vi.fn(),
      onCallEnded: vi.fn(),
      onRefresh: vi.fn(),
    }
    socket = new CallEventsSocket({
      url: 'wss://example.leadtodeed.ai/api/call/events',
      token: 'jwt-123',
      ...callbacks,
    })
    socket.connect()
  })

  afterEach(() => {
    socket.disconnect()
    vi.unstubAllGlobals()
  })

  it('passes the JWT as a subprotocol, never in the URL', () => {
    expect(FakeWebSocket.last.url).not.toContain('jwt-123')
    expect(FakeWebSocket.last.protocols).toEqual(['bearer.jwt-123'])
  })

  it('routes participant_joined / participant_left to their callbacks', () => {
    FakeWebSocket.last._emit({ type: 'participant_joined', user_id: 'u1', name: 'Jane', extension: '7001' })
    expect(callbacks.onParticipantJoined).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', name: 'Jane', extension: '7001' })
    )

    FakeWebSocket.last._emit({ type: 'participant_left', user_id: 'u1' })
    expect(callbacks.onParticipantLeft).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1' })
    )
  })

  // The backend used to signal a failed invite as a synthetic joined+left
  // pair, which hosts could only read as "they joined, then left". The reason
  // must survive the trip so the host can label its retry affordance.
  it.each(['no_answer', 'cancelled'])(
    'routes participant_invite_failed with reason=%s, and never as a join',
    (reason) => {
      FakeWebSocket.last._emit({
        type: 'participant_invite_failed',
        user_id: 'u2',
        name: 'Sam',
        extension: '7002',
        reason,
      })

      expect(callbacks.onParticipantInviteFailed).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 'u2', name: 'Sam', extension: '7002', reason })
      )
      expect(callbacks.onParticipantJoined).not.toHaveBeenCalled()
      expect(callbacks.onParticipantLeft).not.toHaveBeenCalled()
    }
  )

  it('ignores unknown message types and malformed frames without throwing', () => {
    expect(() => {
      FakeWebSocket.last._emit({ type: 'something_new' })
      FakeWebSocket.last.onmessage({ data: 'not json' })
    }).not.toThrow()
    for (const cb of Object.values(callbacks)) expect(cb).not.toHaveBeenCalled()
  })
})
