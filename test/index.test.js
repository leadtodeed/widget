import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock SipClient before importing LeadtodeedPhone
vi.mock('../src/sip-client.js', () => ({
  SipClient: class SipClient {
    constructor() {
      this.connect = vi.fn()
      this.disconnect = vi.fn()
      this.call = vi.fn()
      this.hangup = vi.fn()
      this.answer = vi.fn()
      this.reject = vi.fn()
      this.sendDTMF = vi.fn()
      this.currentSession = null
    }
  },
}))

const { LeadtodeedPhone } = await import('../src/phone.js')
const { createCallState, addEvent, transitionPhase, _resetEventId } = await import('../src/state.js')
const { default: Leadtodeed } = await import('../src/index.js')

describe('LeadtodeedPhone', () => {
  const defaults = {
    subdomain: 'example',
    tokenUrl: '/api/token',
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor validation', () => {
    it('throws if subdomain is missing', () => {
      expect(() => new LeadtodeedPhone({ tokenUrl: '/api/token' }))
        .toThrow('subdomain is required')
    })

    it('throws if tokenUrl is missing', () => {
      expect(() => new LeadtodeedPhone({ subdomain: 'example' }))
        .toThrow('tokenUrl is required')
    })

    it('creates instance with valid params', () => {
      const phone = new LeadtodeedPhone(defaults)
      expect(phone).toBeInstanceOf(LeadtodeedPhone)
    })

    it('builds leadtodeedUrl from subdomain', () => {
      const phone = new LeadtodeedPhone(defaults)
      expect(phone._leadtodeedUrl).toBe('https://example.leadtodeed.ai')
    })
  })

  describe('callback wiring', () => {
    it('wires onRegistered callback', () => {
      const onRegistered = vi.fn()
      const phone = new LeadtodeedPhone({ ...defaults, onRegistered })
      phone.emit('registered')
      expect(onRegistered).toHaveBeenCalled()
    })

    it('wires onCallStarted callback', () => {
      const onCallStarted = vi.fn()
      const phone = new LeadtodeedPhone({ ...defaults, onCallStarted })
      phone.emit('callStarted', { number: '123', direction: 'outgoing' })
      expect(onCallStarted).toHaveBeenCalledWith({ number: '123', direction: 'outgoing' })
    })

    it('wires onCallEnded callback', () => {
      const onCallEnded = vi.fn()
      const phone = new LeadtodeedPhone({ ...defaults, onCallEnded })
      phone.emit('callEnded', { number: '123', duration: 10, cause: 'completed' })
      expect(onCallEnded).toHaveBeenCalled()
    })

    it('wires onIncomingCall callback', () => {
      const onIncomingCall = vi.fn()
      const phone = new LeadtodeedPhone({ ...defaults, onIncomingCall })
      phone.emit('incomingCall', { callerName: 'Test', callerNumber: '123' })
      expect(onIncomingCall).toHaveBeenCalled()
    })

    it('wires onError callback', () => {
      const onError = vi.fn()
      const phone = new LeadtodeedPhone({ ...defaults, onError })
      phone.emit('error', new Error('test'))
      expect(onError).toHaveBeenCalled()
    })
  })

  describe('call / hangup / answer / reject delegation', () => {
    it('delegates call() to SipClient', () => {
      const phone = new LeadtodeedPhone(defaults)
      phone.call('+1 (234) 567-8900')
      expect(phone._sip.call).toHaveBeenCalledWith('+12345678900')
    })

    it('does nothing when call() is given empty string', () => {
      const phone = new LeadtodeedPhone(defaults)
      phone.call('')
      expect(phone._sip.call).not.toHaveBeenCalled()
    })

    it('delegates hangup() to SipClient', () => {
      const phone = new LeadtodeedPhone(defaults)
      phone.hangup()
      expect(phone._sip.hangup).toHaveBeenCalled()
    })

    it('delegates answer() to SipClient', () => {
      const phone = new LeadtodeedPhone(defaults)
      phone.answer()
      expect(phone._sip.answer).toHaveBeenCalled()
    })

    it('delegates reject() to SipClient', () => {
      const phone = new LeadtodeedPhone(defaults)
      phone.reject()
      expect(phone._sip.reject).toHaveBeenCalled()
    })

    it('delegates sendDTMF() to SipClient', () => {
      const phone = new LeadtodeedPhone(defaults)
      phone.sendDTMF('5')
      expect(phone._sip.sendDTMF).toHaveBeenCalledWith('5')
    })
  })

  describe('addEvent', () => {
    it('emits event with type and data', () => {
      const phone = new LeadtodeedPhone(defaults)
      const handler = vi.fn()
      phone.on('event', handler)

      phone.addEvent('transcript', { number: '+44123', text: 'John Smith' })

      expect(handler).toHaveBeenCalledTimes(1)
      const event = handler.mock.calls[0][0]
      expect(event.type).toBe('transcript')
      expect(event.data).toEqual({ number: '+44123', text: 'John Smith' })
      expect(event.ts).toBeTypeOf('number')
      expect(event.id).toBeDefined()
    })
  })

  describe('simulation API', () => {
    it('simulateOutgoingCall emits callStarted', () => {
      const onCallStarted = vi.fn()
      const phone = new LeadtodeedPhone({ ...defaults, onCallStarted })
      phone.simulateOutgoingCall('+1234567890')
      expect(onCallStarted).toHaveBeenCalledWith({
        number: '+1234567890',
        direction: 'outgoing',
      })
    })

    it('simulateIncomingCall emits incomingCall', () => {
      const onIncomingCall = vi.fn()
      const phone = new LeadtodeedPhone({ ...defaults, onIncomingCall })
      phone.simulateIncomingCall({ callerName: 'Alice', callerNumber: '+155' })
      expect(onIncomingCall).toHaveBeenCalledWith({
        callerName: 'Alice',
        callerNumber: '+155',
      })
    })

    it('simulateEnd emits callEnded', () => {
      const onCallEnded = vi.fn()
      const phone = new LeadtodeedPhone({ ...defaults, onCallEnded })
      phone.simulateOutgoingCall('+1234567890')
      phone.simulateEnd()
      expect(onCallEnded).toHaveBeenCalledWith(expect.objectContaining({
        number: '+1234567890',
        cause: 'completed',
      }))
    })

    it('simulateEnd returns this for chaining', () => {
      const phone = new LeadtodeedPhone(defaults)
      phone.simulateOutgoingCall('+1234567890')
      const result = phone.simulateEnd()
      expect(result).toBe(phone)
    })
  })

  describe('event flow', () => {
    it('call() emits callStarted with outgoing direction', () => {
      const fn = vi.fn()
      const phone = new LeadtodeedPhone(defaults)
      phone.on('callStarted', fn)
      phone.call('+1234567890')
      expect(fn).toHaveBeenCalledWith({
        number: '+1234567890',
        direction: 'outgoing',
      })
    })

    it('emits error when call() throws from SipClient', () => {
      const onError = vi.fn()
      const phone = new LeadtodeedPhone({ ...defaults, onError })
      phone._sip.call.mockImplementation(() => { throw new Error('no session') })
      phone.call('+1234567890')
      expect(onError).toHaveBeenCalled()
    })
  })
})

