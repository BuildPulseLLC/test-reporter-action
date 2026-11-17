/**
 * BuildPulse flaky-status lookup used by the job summary. All network access
 * goes through an injected fetch, so these tests never leave the process.
 */

const { lookupFlakyStatus, resolvePlatformHost } = require('../flaky')
const { testKey } = require('../junit')

function jsonResponse(status, body) {
  return { status, json: async () => body }
}

/**
 * Fake platform API. `routes` maps a predicate on the URL to a response.
 */
function fakeFetch(handler) {
  const calls = []
  const fn = jest.fn(async (url, opts) => {
    calls.push({ url: new URL(url), opts })
    return handler(new URL(url), opts)
  })
  fn.calls = calls
  return fn
}

const base = { apiToken: 'bp_test', repository: 'acme/shop', env: {} }

const STATUS_PATH = '/api/v1/action/test-status'

/**
 * An older platform: the single-request route does not exist, so it answers
 * the router's plain-text 404 and every other path goes to `handler`.
 */
function olderPlatform(handler) {
  return (url, opts) => {
    if (url.pathname === STATUS_PATH) {
      return { status: 404, json: async () => { throw new SyntaxError('Unexpected token p') } }
    }
    return handler(url, opts)
  }
}

describe('lookupFlakyStatus with the test-status route', () => {
  const statusBody = {
    flaky: [{ suite: 'S', name: 'f1' }, { suite: '', name: 'f2' }],
    quarantined: [{ suite: 'S', name: 'q1' }],
    flakyCount: 2,
    quarantinedCount: 1,
    truncated: false,
    repositoryId: 'repo-uuid',
    organizationId: 'org-uuid'
  }

  test('reads both lists and the repository id in one request', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, statusBody))
    const out = await lookupFlakyStatus({ ...base, fetchImpl })

    expect(out.repositoryId).toBe('repo-uuid')
    expect(out.flaky).toEqual({
      ok: true,
      flaky: new Set([testKey('S', 'f1'), testKey('default', 'f2')]),
      quarantined: new Set([testKey('S', 'q1')]),
      flakyCount: 2,
      quarantinedCount: 1,
      complete: true
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const call = fetchImpl.calls[0]
    expect(call.url.origin).toBe('https://platform.buildpulse.io')
    expect(call.url.pathname).toBe(STATUS_PATH)
    expect(call.url.searchParams.get('repository')).toBe('shop')
    expect(call.url.searchParams.has('names')).toBe(false)
    expect(call.opts.headers.Authorization).toBe('Bearer bp_test')
    expect(call.opts.headers['User-Agent']).toMatch(/BuildPulse/)
  })

  test('a truncated answer is incomplete, so unmatched failures are not called new', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, { ...statusBody, truncated: true, flakyCount: 4500 }))
    const out = await lookupFlakyStatus({ ...base, fetchImpl })
    expect(out.flaky.ok).toBe(true)
    expect(out.flaky.complete).toBe(false)
    expect(out.flaky.flakyCount).toBe(4500)
  })

  test('asks for ids only when there are no failures to label', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, { repositoryId: 'r', organizationId: 'o' }))
    const out = await lookupFlakyStatus({ ...base, fetchImpl, includeFlaky: false })
    expect(out.repositoryId).toBe('r')
    expect(out.flaky.ok).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.calls[0].url.searchParams.get('names')).toBe('false')
  })

  test('an unknown repository does not fall back to the older endpoints', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(404, { code: 'repository_not_found', message: 'nope' }))
    const out = await lookupFlakyStatus({ ...base, fetchImpl })
    expect(out).toEqual({ flaky: { ok: false, reason: 'BuildPulse has no data for this repository yet' }, repositoryId: null })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('rate limiting resolves to a readable reason without a fallback', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(429, { code: 'rate_limited' }))
    const out = await lookupFlakyStatus({ ...base, fetchImpl })
    expect(out.flaky).toEqual({ ok: false, reason: 'BuildPulse is rate limiting this API token, try again shortly' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('falls back to the paginated endpoints when the route is missing', async () => {
    const fetchImpl = fakeFetch(olderPlatform((url) => {
      if (url.pathname === '/api/me/repositories') return jsonResponse(200, { repositories: [{ id: 'repo-uuid', full_name: 'acme/shop' }] })
      const name = url.searchParams.get('quarantine') === 'true' ? 'q1' : 'f1'
      return jsonResponse(200, { count: 1, tests: [{ name, suite: 'S' }], metadata: { after: null } })
    }))
    const out = await lookupFlakyStatus({ ...base, fetchImpl })
    expect(out.repositoryId).toBe('repo-uuid')
    expect(out.flaky.ok).toBe(true)
    expect(out.flaky.flaky.has(testKey('S', 'f1'))).toBe(true)
    expect(out.flaky.quarantined.has(testKey('S', 'q1'))).toBe(true)
    expect(fetchImpl.calls[0].url.pathname).toBe(STATUS_PATH)
    expect(fetchImpl.calls.map((c) => c.url.pathname).sort()).toEqual(
      ['/api/me/repositories', STATUS_PATH, '/api/v1/flaky/tests', '/api/v1/flaky/tests'].sort()
    )
  })
})

