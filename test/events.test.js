import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from '../src/events.js'

describe('EventEmitter', () => {
  it('calls listeners on emit', () => {
    const ee = new EventEmitter()
    const fn = vi.fn()
    ee.on('ping', fn)
    ee.emit('ping', 42)
    expect(fn).toHaveBeenCalledWith(42)
  })

  it('supports multiple listeners for the same event', () => {
    const ee = new EventEmitter()
    const a = vi.fn()
    const b = vi.fn()
    ee.on('x', a)
    ee.on('x', b)
    ee.emit('x', 'data')
    expect(a).toHaveBeenCalledWith('data')
    expect(b).toHaveBeenCalledWith('data')
  })

  it('does nothing when emitting an event with no listeners', () => {
    const ee = new EventEmitter()
    expect(() => ee.emit('nope')).not.toThrow()
  })

  it('removes a specific listener with off(event, fn)', () => {
    const ee = new EventEmitter()
    const fn = vi.fn()
    ee.on('x', fn)
    ee.off('x', fn)
    ee.emit('x')
    expect(fn).not.toHaveBeenCalled()
  })

  it('removes all listeners for an event with off(event)', () => {
    const ee = new EventEmitter()
    const a = vi.fn()
    const b = vi.fn()
    ee.on('x', a)
    ee.on('x', b)
    ee.off('x')
    ee.emit('x')
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
  })

  it('off is safe for unknown events', () => {
    const ee = new EventEmitter()
    expect(() => ee.off('nope', () => {})).not.toThrow()
  })

  it('isolates errors in listeners — other listeners still fire', () => {
    const ee = new EventEmitter()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = vi.fn(() => { throw new Error('boom') })
    const b = vi.fn()
    ee.on('x', a)
    ee.on('x', b)
    ee.emit('x')
    expect(b).toHaveBeenCalled()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('on() returns this for chaining', () => {
    const ee = new EventEmitter()
    const result = ee.on('a', () => {}).on('b', () => {})
    expect(result).toBe(ee)
  })

  it('off() returns this for chaining', () => {
    const ee = new EventEmitter()
    const result = ee.off('a')
    expect(result).toBe(ee)
  })
})
