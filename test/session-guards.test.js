import { describe, it, expect, vi, afterEach } from 'vitest'
import { LeadtodeedPhone } from '../src/phone.js'
import { SipClient } from '../src/sip-client.js'

// Guards added after the disappearing-popup bug: relayed toggleMute actions
// reach every tab, and an idle tab fabricating a 'muted' state change makes
// its host controller broadcast phase=idle — wiping the call owner's UI.

const defaults = { subdomain: 'test', tokenUrl: '/token' }

afterEach(() => vi.restoreAllMocks())

describe('mute without a live session', () => {
  it('mute/unmute/toggleMute are no-ops when no session exists', () => {
    const phone = new LeadtodeedPhone(defaults)
    const muted = []
    phone.on('muted', (e) => muted.push(e))

    phone.mute()
    phone.unmute()
    phone.toggleMute()

    expect(muted).toEqual([])
  })

  it('mute emits and acts when a session exists', () => {
    const phone = new LeadtodeedPhone(defaults)
    const session = { mute: vi.fn(), unmute: vi.fn(), isMuted: () => ({ audio: false }) }
    phone._sip._currentSession = session
    const muted = []
    phone.on('muted', (e) => muted.push(e))

    phone.mute()

    expect(session.mute).toHaveBeenCalledWith({ audio: true })
    expect(muted).toEqual([{ muted: true }])
  })
})

describe('REGISTER transport readiness', () => {
  it('defers ua.register() until the transport connects, deduplicated', () => {
    const sip = new SipClient({})
    const once = {}
    sip._ua = {
      isConnected: () => false,
      register: vi.fn(),
      once: (ev, cb) => { once[ev] = cb },
    }

    sip.register()
    sip.register() // second call while pending must not double-queue
    expect(sip._ua.register).not.toHaveBeenCalled()

    once.connected()
    expect(sip._ua.register).toHaveBeenCalledTimes(1)

    // Once connected, further register() calls go straight through.
    sip._ua.isConnected = () => true
    sip.register()
    expect(sip._ua.register).toHaveBeenCalledTimes(2)
  })

  it('phone.register() rejects fast on registrationFailed instead of waiting for the timeout', async () => {
    const phone = new LeadtodeedPhone(defaults)
    vi.spyOn(phone._sip, 'register').mockImplementation(() => {})

    const pending = phone.register()
    phone.emit('registrationFailed', { cause: 'Connection Error' })

    await expect(pending).rejects.toThrow('Connection Error')
  })
})
