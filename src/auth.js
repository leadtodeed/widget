/**
 * Token management — fetch JWT from host app, cache in memory, auto-refresh.
 *
 * Two sources, exactly one configured:
 *   tokenUrl      — POST to the host backend (same-origin session + CSRF meta).
 *   tokenProvider — async () => jwt string. For contexts where the same-origin
 *                   session dance is meaningless (the browser-extension
 *                   offscreen document brokers its own tokens); the provider
 *                   owns re-authentication, this class still owns scheduling.
 */
export class AuthManager {
  constructor({ tokenUrl, tokenProvider } = {}) {
    if (!tokenUrl && !tokenProvider) {
      throw new Error('tokenUrl or tokenProvider is required')
    }
    this.tokenUrl = tokenUrl || null
    this.tokenProvider = tokenProvider || null
    this._token = null
    this._expiresAt = 0
    this._refreshTimer = null
  }

  get token() {
    return this._token
  }

  /** The JWT's `sub` claim (the SIP username this token acts as), or null
   *  before fetchToken() / on an unparseable token. Federation compares this
   *  against the extension's announced identity. */
  get sub() {
    if (!this._token) return null
    try {
      const payload = JSON.parse(atob(this._token.split('.')[1]))
      return payload.sub ?? null
    } catch {
      return null
    }
  }

  async fetchToken() {
    if (this.tokenProvider) {
      const token = await this.tokenProvider()
      if (!token || typeof token !== 'string') {
        throw new Error('tokenProvider returned no token')
      }
      this._token = token
    } else {
      const resp = await fetch(this.tokenUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Accept': 'application/json',
          'X-CSRF-Token': this._csrfToken(),
        },
      })

      if (!resp.ok) {
        throw new Error(`Token fetch failed: ${resp.status}`)
      }

      const data = await resp.json()
      this._token = data.token
    }

    // Parse JWT exp claim for refresh scheduling
    try {
      const payload = JSON.parse(atob(this._token.split('.')[1]))
      this._expiresAt = payload.exp * 1000
      this._scheduleRefresh()
    } catch {
      // If we can't parse, just set a 7h refresh
      this._expiresAt = Date.now() + 7 * 60 * 60 * 1000
      this._scheduleRefresh()
    }

    return this._token
  }

  async fetchSipConfig(leadtodeedUrl) {
    const resp = await fetch(`${leadtodeedUrl}/api/webrtc-config`, {
      headers: {
        'Authorization': `Bearer ${this._token}`,
        'Accept': 'application/json',
      },
    })

    if (!resp.ok) {
      throw new Error(`SIP config fetch failed: ${resp.status}`)
    }

    return resp.json()
  }

  destroy() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer)
      this._refreshTimer = null
    }
    this._token = null
  }

  _scheduleRefresh() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer)

    // Refresh 5 minutes before expiry
    const delay = Math.max(this._expiresAt - Date.now() - 5 * 60 * 1000, 60 * 1000)
    this._refreshTimer = setTimeout(() => {
      this.fetchToken().catch(e => console.error('[LeadtodeedPhone] Token refresh failed:', e))
    }, delay)
  }

  _csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]')
    return meta ? meta.content : ''
  }
}
