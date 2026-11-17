/**
 * Best-effort lookup of a repository's flaky and quarantined tests from the
 * BuildPulse REST API, used only to label failures in the job summary.
 *
 * Contract: one attempt, one shared deadline (3 s by default) across every
 * request, and the returned promise never rejects. Any failure resolves to
 * `{ ok: false, reason }` so the summary can still render from local data.
 *
 * Endpoints (platform API, `Authorization: Bearer <api-token>`):
 *   GET /api/v1/action/test-status?repository=<name>[&names=false]
 *       one request: flaky and quarantined test names plus the repository
 *       id. Available on every plan and not counted as API usage.
 *   Fallback, only when that route answers a plain 404 (an older platform):
 *   GET /api/v1/flaky/tests?repository=<name>&quarantine=false|true
 *       flaky / quarantined tests, paginated
 *   GET /api/me/repositories
 *       the organization's repositories, used to link to this one
 */

const { enforceHttps } = require('./upload')
const { testKey } = require('./junit')

const DEFAULT_TIMEOUT_MS = 3000
const PAGE_SIZE = 100 // the API's maximum
const MAX_PAGES = 10 // per list, so at most 1,000 tests are compared
const USER_AGENT = 'BuildPulse-TestReporter/3.0'

/**
 * Work out the platform API host from the action's api-host. The web app and
 * upload endpoint live on buildpulse.io; the REST API is on the platform.
 * subdomain of the same environment. BUILDPULSE_PLATFORM_API_HOST overrides.
 * @param {string} [apiHost]
 * @param {Object} [env]
 * @returns {string|null} Origin, or null when it cannot be derived
 */
function resolvePlatformHost(apiHost, env = process.env) {
  if (env.BUILDPULSE_PLATFORM_API_HOST) return env.BUILDPULSE_PLATFORM_API_HOST.replace(/\/+$/, '')
  let host
  try {
    host = new URL(apiHost || 'https://buildpulse.io').hostname.replace(/^www\./, '')
  } catch {
    return null
  }
  if (host === 'buildpulse.io' || host.endsWith('.buildpulse.io')) return `https://platform.${host}`
  return null
}

/**
 * Explain a non-200 answer in a few words for the summary.
 * @param {number} status
 * @returns {string}
 */
function describeStatus(status) {
  switch (status) {
    case 401: return 'the API token was not accepted'
    case 402: return 'this organization is over its plan limit, so test data reads are paused'
    case 403: return "this organization's plan does not include API access"
    case 404: return 'BuildPulse has no data for this repository yet'
    case 429: return 'BuildPulse is rate limiting this API token, try again shortly'
    default: return `the BuildPulse API answered ${status}`
  }
}

class LookupError extends Error {}

function request(fetchImpl, url, token, signal) {
  return fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT
    },
    signal
  })
}

async function getJson(fetchImpl, url, token, signal) {
  const res = await request(fetchImpl, url, token, signal)
  if (res.status !== 200) throw new LookupError(describeStatus(res.status))
  return res.json()
}

/**
 * One request for the repository's test status.
 * @returns {Promise<Object|null>} The response body, or null when the route
 *   does not exist (a plain 404 from an older platform), so the caller falls
 *   back to the paginated endpoints.
 */
async function fetchTestStatus(fetchImpl, base, repoName, includeFlaky, token, signal) {
  const params = new URLSearchParams({ repository: repoName })
  if (!includeFlaky) params.set('names', 'false')
  const res = await request(fetchImpl, `${base}/api/v1/action/test-status?${params}`, token, signal)
  if (res.status === 200) return res.json()
  if (res.status === 404) {
    // The route answers an unknown repository with a JSON code; anything
    // else on a 404 means the route itself is missing.
    let body = null
    try {
      body = await res.json()
    } catch {
      // Not JSON: the route is missing.
    }
    if (body && body.code === 'repository_not_found') throw new LookupError(describeStatus(404))
    return null
  }
  throw new LookupError(describeStatus(res.status))
}

function keysOf(tests) {
  const keys = new Set()
  for (const t of tests || []) keys.add(testKey(t.suite || 'default', t.name || ''))
  return keys
}

/**
 * Page through one flaky list until it ends, MAX_PAGES is reached, or the
 * deadline aborts the request.
 */
async function fetchList(fetchImpl, base, repoName, quarantine, token, signal) {
  const keys = new Set()
  let count = 0
  let after = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      repository: repoName,
      quarantine: quarantine ? 'true' : 'false',
      limit: String(PAGE_SIZE)
    })
    if (after) params.set('after', after)
    let body
    try {
      body = await getJson(fetchImpl, `${base}/api/v1/flaky/tests?${params}`, token, signal)
    } catch (err) {
      // Out of time after at least one page: keep what was read. Known flaky
      // labels are still right; unmatched failures just are not called new.
      if (page > 0 && signal.aborted) return { keys, count, complete: false }
      throw err
    }
    if (page === 0) count = Number(body.count) || 0
    for (const key of keysOf(body.tests)) keys.add(key)
    after = body.metadata && body.metadata.after
    if (!after) return { keys, count, complete: true }
  }
  return { keys, count, complete: false }
}

