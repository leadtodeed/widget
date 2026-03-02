/**
 * Token management — fetch JWT from host app, cache in memory, auto-refresh.
 */
export class AuthManager {
  constructor({ tokenUrl }) {
    this.tokenUrl = tokenUrl
    this._token = null
    this._expiresAt = 0
    this._refreshTimer = null
  }

  get token() {
    return this._token
  }

  async fetchToken() {
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