describe('state.js', () => {
  beforeEach(() => {
    _resetEventId()
  })

  describe('createCallState', () => {
    it('returns idle state with empty events', () => {
      const state = createCallState()
      expect(state.phase).toBe('idle')
      expect(state.number).toBeNull()
      expect(state.direction).toBeNull()
      expect(state.connectedAt).toBeNull()
      expect(state.events).toEqual([])
    })
  })

  describe('addEvent', () => {
    it('appends event with auto-incrementing id', () => {
      const state = createCallState()
      const e1 = addEvent(state, 'transcript', { text: 'hello' })
      const e2 = addEvent(state, 'transcript', { text: 'world' })

      expect(e1.id).toBe(1)
      expect(e2.id).toBe(2)
      expect(state.events).toHaveLength(2)
      expect(state.events[0].type).toBe('transcript')
      expect(state.events[0].data).toEqual({ text: 'hello' })
      expect(state.events[0].ts).toBeTypeOf('number')
    })
  })

  describe('transitionPhase', () => {
    it('transitions idle → ringing', () => {
      const state = createCallState()
      const ok = transitionPhase(state, 'ringing', { number: '+44123', direction: 'incoming' })
      expect(ok).toBe(true)
      expect(state.phase).toBe('ringing')
      expect(state.number).toBe('+44123')
      expect(state.direction).toBe('incoming')
    })

    it('transitions ringing → connected', () => {
      const state = createCallState()
      transitionPhase(state, 'ringing', { number: '+44123', direction: 'incoming' })
      const ok = transitionPhase(state, 'connected', { connectedAt: 12345 })
      expect(ok).toBe(true)
      expect(state.phase).toBe('connected')
      expect(state.connectedAt).toBe(12345)
    })

    it('transitions connected → ended', () => {
      const state = createCallState()
      transitionPhase(state, 'ringing')
      transitionPhase(state, 'connected')
      const ok = transitionPhase(state, 'ended')
      expect(ok).toBe(true)
      expect(state.phase).toBe('ended')
    })

    it('transitions ended → idle and resets state', () => {
      const state = createCallState()
      transitionPhase(state, 'ringing', { number: '+44123', direction: 'incoming' })
      transitionPhase(state, 'connected', { connectedAt: 12345 })
      addEvent(state, 'transcript', { text: 'test' })
      transitionPhase(state, 'ended')
      const ok = transitionPhase(state, 'idle')
      expect(ok).toBe(true)
      expect(state.phase).toBe('idle')
      expect(state.number).toBeNull()
      expect(state.direction).toBeNull()
      expect(state.connectedAt).toBeNull()
      expect(state.events).toEqual([])
    })

    it('rejects invalid transitions', () => {
      const state = createCallState()
      const ok = transitionPhase(state, 'connected')
      expect(ok).toBe(false)
      expect(state.phase).toBe('idle')
    })

    it('rejects ringing → idle', () => {
      const state = createCallState()
      transitionPhase(state, 'ringing')
      const ok = transitionPhase(state, 'idle')
      expect(ok).toBe(false)
      expect(state.phase).toBe('ringing')
    })
  })
})