/**
 * Find this repository's BuildPulse id, for the dashboard link.
 * @returns {Promise<string|null>}
 */
async function fetchRepositoryId(fetchImpl, base, fullName, token, signal) {
  const body = await getJson(fetchImpl, `${base}/api/me/repositories`, token, signal)
  const want = fullName.toLowerCase()
  const repo = (body.repositories || []).find((r) => (r.full_name || '').toLowerCase() === want)
  return repo ? repo.id : null
}

function reasonFor(err, timedOut, timeoutMs) {
  if (timedOut) return `BuildPulse did not answer within ${Math.round(timeoutMs / 100) / 10} s`
  if (err instanceof LookupError) return err.message
  return 'the BuildPulse API could not be reached'
}

/**
 * @param {Object} params
 * @param {string} params.apiToken - bp_ API token
 * @param {string} params.repository - "owner/name"
 * @param {string} [params.apiHost] - The action's api-host input
 * @param {boolean} [params.includeFlaky=true] - Skip the flaky lists when there is nothing to label
 * @param {number} [params.timeoutMs]
 * @param {Function} [params.fetchImpl] - Injected for tests
 * @param {Object} [params.env]
 * @returns {Promise<{
 *   flaky: ({ ok: true, flaky: Set<string>, quarantined: Set<string>, flakyCount: number,
 *            quarantinedCount: number, complete: boolean } | { ok: false, reason: string }),
 *   repositoryId: string|null
 * }>}
 */
async function lookupFlakyStatus({
  apiToken,
  repository,
  apiHost,
  includeFlaky = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  env = process.env
}) {
  const unavailable = (reason) => ({ flaky: { ok: false, reason }, repositoryId: null })

  if (!apiToken) return unavailable('reading it needs the api-token input, and this job uses key and secret')
  const [, repoName] = (repository || '').split('/')
  if (!repoName) return unavailable('the repository name is not known')
  if (typeof fetchImpl !== 'function') return unavailable('this runner has no fetch support')

  const base = resolvePlatformHost(apiHost, env)
  if (!base) return unavailable('the BuildPulse API host could not be determined')
  try {
    enforceHttps(base)
  } catch (err) {
    return unavailable(err.message)
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const { signal } = controller

  const noFailures = { ok: false, reason: 'there were no failures to check' }

  try {
    let status
    try {
      status = await fetchTestStatus(fetchImpl, base, repoName, includeFlaky, apiToken, signal)
    } catch (err) {
      return unavailable(reasonFor(err, timedOut, timeoutMs))
    }
    if (status) {
      const repositoryId = status.repositoryId || null
      if (!includeFlaky) return { flaky: noFailures, repositoryId }
      return {
        flaky: {
          ok: true,
          flaky: keysOf(status.flaky),
          quarantined: keysOf(status.quarantined),
          flakyCount: Number(status.flakyCount) || 0,
          quarantinedCount: Number(status.quarantinedCount) || 0,
          // Past the server's cap an unmatched failure may still be flaky.
          complete: !status.truncated
        },
        repositoryId
      }
    }

    // Older platform without the single-request route: page the public
    // endpoints instead, within what is left of the same deadline.
    const repoIdP = fetchRepositoryId(fetchImpl, base, repository, apiToken, signal).catch(() => null)

    let flaky = noFailures
    if (includeFlaky) {
      try {
        const [known, quarantined] = await Promise.all([
          fetchList(fetchImpl, base, repoName, false, apiToken, signal),
          fetchList(fetchImpl, base, repoName, true, apiToken, signal)
        ])
        flaky = {
          ok: true,
          flaky: known.keys,
          quarantined: quarantined.keys,
          flakyCount: known.count,
          quarantinedCount: quarantined.count,
          complete: known.complete && quarantined.complete
        }
      } catch (err) {
        flaky = { ok: false, reason: reasonFor(err, timedOut, timeoutMs) }
      }
    }

    return { flaky, repositoryId: await repoIdP }
  } catch (err) {
    return unavailable(reasonFor(err, timedOut, timeoutMs))
  } finally {
    clearTimeout(timer)
    // Cancel anything still in flight (the other list after one failed).
    controller.abort()
  }
}

module.exports = {
  lookupFlakyStatus,
  resolvePlatformHost,
  describeStatus,
  DEFAULT_TIMEOUT_MS,
  MAX_PAGES,
  PAGE_SIZE
}
