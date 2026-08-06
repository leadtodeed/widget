import { describe, it, expect, vi, afterEach } from 'vitest'
import { SipClient } from '../src/sip-client.js'

// setMicrophone()/refreshAudioConstraints() re-acquire the mic and
// replaceTrack() into the live sender. The host's getAudioConstraints()
// carries processing flags (echoCancellation/noiseSuppression/
// autoGainControl) that must survive a device swap — silently resetting
// them to browser defaults mid-call is the bug _swapMicTrack exists to fix.

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function liveSession(sip, { muted = false } = {}) {
  const oldTrack = { kind: 'audio', enabled: !muted, stop: vi.fn() }
  const sender = { track: oldTrack, replaceTrack: vi.fn().mockResolvedValue(undefined) }
  sip._currentSession = { connection: { getSenders: () => [sender] } }
  return { sender, oldTrack }
}

function stubGum() {
  const newTrack = { kind: 'audio', enabled: true, stop: vi.fn() }
  const gum = vi.fn().mockResolvedValue({ getAudioTracks: () => [newTrack] })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: gum } })
  return { gum, newTrack }
}

describe('setMicrophone', () => {
  it('overlays the explicit device on the host processing flags', async () => {
    const sip = new SipClient({
      getAudioConstraints: () => ({ echoCancellation: false, noiseSuppression: false }),
    })
    const { sender } = liveSession(sip)
    const { gum, newTrack } = stubGum()

    expect(await sip.setMicrophone('mic-2')).toBe(true)

    expect(gum).toHaveBeenCalledWith({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        deviceId: { exact: 'mic-2' },
      },
      video: false,
    })
    expect(sender.replaceTrack).toHaveBeenCalledWith(newTrack)
  })

  it('keeps host flags when reverting to the default device', async () => {
    const sip = new SipClient({
      getAudioConstraints: () => ({ deviceId: { exact: 'stale' }, autoGainControl: false }),
    })
    liveSession(sip)
    const { gum } = stubGum()

    await sip.setMicrophone('default')

    expect(gum).toHaveBeenCalledWith({ audio: { autoGainControl: false }, video: false })
  })

  it('falls back to audio:true with no host callback and no device', async () => {
    const sip = new SipClient({})
    liveSession(sip)
    const { gum } = stubGum()

    await sip.setMicrophone(null)

    expect(gum).toHaveBeenCalledWith({ audio: true, video: false })
  })
})

describe('refreshAudioConstraints', () => {
  it('re-acquires with the host constraint verbatim', async () => {
    const sip = new SipClient({
      getAudioConstraints: () => ({ noiseSuppression: false, deviceId: { exact: 'mic-9' } }),
    })
    liveSession(sip)
    const { gum } = stubGum()

    expect(await sip.refreshAudioConstraints()).toBe(true)

    expect(gum).toHaveBeenCalledWith({
      audio: { noiseSuppression: false, deviceId: { exact: 'mic-9' } },
      video: false,
    })
  })

  it('is a no-op false without a live session', async () => {
    const sip = new SipClient({ getAudioConstraints: () => ({ noiseSuppression: false }) })
    const { gum } = stubGum()

    expect(await sip.refreshAudioConstraints()).toBe(false)
    expect(gum).not.toHaveBeenCalled()
  })

  it('mirrors mute state onto the new track and stops the old one', async () => {
    const sip = new SipClient({ getAudioConstraints: () => ({ noiseSuppression: false }) })
    const { oldTrack } = liveSession(sip, { muted: true })
    const { newTrack } = stubGum()

    await sip.refreshAudioConstraints()

    expect(newTrack.enabled).toBe(false)
    expect(oldTrack.stop).toHaveBeenCalled()
  })

  it('returns false when getUserMedia rejects', async () => {
    const sip = new SipClient({ getAudioConstraints: () => ({ noiseSuppression: false }) })
    liveSession(sip)
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new Error('NotReadable')) },
    })

    expect(await sip.refreshAudioConstraints()).toBe(false)
  })
})
