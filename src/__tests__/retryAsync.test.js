/**
 * Phase 2 fix lockdown: retry policy for the upload pipeline.
 *
 * Locks down that:
 *   - Retryable errors (5xx, network blips) are retried up to RETRY_MAX_ATTEMPTS.
 *   - Non-retryable 4xx errors fail fast on the first attempt — we must NOT
 *     burn the full backoff budget on an auth/config error.
 */

jest.mock('@actions/core', () => ({
  warning: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn()
}))

const { retryAsync, HttpError } = require('../upload')

describe('retryAsync', () => {
  beforeEach(() => {
    // Use fake timers so the exponential backoff (1s, 3s, 9s) doesn't make
    // the test suite sleep for ~13 seconds. We advance timers manually after
    // pumping the microtask queue.
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  /**
   * Drive a retryAsync invocation to completion under fake timers.
   * After each rejected attempt the implementation calls `await sleep(backoff)`,
   * so we need to flush microtasks, advance the clock past the next backoff,
   * and repeat until the promise settles.
   */
  async function flushRetries(promise) {
    for (let i = 0; i < 10; i++) {
      // Let any pending .then() handlers run.
      await Promise.resolve()
      await Promise.resolve()
      // Advance past the longest possible backoff in the schedule.
      jest.advanceTimersByTime(10000)
    }
    return promise
  }

  test('returns success after one retryable failure', async () => {
    let calls = 0
    const fn = jest.fn(async () => {
      calls += 1
      if (calls === 1) throw new HttpError('boom', 500)
      return 'ok'
    })

    const promise = retryAsync(fn, { label: 'test' })
    const result = await flushRetries(promise)

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('throws after max attempts when failures keep being retryable', async () => {
    const fn = jest.fn(async () => {
      throw new HttpError('still broken', 500)
    })

    const promise = retryAsync(fn, { label: 'test' }).catch((e) => e)
    const err = await flushRetries(promise)

    expect(err).toBeInstanceOf(HttpError)
    expect(err.statusCode).toBe(500)
    // RETRY_MAX_ATTEMPTS is 3 in src/upload.js — three calls total, no fourth.
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test('fails fast on a 4xx auth error (no retry)', async () => {
    const fn = jest.fn(async () => {
      throw new HttpError('unauthorized', 401)
    })

    const promise = retryAsync(fn, { label: 'test' }).catch((e) => e)
    const err = await flushRetries(promise)

    expect(err).toBeInstanceOf(HttpError)
    expect(err.statusCode).toBe(401)
    // Critical assertion: 4xx is non-retryable and must short-circuit.
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('retries plain Error with no statusCode (network blip)', async () => {
    let calls = 0
    const fn = jest.fn(async () => {
      calls += 1
      if (calls < 2) throw new Error('ECONNRESET')
      return 'recovered'
    })

    const promise = retryAsync(fn, { label: 'test' })
    const result = await flushRetries(promise)

    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
