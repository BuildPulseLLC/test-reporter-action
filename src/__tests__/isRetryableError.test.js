/**
 * Phase 2 fix lockdown: the retry-decision predicate.
 *
 * Pure function. Decides which errors are worth retrying. Drift here means
 * either CI burns budget on permanent auth failures (false positives) or we
 * give up on transient blips (false negatives), so it's worth a regression
 * test.
 */

jest.mock('@actions/core', () => ({
  warning: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn()
}))

const { isRetryableError } = require('../upload')

describe('isRetryableError', () => {
  test.each([500, 502, 503, 504, 408, 425, 429])(
    'returns true for retryable status code %i',
    (status) => {
      const err = new Error('http')
      err.statusCode = status
      expect(isRetryableError(err)).toBe(true)
    }
  )

  test('returns true for an error with no statusCode (network/timeout)', () => {
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true)
  })

  test.each([400, 401, 403, 404])(
    'returns false for non-retryable status code %i',
    (status) => {
      const err = new Error('http')
      err.statusCode = status
      expect(isRetryableError(err)).toBe(false)
    }
  )

  test('returns false for null/undefined error', () => {
    expect(isRetryableError(null)).toBe(false)
    expect(isRetryableError(undefined)).toBe(false)
  })
})