describe('Leadtodeed()', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a LeadtodeedPhone instance', () => {
    const phone = Leadtodeed({ subdomain: 'test', tokenUrl: '/api/token' })
    expect(phone).toBeInstanceOf(LeadtodeedPhone)
  })

  it('calls renderer with ringing state on incoming call', async () => {
    const renderer = vi.fn()
    const phone = Leadtodeed({ subdomain: 'test', tokenUrl: '/api/token', renderer })

    phone.emit('incomingCall', { callerName: 'Test', callerNumber: '+44123' })
    await vi.waitFor(() => expect(renderer).toHaveBeenCalled())

    const state = renderer.mock.calls[0][0]
    expect(state.phase).toBe('ringing')
    expect(state.number).toBe('+44123')
    expect(state.direction).toBe('incoming')
    expect(state.accept).toBeTypeOf('function')
    expect(state.decline).toBeTypeOf('function')
    expect(state.hangup).toBeTypeOf('function')
    expect(state.sendDTMF).toBeTypeOf('function')
  })

  it('calls renderer with ringing state on outgoing call', () => {
    const renderer = vi.fn()
    const phone = Leadtodeed({ subdomain: 'test', tokenUrl: '/api/token', renderer })

    phone.emit('callStarted', { number: '+44555', direction: 'outgoing' })

    expect(renderer).toHaveBeenCalledTimes(1)
    const state = renderer.mock.calls[0][0]
    expect(state.phase).toBe('ringing')
    expect(state.number).toBe('+44555')
    expect(state.direction).toBe('outgoing')
  })

  it('calls renderer with connected state', () => {
    const renderer = vi.fn()
    const phone = Leadtodeed({ subdomain: 'test', tokenUrl: '/api/token', renderer })

    phone.emit('callStarted', { number: '+44555', direction: 'outgoing' })
    phone.emit('callConnected', { number: '+44555' })

    expect(renderer).toHaveBeenCalledTimes(2)
    const state = renderer.mock.calls[1][0]
    expect(state.phase).toBe('connected')
    expect(state.connectedAt).toBeTypeOf('number')
  })

  it('calls renderer with ended then idle state', async () => {
    vi.useFakeTimers()
    const renderer = vi.fn()
    const phone = Leadtodeed({ subdomain: 'test', tokenUrl: '/api/token', renderer })

    phone.emit('callStarted', { number: '+44555', direction: 'outgoing' })
    phone.emit('callConnected', { number: '+44555' })
    phone.emit('callEnded', { number: '+44555', duration: 10, cause: 'completed' })

    expect(renderer).toHaveBeenCalledTimes(3)
    expect(renderer.mock.calls[2][0].phase).toBe('ended')

    vi.advanceTimersByTime(2000)
    expect(renderer).toHaveBeenCalledTimes(4)
    expect(renderer.mock.calls[3][0].phase).toBe('idle')

    vi.useRealTimers()
  })

  it('accept() delegates to phone.answer()', () => {
    const renderer = vi.fn()
    const phone = Leadtodeed({ subdomain: 'test', tokenUrl: '/api/token', renderer })

    phone.emit('incomingCall', { callerName: 'Test', callerNumber: '+44123' })
    const state = renderer.mock.calls[0][0]
    state.accept()

    expect(phone._sip.answer).toHaveBeenCalled()
  })

  it('decline() delegates to phone.reject()', () => {
    const renderer = vi.fn()
    const phone = Leadtodeed({ subdomain: 'test', tokenUrl: '/api/token', renderer })

    phone.emit('incomingCall', { callerName: 'Test', callerNumber: '+44123' })
    const state = renderer.mock.calls[0][0]
    state.decline()

    expect(phone._sip.reject).toHaveBeenCalled()
  })

  it('onIncomingCall enrichment adds transcript event', async () => {
    const renderer = vi.fn()
    const onIncomingCall = vi.fn().mockResolvedValue({ number: '+44123', text: 'John — 123 Main St' })
    const phone = Leadtodeed({ subdomain: 'test', tokenUrl: '/api/token', renderer, onIncomingCall })

    phone.emit('incomingCall', { callerName: 'Test', callerNumber: '+44123' })

    // First call is immediate (ringing, no enrichment yet)
    expect(renderer).toHaveBeenCalledTimes(1)
    expect(renderer.mock.calls[0][0].phase).toBe('ringing')
    expect(renderer.mock.calls[0][0].events).toHaveLength(0)

    // Second call is after enrichment resolves
    await vi.waitFor(() => expect(renderer).toHaveBeenCalledTimes(2))

    const state = renderer.mock.calls[1][0]
    expect(state.events).toHaveLength(1)
    expect(state.events[0].type).toBe('transcript')
    expect(state.events[0].data).toEqual({ number: '+44123', text: 'John — 123 Main St' })
  })

  it('works without renderer (no errors)', () => {
    const phone = Leadtodeed({ subdomain: 'test', tokenUrl: '/api/token' })
    expect(() => {
      phone.emit('incomingCall', { callerName: 'Test', callerNumber: '+44123' })
      phone.emit('callStarted', { number: '+44555', direction: 'outgoing' })
      phone.emit('callConnected', { number: '+44555' })
      phone.emit('callEnded', { number: '+44555', duration: 10, cause: 'completed' })
    }).not.toThrow()
  })
})
