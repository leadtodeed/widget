import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AuthManager } from '../src/auth.js'

// Helper: build a fake JWT with given payload
function fakeJwt(payload) {
  const header = btoa(JSON.stringify({ alg: 'HS256' }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.sig`
}

describe('AuthManager', () => {
  let auth

  beforeEach(() => {
    auth = new AuthManager({ tokenUrl: '/api/token' })
    vi.useFakeTimers()
  })

  afterEach(() => {
    auth.destroy()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('fetchToken', () => {
    it('fetches and stores token', async () => {
      const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token }),
      })

      const result = await auth.fetchToken()
      expect(result).toBe(token)
      expect(auth.token).toBe(token)
    })

    it('throws on non-ok response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
      })

      await expect(auth.fetchToken()).rejects.toThrow('Token fetch failed: 401')
    })

    it('sends CSRF token from meta tag', async () => {
      const meta = document.createElement('meta')
      meta.name = 'csrf-token'
      meta.content = 'test-csrf-value'
      document.head.appendChild(meta)

      const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token }),
      })

      await auth.fetchToken()

      expect(fetchSpy).toHaveBeenCalledWith('/api/token', expect.objectContaining({
        headers: expect.objectContaining({
          'X-CSRF-Token': 'test-csrf-value',
        }),
      }))

      meta.remove()
    })

    it('schedules refresh before token expiry', async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
      const token = fakeJwt({ exp })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token }),
      })

      await auth.fetchToken()
      expect(auth._refreshTimer).not.toBeNull()
    })

    it('falls back to 7h refresh if JWT is not parseable', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token: 'not.a.jwt' }),
      })

      await auth.fetchToken()
      // Should still have a refresh timer scheduled
      expect(auth._refreshTimer).not.toBeNull()
    })
  })

  describe('fetchSipConfig', () => {
    it('fetches SIP config with bearer token', async () => {
      auth._token = 'my-token'
      const config = { sip: {}, ice_servers: [] }
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(config),
      })

      const result = await auth.fetchSipConfig('https://example.com')
      expect(result).toEqual(config)
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com/api/webrtc-config',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer my-token',
          }),
        }),
      )
    })

    it('throws on non-ok response', async () => {
      auth._token = 'my-token'
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 403,
      })

      await expect(auth.fetchSipConfig('https://example.com'))
        .rejects.toThrow('SIP config fetch failed: 403')
    })
  })

  describe('destroy', () => {
    it('clears token and refresh timer', async () => {
      const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token }),
      })

      await auth.fetchToken()
      expect(auth._refreshTimer).not.toBeNull()

      auth.destroy()
      expect(auth.token).toBeNull()
      expect(auth._refreshTimer).toBeNull()
    })
  })
})

describe('AuthManager with tokenProvider', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('requires tokenUrl or tokenProvider', () => {
    expect(() => new AuthManager({})).toThrow('tokenUrl or tokenProvider is required')
  })

  it('fetches via the provider and never touches fetch', async () => {
    vi.useFakeTimers()
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, sub: '138028' })
    const provider = vi.fn().mockResolvedValue(token)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const auth = new AuthManager({ tokenProvider: provider })

    await expect(auth.fetchToken()).resolves.toBe(token)
    expect(auth.token).toBe(token)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    auth.destroy()
  })

  it('schedules refresh through the provider (re-brokering for free)', async () => {
    vi.useFakeTimers()
    const exp = Math.floor(Date.now() / 1000) + 3600
    const provider = vi.fn()
      .mockResolvedValueOnce(fakeJwt({ exp }))
      .mockResolvedValueOnce(fakeJwt({ exp: exp + 3600 }))
    const auth = new AuthManager({ tokenProvider: provider })

    await auth.fetchToken()
    expect(auth._refreshTimer).not.toBeNull()
    // 5 minutes before expiry the provider is asked again.
    await vi.advanceTimersByTimeAsync(55 * 60 * 1000 + 1000)
    expect(provider).toHaveBeenCalledTimes(2)
    auth.destroy()
  })

  it('rejects when the provider returns nothing', async () => {
    const auth = new AuthManager({ tokenProvider: async () => null })
    await expect(auth.fetchToken()).rejects.toThrow('tokenProvider returned no token')
  })

  it('exposes the sub claim after fetch', async () => {
    const auth = new AuthManager({
      tokenProvider: async () => fakeJwt({ exp: Math.floor(Date.now() / 1000) + 60, sub: '7005' }),
    })
    expect(auth.sub).toBeNull()
    await auth.fetchToken()
    expect(auth.sub).toBe('7005')
    auth.destroy()
  })

  it('sub is null on an unparseable token', async () => {
    const auth = new AuthManager({ tokenProvider: async () => 'not-a-jwt' })
    await auth.fetchToken()
    expect(auth.sub).toBeNull()
    auth.destroy()
  })
})
