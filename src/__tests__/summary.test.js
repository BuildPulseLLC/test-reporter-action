/**
 * Job summary builder and its start/finish wiring.
 */

const mockSummaryWrite = jest.fn(async () => undefined)
const mockAddRaw = jest.fn(() => ({ write: mockSummaryWrite }))

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  summary: { addRaw: (...args) => mockAddRaw(...args) }
}))

const fs = require('fs')
const os = require('os')
const path = require('path')

const { testKey } = require('../junit')
const {
  buildSummary,
  buildLinks,
  escapeMarkdown,
  formatDuration,
  isSummaryEnabled,
  startSummary,
  finishSummary
} = require('../summary')

function failure(name, suite = 'CheckoutTest', message = `${name} broke`) {
  return { suite, classname: suite, name, file: '', message }
}

function results(overrides = {}) {
  return {
    tests: 1284,
    passed: 1269,
    failed: 3,
    skipped: 12,
    durationSec: 252,
    failures: [failure('applies discount'), failure('charges tax'), failure('ships')],
    filesRead: 8,
    filesSkipped: 0,
    ...overrides
  }
}

function flakyOk({ flaky = [], quarantined = [], complete = true } = {}) {
  return {
    ok: true,
    flaky: new Set(flaky.map((n) => testKey('CheckoutTest', n))),
    quarantined: new Set(quarantined.map((n) => testKey('CheckoutTest', n))),
    flakyCount: 37,
    quarantinedCount: 4,
    complete
  }
}

const EM_DASH = '\u2014'

describe('buildSummary', () => {
  test('headline totals match the house format', () => {
    const md = buildSummary({ results: results(), flaky: flakyOk({ flaky: ['charges tax'] }) })
    expect(md.split('\n')[0]).toBe('### BuildPulse: 1,284 tests, 3 failed (2 new, 1 known flaky), 12 skipped, 4m 12s')
    expect(md).toContain('1,269 passed. 4m 12s is the sum of test durations across 8 JUnit files.')
    expect(md).not.toContain(EM_DASH)
  })

  test('labels each failure and lists new failures first', () => {
    const md = buildSummary({
      results: results(),
      flaky: flakyOk({ flaky: ['applies discount'], quarantined: ['charges tax'] })
    })
    const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Status') && !l.startsWith('| ---'))
    expect(rows).toEqual([
      '| New failure | CheckoutTest › ships | ships broke |',
      '| Known flaky | CheckoutTest › applies discount | applies discount broke |',
      '| Quarantined | CheckoutTest › charges tax | charges tax broke |'
    ])
    expect(md).toContain('(1 new, 1 known flaky, 1 quarantined)')
    expect(md).toContain('This repository has 37 known flaky tests and 4 quarantined in BuildPulse.')
  })

  test('caps the list at 20 with "and N more"', () => {
    const failures = Array.from({ length: 23 }, (_, i) => failure(`test ${i}`))
    const md = buildSummary({ results: results({ failed: 23, failures }), flaky: flakyOk() })
    const rows = md.split('\n').filter((l) => l.startsWith('| New failure'))
    expect(rows).toHaveLength(20)
    expect(md).toContain('And 3 more failed tests.')
  })

  test('when the API failed, renders from local data and says why', () => {
    const md = buildSummary({ results: results(), flaky: { ok: false, reason: 'BuildPulse did not answer within 3 s' } })
    expect(md.split('\n')[0]).toBe('### BuildPulse: 1,284 tests, 3 failed, 12 skipped, 4m 12s')
    expect(md).toContain('| Failed | CheckoutTest › applies discount | applies discount broke |')
    expect(md).toContain('Flaky status is unavailable: BuildPulse did not answer within 3 s.')
  })

  test('an incomplete flaky list never claims a failure is new', () => {
    const md = buildSummary({ results: results(), flaky: flakyOk({ flaky: ['ships'], complete: false }) })
    expect(md).toContain('3 failed (1 known flaky)')
    expect(md).toContain('| Failed | CheckoutTest › applies discount |')
    expect(md).toContain('Not every flaky and quarantined test could be checked in time')
  })

  test('a clean run has no failure table and no flaky line', () => {
    const md = buildSummary({ results: results({ failed: 0, passed: 1272, failures: [] }) })
    expect(md.split('\n')[0]).toBe('### BuildPulse: 1,284 tests, 0 failed, 12 skipped, 4m 12s')
    expect(md).not.toContain('| Status')
    expect(md).not.toContain('Flaky status')
  })

  test('no test cases, skipped files, upload failure', () => {
    const md = buildSummary({
      results: results({ tests: 0, passed: 0, failed: 0, skipped: 0, durationSec: 0, failures: [], filesRead: 1, filesSkipped: 2 }),
      uploadFailed: true,
      links: { repositories: 'https://buildpulse.io/organizations/o/repositories' }
    })
    expect(md).toContain('### BuildPulse: no test cases found')
    expect(md).toContain('Read 1 JUnit file and found no test cases.')
    expect(md).toContain('2 files were not counted because they could not be read or exceeded 50 MB.')
    expect(md).toContain('The upload to BuildPulse failed')
    expect(md).not.toContain('View in BuildPulse')
  })

  test('escapes markdown and HTML in test names and messages', () => {
    const md = buildSummary({
      results: results({ failed: 1, failures: [failure('a | b', '', '<script>x</script>\nsecond line')] }),
      flaky: flakyOk()
    })
    expect(md).toContain('| New failure | a \\| b | &lt;script&gt;x&lt;/script&gt; second line |')
  })

  test('links to the repository when its BuildPulse id is known', () => {
    const md = buildSummary({
      results: results({ failed: 0, failures: [] }),
      links: buildLinks({ organizationId: 'org-1', repositoryId: 'repo-1' })
    })
    expect(md).toContain(
      'View in BuildPulse: [test runs](https://buildpulse.io/organizations/org-1/repositories/repo-1/test-runs), ' +
      '[flaky tests](https://buildpulse.io/organizations/org-1/repositories/repo-1/flaky-tests)'
    )
  })
})

