import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock SipClient before importing anything that pulls in phone.js
vi.mock('../src/sip-client.js', () => ({
  SipClient: class SipClient {
    constructor() {
      this.connect = vi.fn()
      this.disconnect = vi.fn()
      this.call = vi.fn()
      this.hangup = vi.fn()
      this.answer = vi.fn(() => true)
      this.reject = vi.fn()
      this.sendDTMF = vi.fn()
      this.register = vi.fn()
      this.currentSession = null
      this.isConnected = true
      this.hasUA = true
      this.isMuted = false
      this.viaHost = null
    }
  },
  decodeB64Header: () => null,
}))

const { probeExtension, ExtensionBridge, WIDGET_SOURCE, BRIDGE_SOURCE } =
  await import('../src/extension-bridge.js')
const { default: Leadtodeed } = await import('../src/index.js')

function fakeJwt(payload) {
  const header = btoa(JSON.stringify({ alg: 'HS256' }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.sig`
}

// Deliver a message AS the extension bridge content script would: same
// window, page origin, bridge source marker.
function postFromBridge(data) {
  window.dispatchEvent(new MessageEvent('message', {
    data: { source: BRIDGE_SOURCE, ...data },
    origin: window.location.origin,
    source: window,
  }))
}

// Capture everything the widget posts toward the bridge.
function captureWidgetMessages() {
  const seen = []
  const listener = (e) => {
    if (e.data && typeof e.data === 'object' && e.data.source === WIDGET_SOURCE) {
      seen.push(e.data)
    }
  }
  window.addEventListener('message', listener)
  return { seen, stop: () => window.removeEventListener('message', listener) }
}

// A fake extension bridge that answers hellos and records everything else.
function installFakeBridge({ identity, healthy = true, registered = true } = {}) {
  const received = []
  const listener = (e) => {
    const msg = e.data
    if (!msg || typeof msg !== 'object' || msg.source !== WIDGET_SOURCE) return
    received.push(msg)
    if (msg.type === 'hello') {
      postFromBridge({
        type: 'hello-ack',
        nonce: msg.nonce,
        identity,
        healthy,
        registered,
        version: 'test',
      })
    }
  }
  window.addEventListener('message', listener)
  return { received, uninstall: () => window.removeEventListener('message', listener) }
}

function mockBackendFetch({ sub = '138028' } = {}) {
  const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, sub })
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url)
    if (u.includes('/api/webrtc-config')) {
      return { ok: true, json: async () => ({ sip: {}, ice_servers: [] }) }
    }
    if (u.includes('/api/token')) {
      return { ok: true, json: async () => ({ token }) }
    }
    return { ok: true, json: async () => ({}) }
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('probeExtension', () => {
  it('resolves null when nothing answers', async () => {
    const ack = await probeExtension({ timeoutMs: 20, retryDelayMs: 20 })
    expect(ack).toBeNull()
  })

  it('resolves the hello-ack payload on a nonce match', async () => {
    const bridge = installFakeBridge({
      identity: { sub: '7005', displayName: 'Agent', tenant: 'homey' },
    })
    const ack = await probeExtension({ timeoutMs: 200, retryDelayMs: 50 })
    bridge.uninstall()
    expect(ack).not.toBeNull()
    expect(ack.identity.sub).toBe('7005')
    expect(ack.healthy).toBe(true)
    expect(ack.registered).toBe(true)
  })

  it('ignores an ack with a foreign nonce', async () => {
    const listener = (e) => {
      const msg = e.data
      if (msg?.source === WIDGET_SOURCE && msg.type === 'hello') {
        postFromBridge({ type: 'hello-ack', nonce: 'wrong', identity: { sub: 'x' }, healthy: true })
      }
    }
    window.addEventListener('message', listener)
    const ack = await probeExtension({ timeoutMs: 20, retryDelayMs: 20 })
    window.removeEventListener('message', listener)
    expect(ack).toBeNull()
  })
})

describe('ExtensionBridge', () => {
  let bridge

  afterEach(() => {
    bridge?.dispose()
    bridge = null
  })

  it('dispatches state, announce and bye; ignores non-bridge sources', () => {
    const onState = vi.fn()
    const onAnnounce = vi.fn()
    const onBye = vi.fn()
    bridge = new ExtensionBridge({ onState, onAnnounce, onBye })

    postFromBridge({ type: 'state', state: { phase: 'ringing' } })
    postFromBridge({ type: 'announce', identity: { sub: '1' }, healthy: true, registered: true })
    postFromBridge({ type: 'bye' })
    // Wrong source marker — must not reach any handler.
    window.dispatchEvent(new MessageEvent('message', {
      data: { source: 'someone-else', type: 'state', state: { phase: 'connected' } },
      origin: window.location.origin,
      source: window,
    }))

    expect(onState).toHaveBeenCalledTimes(1)
    expect(onState).toHaveBeenCalledWith({ phase: 'ringing' })
    expect(onAnnounce).toHaveBeenCalledWith({
      identity: { sub: '1' }, healthy: true, registered: true,
    })
    expect(onBye).toHaveBeenCalledWith('bye')
  })

  it('deduplicates page-phase reports', async () => {
    bridge = new ExtensionBridge({})
    const cap = captureWidgetMessages()
    bridge.reportPagePhase('idle', true)
    bridge.reportPagePhase('idle', true)
    bridge.reportPagePhase('ringing', true)
    await vi.waitFor(() => {
      const phases = cap.seen.filter((m) => m.type === 'page-phase')
      expect(phases).toHaveLength(2)
      expect(phases[1]).toMatchObject({ phase: 'ringing', ownSip: true })
    })
    cap.stop()
  })

  it('declares the bridge dead after silence (liveness watch)', async () => {
    vi.useFakeTimers()
    const onBye = vi.fn()
    bridge = new ExtensionBridge({ onBye })
    bridge.watchLiveness()
    await vi.advanceTimersByTimeAsync(121_000)
    expect(onBye).toHaveBeenCalledWith('silent')
    vi.useRealTimers()
  })
})

describe('Leadtodeed extension federation', () => {
  it('adopts a healthy same-sub extension: no SIP, relayed renders, forwarded actions', async () => {
    mockBackendFetch({ sub: '138028' })
    const fake = installFakeBridge({
      identity: { sub: '138028', displayName: 'Agent', tenant: 'homey' },
    })
    const renderer = vi.fn()
    const phone = Leadtodeed({ subdomain: 'homey', tokenUrl: '/api/token', renderer })

    // Adoption is announced to the bridge by the snapshot request.
    await vi.waitFor(() => {
      expect(fake.received.some((m) => m.type === 'action' && m.action === 'request-state')).toBe(true)
    })
    // The page widget never stood up its own SIP.
    expect(phone._sip.connect).not.toHaveBeenCalled()

    // Relayed state renders through the normal renderer, marked viaExtension.
    postFromBridge({ type: 'state', state: { phase: 'ringing', number: '+441234', direction: 'incoming' } })
    await vi.waitFor(() => {
      const last = renderer.mock.calls.at(-1)[0]
      expect(last.phase).toBe('ringing')
      expect(last.viaExtension).toBe(true)
      expect(typeof last.accept).toBe('function')
    })

    // Public phone methods forward as bridge actions.
    phone.call('+447700900000')
    await vi.waitFor(() => {
      expect(fake.received.some(
        (m) => m.type === 'action' && m.action === 'call' && m.args[0] === '+447700900000'
      )).toBe(true)
    })

    fake.uninstall()
    phone.disconnect()
  })

  it('stays local on a sub mismatch and paints the extensionIdentity hint', async () => {
    mockBackendFetch({ sub: '138028' })
    const fake = installFakeBridge({
      identity: { sub: '9999', displayName: 'Somebody Else', tenant: 'homey' },
    })
    const renderer = vi.fn()
    const phone = Leadtodeed({ subdomain: 'homey', tokenUrl: '/api/token', renderer })

    // Mismatch → local leadership stands up SIP (no-locks fallback acquires
    // instantly in this environment).
    await vi.waitFor(() => {
      expect(phone._sip.connect).toHaveBeenCalled()
    })
    await vi.waitFor(() => {
      const last = renderer.mock.calls.at(-1)[0]
      expect(last.viaExtension).toBe(false)
      expect(last.extensionIdentity).toMatchObject({ sub: '9999' })
    })

    fake.uninstall()
    phone.disconnect()
  })

  it('falls back to local leadership when the extension says bye', async () => {
    mockBackendFetch({ sub: '138028' })
    const fake = installFakeBridge({
      identity: { sub: '138028', displayName: 'Agent', tenant: 'homey' },
    })
    const renderer = vi.fn()
    const phone = Leadtodeed({ subdomain: 'homey', tokenUrl: '/api/token', renderer })

    await vi.waitFor(() => {
      expect(fake.received.some((m) => m.type === 'action' && m.action === 'request-state')).toBe(true)
    })
    expect(phone._sip.connect).not.toHaveBeenCalled()

    postFromBridge({ type: 'bye' })
    await vi.waitFor(() => {
      expect(phone._sip.connect).toHaveBeenCalled()
    })

    fake.uninstall()
    phone.disconnect()
  })

  it('adopts an extension that announces after page load', async () => {
    mockBackendFetch({ sub: '138028' })
    const renderer = vi.fn()
    // No bridge installed: the probe misses and local leadership starts.
    const phone = Leadtodeed({ subdomain: 'homey', tokenUrl: '/api/token', renderer })
    await vi.waitFor(() => {
      expect(phone._sip.connect).toHaveBeenCalled()
    }, { timeout: 3000 })

    const cap = captureWidgetMessages()
    postFromBridge({
      type: 'announce',
      identity: { sub: '138028', displayName: 'Agent', tenant: 'homey' },
      healthy: true,
      registered: true,
    })
    // Adoption: SIP dropped, snapshot requested.
    await vi.waitFor(() => {
      expect(phone._sip.disconnect).toHaveBeenCalled()
      expect(cap.seen.some((m) => m.type === 'action' && m.action === 'request-state')).toBe(true)
    })

    cap.stop()
    phone.disconnect()
  })

  it('leadership:false skips both election and federation', async () => {
    mockBackendFetch({ sub: '138028' })
    const fake = installFakeBridge({
      identity: { sub: '138028', displayName: 'Agent', tenant: 'homey' },
    })
    const phone = Leadtodeed({
      subdomain: 'homey',
      tokenProvider: async () => fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, sub: '138028' }),
      leadership: false,
    })

    // Nothing probes the bridge and nothing connects on its own…
    await new Promise((r) => setTimeout(r, 100))
    expect(fake.received.some((m) => m.type === 'hello')).toBe(false)
    expect(phone._sip.connect).not.toHaveBeenCalled()

    // …the host drives connect() directly (the offscreen document's mode).
    await phone.connect()
    expect(phone._sip.connect).toHaveBeenCalled()

    fake.uninstall()
    phone.disconnect()
  })
})