describe('resolvePlatformHost', () => {
  test('derives the platform host from the api host', () => {
    expect(resolvePlatformHost(undefined, {})).toBe('https://platform.buildpulse.io')
    expect(resolvePlatformHost('https://buildpulse.io', {})).toBe('https://platform.buildpulse.io')
    expect(resolvePlatformHost('https://www.buildpulse.io', {})).toBe('https://platform.buildpulse.io')
    expect(resolvePlatformHost('https://env.buildpulse.io', {})).toBe('https://platform.env.buildpulse.io')
  })

  test('honors the override and gives up on unknown hosts', () => {
    expect(resolvePlatformHost('http://localhost:3000', { BUILDPULSE_PLATFORM_API_HOST: 'http://localhost:8080/' })).toBe('http://localhost:8080')
    expect(resolvePlatformHost('http://localhost:3000', {})).toBeNull()
  })
})

describe('lookupFlakyStatus on an older platform', () => {
  test('collects flaky and quarantined keys, follows pagination, and finds the repository id', async () => {
    const fetchImpl = fakeFetch(olderPlatform((url) => {
      if (url.pathname === '/api/me/repositories') {
        return jsonResponse(200, { repositories: [{ id: 'other', full_name: 'acme/web' }, { id: 'repo-uuid', full_name: 'Acme/Shop' }] })
      }
      const q = url.searchParams
      if (q.get('quarantine') === 'true') {
        return jsonResponse(200, { count: 1, tests: [{ name: 'q1', suite: 'S' }], metadata: { after: null, limit: 100 } })
      }
      if (!q.get('after')) {
        return jsonResponse(200, { count: 2, tests: [{ name: 'f1', suite: 'S' }], metadata: { after: 'b2Zmc2V0OjEwMA==', limit: 100 } })
      }
      return jsonResponse(200, { count: 2, tests: [{ name: 'f2', suite: '' }], metadata: { after: null, limit: 100 } })
    }))

    const out = await lookupFlakyStatus({ ...base, fetchImpl })

    expect(out.repositoryId).toBe('repo-uuid')
    expect(out.flaky.ok).toBe(true)
    expect(out.flaky.complete).toBe(true)
    expect(out.flaky.flakyCount).toBe(2)
    expect(out.flaky.quarantinedCount).toBe(1)
    expect([...out.flaky.flaky]).toEqual([testKey('S', 'f1'), testKey('default', 'f2')])
    expect([...out.flaky.quarantined]).toEqual([testKey('S', 'q1')])

    const flakyCall = fetchImpl.calls.find((c) => c.url.pathname === '/api/v1/flaky/tests')
    expect(flakyCall.url.origin).toBe('https://platform.buildpulse.io')
    expect(flakyCall.url.searchParams.get('repository')).toBe('shop')
    expect(flakyCall.url.searchParams.get('limit')).toBe('100')
    expect(flakyCall.opts.headers.Authorization).toBe('Bearer bp_test')
    expect(flakyCall.opts.headers['User-Agent']).toMatch(/BuildPulse/)
  })

  test('marks the result incomplete when the list has more pages than it reads', async () => {
    const fetchImpl = fakeFetch(olderPlatform((url) => {
      if (url.pathname === '/api/me/repositories') return jsonResponse(200, { repositories: [] })
      return jsonResponse(200, { count: 5000, tests: [], metadata: { after: 'more' } })
    }))
    const out = await lookupFlakyStatus({ ...base, fetchImpl })
    expect(out.flaky.ok).toBe(true)
    expect(out.flaky.complete).toBe(false)
    expect(out.repositoryId).toBeNull()
  })

  test('a plan without API access resolves to a readable reason, never a throw', async () => {
    const fetchImpl = fakeFetch(olderPlatform(() => jsonResponse(403, { code: 'plan_required' })))
    const out = await lookupFlakyStatus({ ...base, fetchImpl })
    expect(out.flaky).toEqual({ ok: false, reason: "this organization's plan does not include API access" })
    expect(out.repositoryId).toBeNull()
  })

  test('network errors resolve to unavailable', async () => {
    const fetchImpl = fakeFetch(() => { throw new TypeError('fetch failed') })
    const out = await lookupFlakyStatus({ ...base, fetchImpl })
    expect(out.flaky).toEqual({ ok: false, reason: 'the BuildPulse API could not be reached' })
  })

  test('gives up at the deadline and makes one attempt only', async () => {
    const fetchImpl = fakeFetch((url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const started = Date.now()
    const out = await lookupFlakyStatus({ ...base, fetchImpl, timeoutMs: 50 })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(out.flaky).toEqual({ ok: false, reason: 'BuildPulse did not answer within 0.1 s' })
    // The single status request, no retries and no fallback after a timeout.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('the fallback shares the same deadline', async () => {
    const fetchImpl = fakeFetch(olderPlatform((url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    const out = await lookupFlakyStatus({ ...base, fetchImpl, timeoutMs: 50 })
    expect(out.flaky).toEqual({ ok: false, reason: 'BuildPulse did not answer within 0.1 s' })
    // status route + repositories + one request per flaky list, no retries
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  test('keeps the pages already read when the deadline hits mid-pagination', async () => {
    const fetchImpl = fakeFetch(olderPlatform((url, opts) => {
      if (url.pathname === '/api/me/repositories') return jsonResponse(200, { repositories: [] })
      if (!url.searchParams.get('after')) {
        const name = url.searchParams.get('quarantine') === 'true' ? 'q1' : 'f1'
        return jsonResponse(200, { count: 900, tests: [{ name, suite: 'S' }], metadata: { after: 'next' } })
      }
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }))
    const out = await lookupFlakyStatus({ ...base, fetchImpl, timeoutMs: 50 })
    expect(out.flaky.ok).toBe(true)
    expect(out.flaky.complete).toBe(false)
    expect(out.flaky.flaky.has(testKey('S', 'f1'))).toBe(true)
    expect(out.flaky.quarantined.has(testKey('S', 'q1'))).toBe(true)
  })

  test('skips the flaky lists when there are no failures to label', async () => {
    const fetchImpl = fakeFetch(olderPlatform(() => jsonResponse(200, { repositories: [{ id: 'r', full_name: 'acme/shop' }] })))
    const out = await lookupFlakyStatus({ ...base, fetchImpl, includeFlaky: false })
    expect(out.repositoryId).toBe('r')
    expect(out.flaky.ok).toBe(false)
    expect(fetchImpl.calls.map((c) => c.url.pathname)).toEqual([STATUS_PATH, '/api/me/repositories'])
  })

  test('legacy key/secret auth makes no request', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, {}))
    const out = await lookupFlakyStatus({ ...base, apiToken: '', fetchImpl })
    expect(out.flaky.ok).toBe(false)
    expect(out.flaky.reason).toMatch(/api-token/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('refuses a plain-HTTP platform host', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, {}))
    const out = await lookupFlakyStatus({ ...base, fetchImpl, env: { BUILDPULSE_PLATFORM_API_HOST: 'http://example.com' } })
    expect(out.flaky.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
