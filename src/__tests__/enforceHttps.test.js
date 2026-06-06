/**
 * Phase 2 fix lockdown: HTTPS enforcement on the configured api-host.
 *
 * Customer credentials (bearer token or legacy access keys) flow in the body
 * and headers of the upload-url request. Plain HTTP would leak them to any
 * observer on the network, so we enforce HTTPS for all non-loopback hosts.
 */

// Mock @actions/core because upload.js requires it at module load time and
// uses core.warning() inside retryAsync. We don't want any of that to touch
// the real runner.
jest.mock('@actions/core', () => ({
  warning: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn()
}))

const { enforceHttps } = require('../upload')

describe('enforceHttps', () => {
  test('accepts production https URL', () => {
    expect(() => enforceHttps('https://buildpulse.io')).not.toThrow()
  })

  test('accepts http://localhost:3000 (dev carve-out)', () => {
    expect(() => enforceHttps('http://localhost:3000')).not.toThrow()
  })

  test('accepts http://127.0.0.1:8080 (dev carve-out)', () => {
    expect(() => enforceHttps('http://127.0.0.1:8080')).not.toThrow()
  })

  test('accepts http://[::1]:8080 (dev carve-out)', () => {
    expect(() => enforceHttps('http://[::1]:8080')).not.toThrow()
  })

  test('rejects non-loopback http URL with a clear error', () => {
    expect(() => enforceHttps('http://example.com')).toThrow(/HTTPS/)
  })

  test('rejects malformed URL string', () => {
    expect(() => enforceHttps('not a url')).toThrow(/Invalid api-host/)
  })
})
