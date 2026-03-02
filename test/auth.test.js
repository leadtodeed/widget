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
