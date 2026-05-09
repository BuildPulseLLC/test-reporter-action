/**
 * Upload module
 * Handles API calls to get signed URLs and S3 uploads
 */

const core = require('@actions/core')
const fs = require('fs')
const https = require('https')
const http = require('http')
const { URL } = require('url')

const DEFAULT_API_HOST = 'https://app2.buildpulse.io'

// Retry policy. Three attempts total with exponential backoff (1s, 3s, 9s).
// The legacy run.sh used `curl --retry 3`; matching that posture for the new
// Node implementation. Total worst-case added latency is ~13s before final
// failure, which is acceptable for a CI step.
const RETRY_MAX_ATTEMPTS = 3
const RETRY_BACKOFFS_MS = [1000, 3000, 9000]

/**
 * Error class that carries an HTTP status code so retry logic can decide
 * whether to retry (5xx + network) vs fail fast (4xx auth/client errors).
 */
class HttpError extends Error {
  constructor(message, statusCode) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
  }
}

/**
 * Decide whether an error is worth retrying.
 * - Network/socket errors (no statusCode): retry
 * - 5xx server errors: retry
 * - 408 Request Timeout, 425 Too Early, 429 Too Many Requests: retry
 * - All other 4xx (auth, malformed request): fail fast
 * @param {Error} err
 * @returns {boolean}
 */
function isRetryableError(err) {
  if (!err) return false
  const status = err.statusCode
  if (status == null) return true // network/timeout/unknown
  if (status >= 500 && status < 600) return true
  if (status === 408 || status === 425 || status === 429) return true
  return false
}

/**
 * Sleep for the given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run an async function with retries on retryable errors.
 *
 * Idempotency note: the function is invoked from scratch on every attempt,
 * so any caller that needs idempotency (e.g. re-fetching a signed URL that
 * may have expired during backoff) should put that logic *inside* the fn.
 *
 * @param {() => Promise<T>} fn - Operation to run
 * @param {Object} [opts]
 * @param {string} [opts.label] - Human-readable label for log messages
 * @returns {Promise<T>}
 * @template T
 */
async function retryAsync(fn, { label = 'request' } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === RETRY_MAX_ATTEMPTS || !isRetryableError(err)) {
        throw err
      }
      const backoff = RETRY_BACKOFFS_MS[attempt - 1] ?? RETRY_BACKOFFS_MS[RETRY_BACKOFFS_MS.length - 1]
      core.warning(
        `${label} attempt ${attempt}/${RETRY_MAX_ATTEMPTS} failed (${err.message}); retrying in ${backoff}ms`
      )
      await sleep(backoff)
    }
  }
  // Unreachable under normal flow, but keeps return-type contract.
  throw lastErr
}

// Hosts that are allowed over plain HTTP. Carve-out exists exclusively for local
// integration testing against a dev API server; any non-loopback host MUST use HTTPS
// so bearer tokens / legacy access keys are never sent in cleartext on a self-hosted
// runner that points at a misconfigured BUILDPULSE_API_HOST or api-host input.
const HTTP_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Enforce HTTPS for the configured API host. Throws a clear error if the URL is
 * plain HTTP and not pointing at loopback. Customer credentials (bearer token or
 * legacy access keys) are sent in this request, so cleartext is unacceptable.
 * @param {string} apiHost - Configured API host URL
 */
function enforceHttps(apiHost) {
  let parsed
  try {
    parsed = new URL(apiHost)
  } catch (err) {
    throw new Error(`Invalid api-host value: ${apiHost}`)
  }

  if (parsed.protocol === 'https:') return

  if (parsed.protocol === 'http:' && HTTP_ALLOWED_HOSTS.has(parsed.hostname)) return

  throw new Error(
    `api-host must use HTTPS (got ${parsed.protocol}//${parsed.hostname}). ` +
    'Plain HTTP is only permitted for localhost during development.'
  )
}

/**
 * Make an HTTP/HTTPS request
 * @param {string} url - Request URL
 * @param {Object} options - Request options
 * @param {string} [body] - Request body
 * @returns {Promise<{statusCode: number, body: string}>}
 */
function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const protocol = parsedUrl.protocol === 'https:' ? https : http

    const req = protocol.request(url, options, (res) => {
      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data })
      })
    })

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })

    if (body) {
      req.write(body)
    }

    req.end()
  })
}

