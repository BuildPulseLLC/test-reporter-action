/**
 * Phase 2 fix lockdown: credential masking.
 *
 * The most important Phase 2 fix: every credential input the action reads
 * must be registered with the runner via core.setSecret() BEFORE any code
 * path that could log them. GitHub Actions only auto-masks repo secrets;
 * if a customer ever passes a credential through a non-secret input or env
 * var (e.g. by mistake) and we log the value before registering it, that
 * token leaks into the public action log forever.
 *
 * This test imports `src/index.js` with `@actions/core` mocked, drives the
 * input-parsing path, and asserts:
 *   1. core.setSecret was called once for each non-empty credential input.
 *   2. core.setSecret was called BEFORE any other observable code path
 *      (e.g. core.setFailed, core.info, core.warning) that could emit a
 *      log line containing arbitrary text.
 */

// Inputs we want index.js to "see" when it calls core.getInput().
const mockInputs = {
  'api-token': 'abc',
  'key': 'def',
  'secret': 'ghi'
}

// jest.mock() factories may only reference variables prefixed with `mock`
// (Jest's hoisting / out-of-scope-variable safety check). All shared mock
// fns are declared with that prefix below.
const mockSetSecret = jest.fn()
const mockSetFailed = jest.fn()
const mockSetOutput = jest.fn()
const mockInfo = jest.fn()
const mockWarning = jest.fn()
const mockDebug = jest.fn()
const mockError = jest.fn()

jest.mock('@actions/core', () => ({
  getInput: jest.fn((name, opts) => {
    if (Object.prototype.hasOwnProperty.call(mockInputs, name)) return mockInputs[name]
    if (opts && opts.required) {
      // Mirror the real toolkit behaviour so run() throws on the required
      // `path` input. The throw is caught inside run() and routed to
      // core.setFailed — by that point the credential setSecret calls
      // have already happened.
      throw new Error(`Input required and not supplied: ${name}`)
    }
    return ''
  }),
  setSecret: mockSetSecret,
  setFailed: mockSetFailed,
  setOutput: mockSetOutput,
  info: mockInfo,
  warning: mockWarning,
  debug: mockDebug,
  error: mockError
}))

// Stub out everything index.js wires up downstream so run() can't reach
// real network / fs operations even if it gets past setSecret.
jest.mock('@actions/glob', () => ({
  create: jest.fn(async () => ({ glob: async () => [] }))
}))
jest.mock('../auth', () => ({
  authenticate: jest.fn(() => ({ headers: {}, body: {} })),
  validateAuthInputs: jest.fn(() => true)
}))
jest.mock('../metadata', () => ({
  collectMetadata: jest.fn(() => ({ commit: 'sha', branch: 'main', buildNumber: '1' }))
}))
jest.mock('../archive', () => ({
  createArchive: jest.fn(async () => undefined)
}))
jest.mock('../upload', () => ({
  upload: jest.fn(async () => ({ uploadId: 'u', accountId: 'a', repositoryId: 'r' }))
}))
jest.mock('../sampler', () => ({
  createSampler: jest.fn(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    getResults: jest.fn(() => ({}))
  })),
  getRunnerInfo: jest.fn(() => ({ cpus: 1, total_memory_mb: 1, os: 'x', arch: 'y' }))
}))

describe('index.js secret registration', () => {
  // We snapshot the recorded call data here so the global `clearMocks: true`
  // in jest.config.js — which runs before every individual test — doesn't
  // erase the evidence of the one-shot `run()` invocation.
  const snapshot = {
    setSecretCalls: [],
    setSecretOrders: [],
    setFailedOrders: [],
    logOrders: []
  }

  beforeAll(async () => {
    // Loading the module triggers `run()` at the bottom of src/index.js.
    require('../index')
    // Flush the microtask queue several times so the async run() can progress
    // through its synchronous prefix (input reads + setSecret + setFailed).
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve()
    }

    snapshot.setSecretCalls = mockSetSecret.mock.calls.map((c) => c[0])
    snapshot.setSecretOrders = [...mockSetSecret.mock.invocationCallOrder]
    snapshot.setFailedOrders = [...mockSetFailed.mock.invocationCallOrder]
    snapshot.logOrders = [
      ...mockInfo.mock.invocationCallOrder,
      ...mockWarning.mock.invocationCallOrder,
      ...mockDebug.mock.invocationCallOrder,
      ...mockError.mock.invocationCallOrder
    ].sort((a, b) => a - b)
  })

  test('core.setSecret was called for each credential input', () => {
    expect(snapshot.setSecretCalls).toEqual(expect.arrayContaining(['abc', 'def', 'ghi']))
    // Exactly three credentials in this scenario — no extras, no misses.
    expect(snapshot.setSecretCalls).toHaveLength(3)
  })

  test('setSecret fires BEFORE setFailed (so any error message is already masked)', () => {
    // run() is expected to bail at the required `path` input and route
    // the resulting error through core.setFailed.
    expect(snapshot.setFailedOrders.length).toBeGreaterThan(0)

    const lastSetSecretOrder = snapshot.setSecretOrders.at(-1)
    const firstSetFailedOrder = snapshot.setFailedOrders[0]

    expect(lastSetSecretOrder).toBeLessThan(firstSetFailedOrder)
  })

  test('setSecret fires BEFORE any info/warning/debug/error log call', () => {
    // None of these log channels should fire before all credentials are
    // registered. If a future change ever logs something between the
    // getInput reads and the setSecret calls, this assertion catches it.
    const firstSetSecretOrder = snapshot.setSecretOrders[0]
    const earliestLogOrder = snapshot.logOrders[0]

    if (earliestLogOrder !== undefined) {
      expect(firstSetSecretOrder).toBeLessThan(earliestLogOrder)
    }
  })
})