describe('helpers', () => {
  test('buildLinks falls back to the repository list, or nothing', () => {
    expect(buildLinks({ organizationId: 'org-1' })).toEqual({ repositories: 'https://buildpulse.io/organizations/org-1/repositories' })
    expect(buildLinks({ webHost: 'https://env.buildpulse.io/', organizationId: 'o', repositoryId: 'r' }).testRuns)
      .toBe('https://env.buildpulse.io/organizations/o/repositories/r/test-runs')
    expect(buildLinks({})).toEqual({})
  })

  test('formatDuration', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(0.85)).toBe('850ms')
    expect(formatDuration(4.24)).toBe('4.2s')
    expect(formatDuration(42.4)).toBe('42s')
    expect(formatDuration(252)).toBe('4m 12s')
    expect(formatDuration(3900)).toBe('1h 5m')
  })

  test('isSummaryEnabled defaults to on', () => {
    expect(isSummaryEnabled('')).toBe(true)
    expect(isSummaryEnabled('true')).toBe(true)
    expect(isSummaryEnabled('false')).toBe(false)
    expect(isSummaryEnabled(' FALSE ')).toBe(false)
  })

  test('escapeMarkdown flattens newlines', () => {
    expect(escapeMarkdown('a\n\n  b')).toBe('a b')
  })
})

describe('startSummary / finishSummary', () => {
  let dir
  let file
  const env = process.env.GITHUB_STEP_SUMMARY

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-summary-'))
    file = path.join(dir, 'junit.xml')
    fs.writeFileSync(file, '<testsuite name="CheckoutTest"><testcase name="applies discount" time="1"><failure message="boom"/></testcase></testsuite>')
  })
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    if (env === undefined) delete process.env.GITHUB_STEP_SUMMARY
    else process.env.GITHUB_STEP_SUMMARY = env
  })
  beforeEach(() => {
    process.env.GITHUB_STEP_SUMMARY = path.join(dir, 'summary.md')
  })

  test('job-summary: false reads nothing, calls nothing, writes nothing', async () => {
    const fetchImpl = jest.fn()
    const state = startSummary({ enabled: false, files: [file], apiToken: 'bp_x', repository: 'acme/shop', lookupOptions: { fetchImpl } })
    expect(state).toBeNull()
    expect(await finishSummary(state, { uploadResult: { organizationId: 'o' } })).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(mockAddRaw).not.toHaveBeenCalled()
  })

  test('API failure still writes the local summary', async () => {
    const fetchImpl = jest.fn(async () => { throw new TypeError('fetch failed') })
    const state = startSummary({
      enabled: true,
      files: [file],
      apiToken: 'bp_x',
      repository: 'acme/shop',
      lookupOptions: { fetchImpl, env: {} }
    })
    const md = await finishSummary(state, { uploadResult: { organizationId: 'org-1' } })
    expect(md).toContain('### BuildPulse: 1 test, 1 failed, 0 skipped, 1s')
    expect(md).toContain('| Failed | CheckoutTest › applies discount | boom |')
    expect(md).toContain('Flaky status is unavailable: the BuildPulse API could not be reached.')
    expect(md).toContain('[repositories](https://buildpulse.io/organizations/org-1/repositories)')
    expect(mockAddRaw).toHaveBeenCalledWith(md)
    expect(mockSummaryWrite).toHaveBeenCalled()
  })

  test('labels a known flaky failure end to end', async () => {
    const fetchImpl = jest.fn(async (url) => {
      const u = new URL(url)
      const body = u.pathname === '/api/me/repositories'
        ? { repositories: [{ id: 'repo-1', full_name: 'acme/shop' }] }
        : u.searchParams.get('quarantine') === 'true'
          ? { count: 0, tests: [], metadata: {} }
          : { count: 1, tests: [{ name: 'applies discount', suite: 'CheckoutTest' }], metadata: {} }
      return { status: 200, json: async () => body }
    })
    const state = startSummary({ enabled: true, files: [file], apiToken: 'bp_x', repository: 'acme/shop', lookupOptions: { fetchImpl, env: {} } })
    const md = await finishSummary(state, { uploadResult: { organizationId: 'org-1' } })
    expect(md).toContain('1 failed (1 known flaky)')
    expect(md).toContain('| Known flaky | CheckoutTest › applies discount | boom |')
    expect(md).toContain('/organizations/org-1/repositories/repo-1/test-runs')
  })

  test('without GITHUB_STEP_SUMMARY nothing is written', async () => {
    delete process.env.GITHUB_STEP_SUMMARY
    const state = startSummary({ enabled: true, files: [file], apiToken: '', repository: 'acme/shop' })
    expect(await finishSummary(state, {})).toBeNull()
    expect(mockAddRaw).not.toHaveBeenCalled()
  })

  test('a write error is swallowed', async () => {
    mockSummaryWrite.mockRejectedValueOnce(new Error('disk full'))
    const state = startSummary({ enabled: true, files: [file], apiToken: '', repository: 'acme/shop' })
    await expect(finishSummary(state, {})).resolves.toBeNull()
  })
})