/**
 * Get a signed upload URL from the BuildPulse API
 * @param {Object} params - Parameters
 * @param {Object} params.auth - Auth configuration from authenticate()
 * @param {string} params.repositoryId - Repository ID (required for legacy auth, optional for api-token)
 * @param {string} [params.apiHost] - Override API host
 * @returns {Promise<Object>} Upload URL response
 */
async function getUploadUrl({ auth, repositoryId, apiHost = DEFAULT_API_HOST }) {
  enforceHttps(apiHost)

  const url = `${apiHost}/api/test-results/upload-url`

  const body = JSON.stringify({
    ...auth.body,
    repositoryId
  })

  const response = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...auth.headers
    },
    timeout: 30000
  }, body)

  if (response.statusCode !== 200) {
    let errorMessage = `API request failed with status ${response.statusCode}`
    try {
      const errorBody = JSON.parse(response.body)
      if (errorBody.error) {
        errorMessage = errorBody.error
      }
    } catch {
      // Ignore JSON parse errors
    }
    throw new HttpError(errorMessage, response.statusCode)
  }

  return JSON.parse(response.body)
}

/**
 * Upload a file to S3 using a signed URL
 * @param {string} signedUrl - Signed S3 PUT URL
 * @param {string} filePath - Path to file to upload
 * @returns {Promise<void>}
 */
async function uploadToS3(signedUrl, filePath) {
  const fileBuffer = fs.readFileSync(filePath)
  const fileSize = fs.statSync(filePath).size

  const parsedUrl = new URL(signedUrl)
  const protocol = parsedUrl.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const req = protocol.request(signedUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': fileSize
      },
      timeout: 120000 // 2 minute timeout for upload
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve()
        } else {
          // Throw HttpError so retryAsync can decide based on the status code:
          // 4xx (auth/expired-URL/etc) fails fast, 5xx retries.
          reject(new HttpError(`S3 upload failed with status ${res.statusCode}: ${data}`, res.statusCode))
        }
      })
    })

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Upload timeout'))
    })

    req.write(fileBuffer)
    req.end()
  })
}

/**
 * Complete upload flow: get signed URL and upload file
 * @param {Object} params - Parameters
 * @param {Object} params.auth - Auth configuration
 * @param {string} params.repositoryId - Repository ID
 * @param {string} params.archivePath - Path to archive file
 * @param {string} [params.apiHost] - Override API host
 * @returns {Promise<Object>} Upload result with uploadId
 */
async function upload({ auth, repositoryId, archivePath, apiHost }) {
  // Wrap the entire flow (getUploadUrl + uploadToS3) in a single retry coordinator.
  // Re-fetching the signed URL on each attempt is intentional:
  //   1. Signed-URL expiration: backoff sleeps can accumulate beyond a stale URL's
  //      lifetime, so we always start each attempt with a freshly minted URL.
  //   2. Each retry produces a new upload-id row server-side, so the API can
  //      dedupe / reconcile on its end if the previous attempt landed in S3 but
  //      the response was lost in flight.
  // Tradeoff (watch list): if S3 *did* persist the bytes from attempt N but the
  // response packet was dropped, attempt N+1 will create a second upload record.
  // The processing pipeline must be tolerant of duplicate uploads for the same
  // commit — the upside is that transient blips no longer fail customer CI.
  // 4xx errors (e.g. invalid credentials, 403 expired URL) short-circuit on the
  // first attempt so we never burn the full backoff budget on a config error.
  return retryAsync(async () => {
    const urlResponse = await getUploadUrl({ auth, repositoryId, apiHost })
    await uploadToS3(urlResponse.uploadUrl, archivePath)
    return {
      uploadId: urlResponse.uploadId,
      accountId: urlResponse.accountId,
      repositoryId: urlResponse.repositoryId
    }
  }, { label: 'BuildPulse upload' })
}

module.exports = {
  getUploadUrl,
  uploadToS3,
  upload,
  // Exposed for unit tests. These are pure helpers that lock down Phase 2
  // fixes (HTTPS enforcement, retry policy, retryable-error predicate) and
  // are not part of the action's public runtime surface.
  enforceHttps,
  retryAsync,
  isRetryableError,
  HttpError
}
