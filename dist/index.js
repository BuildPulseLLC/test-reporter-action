require('./sourcemap-register.js');/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 767:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/**
 * Archive creation module
 * Creates .tar.gz archives with test result files and metadata
 */

const fs = __nccwpck_require__(896)
const path = __nccwpck_require__(928)
const archiver = __nccwpck_require__(983)
const yaml = __nccwpck_require__(690)

/**
 * Create a buildpulse.yml metadata file content
 * @param {Object} metadata - Git and CI metadata
 * @param {Object} options - Additional options
 * @param {string[]} [options.tags] - Tags to apply
 * @param {string[]} [options.coverageFiles] - Coverage file paths
 * @param {string} [options.quotaId] - Quota ID
 * @returns {string} YAML content
 */
function createMetadataYaml(metadata, options = {}) {
  const content = {
    version: '1.0',
    source: 'buildpulse-action',
    timestamp: metadata.timestamp,
    git: {
      commit: metadata.commit,
      message: metadata.commitMessage,
      branch: metadata.branch,
      tree: metadata.treeSha,
      repository: {
        owner: metadata.owner,
        name: metadata.repo
      }
    },
    ci: {
      provider: metadata.ciProvider,
      build_id: metadata.buildId,
      build_number: metadata.buildNumber,
      build_url: metadata.buildUrl,
      triggered_by: metadata.triggeredBy,
      workflow: metadata.workflow,
      job: metadata.job
    }
  }

  if (metadata.prNumber) {
    content.git.pull_request = {
      number: parseInt(metadata.prNumber, 10)
    }
  }

  if (options.tags && options.tags.length > 0) {
    content.tags = options.tags
  }

  if (options.coverageFiles && options.coverageFiles.length > 0) {
    content.coverage_files = options.coverageFiles
  }

  if (options.quotaId) {
    content.quota_id = options.quotaId
  }

  if (options.runner) {
    content.runner = options.runner
  }

  if (options.execution) {
    content.execution = options.execution
  }

  return yaml.stringify(content)
}

/**
 * Create a .tar.gz archive with test result files and metadata
 * @param {Object} params - Parameters
 * @param {string[]} params.files - Array of file paths to include
 * @param {Object} params.metadata - Git and CI metadata
 * @param {string} params.outputPath - Path for output archive
 * @param {Object} [params.options] - Additional options (tags, coverageFiles, quotaId)
 * @returns {Promise<string>} Path to created archive
 */
async function createArchive({ files, metadata, outputPath, options = {} }) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath)
    const archive = archiver('tar', {
      gzip: true,
      gzipOptions: { level: 9 }
    })

    output.on('close', () => resolve(outputPath))
    archive.on('error', (err) => reject(err))
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') {
        console.warn('Archive warning:', err)
      }
    })

    archive.pipe(output)

    // Add buildpulse.yml metadata file
    const metadataYaml = createMetadataYaml(metadata, options)
    archive.append(metadataYaml, { name: 'buildpulse.yml' })

    // Add test result files
    for (const file of files) {
      const filename = path.basename(file)
      archive.file(file, { name: `test-results/${filename}` })
    }

    // Add coverage files if provided
    if (options.coverageFiles) {
      for (const file of options.coverageFiles) {
        if (fs.existsSync(file)) {
          const filename = path.basename(file)
          archive.file(file, { name: `coverage/${filename}` })
        }
      }
    }

    archive.finalize()
  })
}

module.exports = {
  createArchive,
  createMetadataYaml
}


/***/ }),

/***/ 103:
/***/ ((module) => {

/**
 * Authentication module for BuildPulse action
 * Supports both new API tokens (bp_xxx...) and legacy AWS credentials
 */

/**
 * Determine auth method and return headers/body for API calls
 * @param {Object} inputs - Action inputs
 * @param {string} [inputs.apiToken] - New-style API token
 * @param {string} [inputs.account] - Legacy account ID
 * @param {string} [inputs.repository] - Legacy repository ID
 * @param {string} [inputs.key] - Legacy access key
 * @param {string} [inputs.secret] - Legacy secret key
 * @returns {Object} Auth configuration with headers and body
 */
function authenticate(inputs) {
  const { apiToken, account, repository, key, secret } = inputs

  if (apiToken) {
    // New flow: API token (org-level)
    return {
      headers: { Authorization: `Bearer ${apiToken}` },
      body: {}
    }
  }

  if (key && secret && account && repository) {
    // Legacy flow: AWS IAM credentials
    return {
      headers: {
        'X-BuildPulse-Access-Key': key,
        'X-BuildPulse-Secret-Key': secret
      },
      body: { accountId: account, repositoryId: repository }
    }
  }

  throw new Error(
    'Authentication required: provide api-token OR (account + repository + key + secret)'
  )
}

/**
 * Validate that required auth inputs are provided
 * @param {Object} inputs - Action inputs
 * @returns {boolean} True if valid
 */
function validateAuthInputs(inputs) {
  const { apiToken, account, repository, key, secret } = inputs

  // New auth method
  if (apiToken) {
    return true
  }

  // Legacy auth method - all four are required
  if (key && secret && account && repository) {
    return true
  }

  return false
}

module.exports = {
  authenticate,
  validateAuthInputs
}


/***/ }),

/***/ 460:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/**
 * Git metadata collection module
 * Gathers information from GitHub Actions environment variables and git commands
 */

const { execSync } = __nccwpck_require__(317)

/**
 * Execute a git command and return trimmed output
 * @param {string} command - Git command to execute
 * @param {string} cwd - Working directory
 * @returns {string|null} Command output or null if failed
 */
function gitCommand(command, cwd) {
  try {
    return execSync(command, { cwd, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/**
 * Get the tree SHA for a commit
 * @param {string} commitSha - Commit SHA
 * @param {string} cwd - Working directory
 * @returns {string|null} Tree SHA
 */
function getTreeSha(commitSha, cwd) {
  return gitCommand(`git rev-parse ${commitSha}^{tree}`, cwd)
}

/**
 * Get the branch name from git
 * @param {string} cwd - Working directory
 * @returns {string|null} Branch name
 */
function getBranchFromGit(cwd) {
  // Try symbolic-ref first (works on non-detached HEAD)
  const symbolicRef = gitCommand('git symbolic-ref --short HEAD', cwd)
  if (symbolicRef) return symbolicRef

  // Fall back to describe
  return gitCommand('git describe --all --exact-match HEAD', cwd)
}

/**
 * Get the commit message for a commit
 * @param {string} commitSha - Commit SHA
 * @param {string} cwd - Working directory
 * @returns {string|null} Commit message (first line only)
 */
function getCommitMessage(commitSha, cwd) {
  // Get first line of commit message (subject)
  return gitCommand(`git log -1 --format=%s ${commitSha}`, cwd)
}

/**
 * Detect the CI provider from environment variables
 * @returns {string} CI provider name
 */
function detectCIProvider() {
  const env = process.env
  if (env.GITHUB_ACTIONS) return 'github-actions'
  if (env.BITBUCKET_BUILD_NUMBER) return 'bitbucket-pipelines'
  if (env.CIRCLECI) return 'circleci'
  if (env.TRAVIS) return 'travis-ci'
  if (env.GITLAB_CI) return 'gitlab-ci'
  if (env.JENKINS_URL) return 'jenkins'
  return 'unknown'
}

/**
 * Collect metadata from Bitbucket Pipelines environment
 * @param {Object} env - Environment variables
 * @param {string} repositoryPath - Path to git repository
 * @returns {Object} Git metadata
 */
function collectBitbucketMetadata(env, repositoryPath) {
  const commitSha = env.BITBUCKET_COMMIT
  const branch = env.BITBUCKET_BRANCH || getBranchFromGit(repositoryPath)
  const treeSha = getTreeSha(commitSha, repositoryPath)
  const commitMessage = getCommitMessage(commitSha, repositoryPath)
  const [owner, repo] = (env.BITBUCKET_REPO_FULL_NAME || '').split('/')

  return {
    commit: commitSha,
    commitMessage,
    branch,
    treeSha,
    owner,
    repo,
    prNumber: env.BITBUCKET_PR_ID || null,
    ciProvider: 'bitbucket-pipelines',
    buildId: env.BITBUCKET_PIPELINE_UUID,
    buildNumber: env.BITBUCKET_BUILD_NUMBER,
    buildUrl: env.BITBUCKET_PIPELINE_UUID
      ? `https://bitbucket.org/${env.BITBUCKET_REPO_FULL_NAME}/pipelines/results/${env.BITBUCKET_BUILD_NUMBER}`
      : null,
    triggeredBy: env.BITBUCKET_STEP_TRIGGERER_UUID || null,
    workflow: null,
    job: env.BITBUCKET_STEP_UUID || null,
    repositoryId: env.BITBUCKET_REPO_UUID,
    repoNameWithOwner: env.BITBUCKET_REPO_FULL_NAME,
    timestamp: new Date().toISOString()
  }
}

/**
 * Collect metadata from GitHub Actions environment
 * @param {Object} env - Environment variables
 * @param {string} repositoryPath - Path to git repository
 * @param {string} [overrideCommitSha] - Override commit SHA
 * @returns {Object} Git metadata
 */
function collectGitHubMetadata(env, repositoryPath, overrideCommitSha) {
  const commitSha = overrideCommitSha || env.GITHUB_SHA

  let branch = env.GITHUB_HEAD_REF
  if (!branch) {
    branch = env.GITHUB_REF_NAME
  }
  if (!branch && env.GITHUB_REF) {
    const match = env.GITHUB_REF.match(/^refs\/heads\/(.+)$/)
    if (match) branch = match[1]
  }
  if (!branch) {
    branch = getBranchFromGit(repositoryPath)
  }

  const treeSha = getTreeSha(commitSha, repositoryPath)
  const commitMessage = getCommitMessage(commitSha, repositoryPath)
  const [owner, repo] = (env.GITHUB_REPOSITORY || '').split('/')
  const prNumber = env.GITHUB_EVENT_NAME === 'pull_request' ? env.GITHUB_REF?.match(/refs\/pull\/(\d+)/)?.[1] : null

  return {
    commit: commitSha,
    commitMessage,
    branch,
    treeSha,
    owner,
    repo,
    prNumber,
    ciProvider: 'github-actions',
    buildId: env.GITHUB_RUN_ID,
    buildNumber: env.GITHUB_RUN_NUMBER,
    buildUrl: `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    triggeredBy: env.GITHUB_ACTOR,
    workflow: env.GITHUB_WORKFLOW,
    job: env.GITHUB_JOB,
    timestamp: new Date().toISOString()
  }
}

/**
 * Collect git metadata from environment and git commands
 * Supports GitHub Actions and Bitbucket Pipelines
 * @param {Object} options - Options
 * @param {string} options.repositoryPath - Path to git repository
 * @param {string} [options.commitSha] - Override commit SHA
 * @returns {Object} Git metadata
 */
function collectMetadata({ repositoryPath, commitSha: overrideCommitSha }) {
  const env = process.env
  const ciProvider = detectCIProvider()

  if (ciProvider === 'bitbucket-pipelines') {
    return collectBitbucketMetadata(env, repositoryPath)
  }

  return collectGitHubMetadata(env, repositoryPath, overrideCommitSha)
}

module.exports = {
  collectMetadata,
  detectCIProvider,
  getTreeSha,
  getBranchFromGit,
  getCommitMessage
}


/***/ }),

/***/ 865:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/**
 * System resource sampler module
 * Collects CPU and memory metrics at regular intervals during test execution
 */

const os = __nccwpck_require__(857)

/**
 * Calculate CPU usage percentage from os.cpus() snapshots
 * @param {Object[]} startCpus - CPU info at start
 * @param {Object[]} endCpus - CPU info at end
 * @returns {number} CPU usage ratio (0-1)
 */
function calculateCpuUsage(startCpus, endCpus) {
  let totalIdle = 0
  let totalTick = 0

  for (let i = 0; i < endCpus.length; i++) {
    const startTimes = startCpus[i].times
    const endTimes = endCpus[i].times

    const idleDiff = endTimes.idle - startTimes.idle
    const totalDiff =
      (endTimes.user - startTimes.user) +
      (endTimes.nice - startTimes.nice) +
      (endTimes.sys - startTimes.sys) +
      (endTimes.irq - startTimes.irq) +
      idleDiff

    totalIdle += idleDiff
    totalTick += totalDiff
  }

  return totalTick > 0 ? 1 - totalIdle / totalTick : 0
}

/**
 * Get static runner information
 * @returns {Object} Runner specs
 */
function getRunnerInfo() {
  const cpus = os.cpus()
  return {
    cpus: cpus.length,
    cpu_model: cpus[0]?.model || 'unknown',
    total_memory_mb: Math.round(os.totalmem() / (1024 * 1024)),
    os: os.platform(),
    arch: os.arch(),
    os_version: os.release()
  }
}

/**
 * Create a resource sampler that collects metrics at a fixed interval
 * @param {number} intervalMs - Sampling interval in milliseconds
 * @returns {Object} Sampler with start() and stop() methods
 */
function createSampler(intervalMs = 1000) {
  let timer = null
  let prevCpus = null
  const samples = {
    cpu_load: [],
    memory_used_mb: [],
    memory_free_mb: []
  }

  function takeSample() {
    const currentCpus = os.cpus()

    if (prevCpus) {
      const cpuUsage = calculateCpuUsage(prevCpus, currentCpus)
      samples.cpu_load.push(cpuUsage)
    }

    prevCpus = currentCpus

    const freeMem = os.freemem()
    const totalMem = os.totalmem()
    const usedMb = Math.round((totalMem - freeMem) / (1024 * 1024))
    const freeMb = Math.round(freeMem / (1024 * 1024))

    samples.memory_used_mb.push(usedMb)
    samples.memory_free_mb.push(freeMb)
  }

  return {
    start() {
      prevCpus = os.cpus()
      timer = setInterval(takeSample, intervalMs)
      // Take first memory sample immediately
      const freeMem = os.freemem()
      const totalMem = os.totalmem()
      samples.memory_used_mb.push(Math.round((totalMem - freeMem) / (1024 * 1024)))
      samples.memory_free_mb.push(Math.round(freeMem / (1024 * 1024)))
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      // Take final sample
      takeSample()
    },

    getResults() {
      const avg = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
      const max = (arr) => arr.length > 0 ? Math.max(...arr) : 0
      const min = (arr) => arr.length > 0 ? Math.min(...arr) : 0

      return {
        samples: samples.cpu_load.length,
        interval_ms: intervalMs,
        cpu_load_avg: Math.round(avg(samples.cpu_load) * 1000) / 1000,
        cpu_load_peak: Math.round(max(samples.cpu_load) * 1000) / 1000,
        memory_used_avg_mb: Math.round(avg(samples.memory_used_mb)),
        memory_used_peak_mb: max(samples.memory_used_mb),
        memory_free_min_mb: min(samples.memory_free_mb)
      }
    }
  }
}

module.exports = {
  createSampler,
  getRunnerInfo
}


/***/ }),

/***/ 556:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/**
 * Upload module
 * Handles API calls to get signed URLs and S3 uploads
 */

const core = __nccwpck_require__(580)
const fs = __nccwpck_require__(896)
const https = __nccwpck_require__(692)
const http = __nccwpck_require__(611)
const { URL } = __nccwpck_require__(16)

const DEFAULT_API_HOST = 'https://buildpulse.io'

// Explicit User-Agent required: Node 24 no longer sends a default User-Agent
// header, and CloudFront WAF blocks requests without one (HTTP 403).
const USER_AGENT = 'BuildPulse-TestReporter/3.0'

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

  // URL.hostname wraps IPv6 in brackets ("[::1]"); HTTP_ALLOWED_HOSTS stores "::1".
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')

  if (parsed.protocol === 'http:' && HTTP_ALLOWED_HOSTS.has(hostname)) return

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
      'User-Agent': USER_AGENT,
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
 * Upload a file to S3 using a signed URL.
 *
 * Streams the file from disk to the request rather than buffering it into
 * memory. fs.statSync supplies the Content-Length up front (S3 PUT requires
 * it for signed URLs), then fs.createReadStream is piped into the PUT body.
 * For multi-hundred-MB test bundles this keeps peak heap usage flat instead
 * of mirroring the archive size.
 *
 * Each retryAsync attempt re-enters this function (see upload() below), so
 * a stream that errored mid-pipe on attempt N is discarded and attempt N+1
 * starts fresh from a new read stream + new request.
 *
 * @param {string} signedUrl - Signed S3 PUT URL
 * @param {string} filePath - Path to file to upload
 * @returns {Promise<void>}
 */
async function uploadToS3(signedUrl, filePath) {
  const fileSize = fs.statSync(filePath).size

  const parsedUrl = new URL(signedUrl)
  const protocol = parsedUrl.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(filePath)

    const req = protocol.request(signedUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': fileSize,
        'User-Agent': USER_AGENT
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

    req.on('error', (err) => {
      fileStream.destroy()
      reject(err)
    })
    req.on('timeout', () => {
      fileStream.destroy()
      req.destroy()
      reject(new Error('Upload timeout'))
    })

    fileStream.on('error', (err) => {
      // Disk-side read failure (missing file, permission, mid-read I/O error).
      // Tear down the in-flight request so the socket doesn't stay open with a
      // partial body — S3 would either time out or 400 us back anyway.
      req.destroy()
      reject(err)
    })

    fileStream.pipe(req)
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


/***/ }),

/***/ 580:
/***/ ((module) => {

module.exports = eval("require")("@actions/core");


/***/ }),

/***/ 755:
/***/ ((module) => {

module.exports = eval("require")("@actions/glob");


/***/ }),

/***/ 983:
/***/ ((module) => {

module.exports = eval("require")("archiver");


/***/ }),

/***/ 690:
/***/ ((module) => {

module.exports = eval("require")("yaml");


/***/ }),

/***/ 317:
/***/ ((module) => {

"use strict";
module.exports = require("child_process");

/***/ }),

/***/ 896:
/***/ ((module) => {

"use strict";
module.exports = require("fs");

/***/ }),

/***/ 611:
/***/ ((module) => {

"use strict";
module.exports = require("http");

/***/ }),

/***/ 692:
/***/ ((module) => {

"use strict";
module.exports = require("https");

/***/ }),

/***/ 857:
/***/ ((module) => {

"use strict";
module.exports = require("os");

/***/ }),

/***/ 928:
/***/ ((module) => {

"use strict";
module.exports = require("path");

/***/ }),

/***/ 16:
/***/ ((module) => {

"use strict";
module.exports = require("url");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
/**
 * BuildPulse GitHub Action
 * Uploads test results to BuildPulse for flaky test detection
 */

const core = __nccwpck_require__(580)
const glob = __nccwpck_require__(755)
const path = __nccwpck_require__(928)
const fs = __nccwpck_require__(896)
const os = __nccwpck_require__(857)

const { spawn } = __nccwpck_require__(317)

const { authenticate, validateAuthInputs } = __nccwpck_require__(103)
const { collectMetadata } = __nccwpck_require__(460)
const { createArchive } = __nccwpck_require__(767)
const { upload } = __nccwpck_require__(556)
const { createSampler, getRunnerInfo } = __nccwpck_require__(865)

/**
 * Parse space-separated input into array
 * @param {string} input - Space-separated string
 * @returns {string[]} Array of values
 */
function parseSpaceSeparated(input) {
  if (!input || !input.trim()) return []
  return input.trim().split(/\s+/).filter(Boolean)
}

/**
 * Get all matching files from glob pattern
 * @param {string} pattern - Glob pattern
 * @returns {Promise<string[]>} Array of file paths
 */
async function getFiles(pattern) {
  const globber = await glob.create(pattern, {
    followSymbolicLinks: true
  })
  return globber.glob()
}

/**
 * Run a command as a child process and return the exit code
 * Streams stdout/stderr through so users see their test output
 * @param {string} command - Shell command to execute
 * @returns {Promise<number>} Exit code
 */
function runCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit'
    })

    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

/**
 * Main action entry point
 */
async function run() {
  try {
    // Read credential inputs FIRST and register them with the runner so any
    // subsequent log/error path replaces them with `***`. GitHub Actions only
    // auto-masks values registered as repo secrets; if a customer passes a
    // credential through a non-secret input or env var, an unintended log
    // would otherwise leak it in plaintext. We must call core.setSecret()
    // BEFORE any other input read can throw (e.g. the required `path` input)
    // so even an early-fail error message can't include credential values.
    const apiToken = core.getInput('api-token')
    const key = core.getInput('key')
    const secret = core.getInput('secret')
    if (apiToken) core.setSecret(apiToken)
    if (key) core.setSecret(key)
    if (secret) core.setSecret(secret)

    // Get inputs
    const inputs = {
      apiToken,
      account: core.getInput('account'),
      repository: core.getInput('repository'),
      key,
      secret,
      path: core.getInput('path', { required: true }),
      repositoryPath: core.getInput('repository-path') || '.',
      commit: core.getInput('commit'),
      coverageFiles: core.getInput('coverage-files'),
      tags: core.getInput('tags'),
      quotaId: core.getInput('quota'),
      apiHost: core.getInput('api-host') || process.env.BUILDPULSE_API_HOST,
      command: core.getInput('command')
    }

    // Special handling for Dependabot - skip if no credentials available
    if (!inputs.apiToken && !inputs.key && !inputs.secret && process.env.GITHUB_ACTOR === 'dependabot[bot]') {
      core.warning('No credentials available for Dependabot. Skipping upload to BuildPulse.')
      core.warning('As of March 1, 2021, Dependabot PRs cannot access secrets in GitHub Actions.')
      return
    }

    // Validate auth inputs
    if (!validateAuthInputs(inputs)) {
      throw new Error(
        'Authentication required: provide api-token OR (account + repository + key + secret)'
      )
    }

    // Collect runner info (always included)
    const runner = getRunnerInfo()
    core.info(`Runner: ${runner.cpus} CPUs, ${runner.total_memory_mb} MB RAM, ${runner.os}/${runner.arch}`)

    // Run command in wrap mode if provided
    let execution = null
    if (inputs.command) {
      core.info(`Running command: ${inputs.command}`)
      const sampler = createSampler(1000)
      const startTime = Date.now()

      sampler.start()
      const exitCode = await runCommand(inputs.command)
      sampler.stop()

      const durationMs = Date.now() - startTime
      const metrics = sampler.getResults()

      execution = {
        command: inputs.command,
        exit_code: exitCode,
        duration_ms: durationMs,
        metrics
      }

      core.info(`Command finished in ${(durationMs / 1000).toFixed(1)}s (exit code ${exitCode})`)
      core.info(`Peak CPU: ${(metrics.cpu_load_peak * 100).toFixed(0)}%, Peak memory: ${metrics.memory_used_peak_mb} MB, Free min: ${metrics.memory_free_min_mb} MB`)

      // Set exit code output so workflows can react
      core.setOutput('command-exit-code', exitCode)
    }

    // Validate path input
    const testFiles = await getFiles(inputs.path)
    if (testFiles.length === 0) {
      throw new Error(`No test result files found matching: ${inputs.path}`)
    }

    core.info(`Found ${testFiles.length} test result file(s)`)
    for (const file of testFiles) {
      core.debug(`  - ${file}`)
    }

    // Validate repository path
    if (!fs.existsSync(inputs.repositoryPath)) {
      throw new Error(`Repository path does not exist: ${inputs.repositoryPath}`)
    }

    // Get auth configuration
    const auth = authenticate(inputs)

    // Collect git metadata
    const metadata = collectMetadata({
      repositoryPath: inputs.repositoryPath,
      commitSha: inputs.commit || process.env.GITHUB_SHA
    })

    core.info(`Commit: ${metadata.commit}`)
    core.info(`Branch: ${metadata.branch || 'unknown'}`)
    core.info(`Build: ${metadata.buildNumber}`)

    // Parse optional inputs
    const tags = parseSpaceSeparated(inputs.tags)
    const coverageFiles = parseSpaceSeparated(inputs.coverageFiles)

    // Log coverage file status
    if (coverageFiles.length > 0) {
      for (const file of coverageFiles) {
        if (fs.existsSync(file)) {
          const size = fs.statSync(file).size
          core.info(`Coverage file found: ${file} (${(size / 1024).toFixed(1)} KB)`)
        } else {
          core.warning(`Coverage file not found: ${file} (cwd: ${process.cwd()})`)
        }
      }
    }

    // Create archive
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildpulse-'))
    const archivePath = path.join(tempDir, 'test-results.tar.gz')

    core.info('Creating archive...')
    await createArchive({
      files: testFiles,
      metadata,
      outputPath: archivePath,
      options: {
        tags,
        coverageFiles,
        quotaId: inputs.quotaId,
        runner,
        execution
      }
    })

    const archiveSize = fs.statSync(archivePath).size
    core.info(`Archive created: ${(archiveSize / 1024).toFixed(1)} KB`)

    // Determine repository ID
    // For legacy auth, repositoryId comes from inputs
    // For new auth, use GITHUB_REPOSITORY_ID (available natively in GitHub Actions)
    const repositoryId = inputs.repository || process.env.GITHUB_REPOSITORY_ID

    if (!repositoryId) {
      throw new Error('Repository ID is required. Provide it via the repository input or set GITHUB_REPOSITORY_ID.')
    }

    // Upload to BuildPulse
    core.info('Uploading to BuildPulse...')
    const result = await upload({
      auth,
      repositoryId,
      archivePath,
      apiHost: inputs.apiHost
    })

    core.info(`Upload complete! Upload ID: ${result.uploadId}`)

    // The upload succeeded at S3, but ingestion into the BuildPulse
    // dashboard depends on the BuildPulse GitHub App being installed on
    // this repository — without it the processing Lambda silently drops
    // the upload. Surface that as a notice so customers who follow the
    // setup page literally and end up with an empty dashboard have an
    // in-CI breadcrumb instead of having to dig through CloudWatch.
    core.notice(
      `BuildPulse received this upload. Test results normally appear in the dashboard within a few minutes. ` +
      `If you don't see data after ~10 minutes, the most common cause is that the BuildPulse GitHub App ` +
      `is not installed on this repository — without it uploads are silently dropped during ingestion. ` +
      `Install/grant access at https://github.com/apps/buildpulse and re-run the workflow.`,
      { title: 'BuildPulse upload accepted' }
    )

    // Set outputs
    core.setOutput('upload-id', result.uploadId)
    core.setOutput('account-id', result.accountId)
    core.setOutput('repository-id', result.repositoryId)

    // Cleanup
    try {
      fs.rmSync(tempDir, { recursive: true })
    } catch {
      // Ignore cleanup errors
    }

    // If wrap mode was used and the command failed, fail the action step
    if (execution && execution.exit_code !== 0) {
      core.setFailed(`Command exited with code ${execution.exit_code}`)
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()

module.exports = __webpack_exports__;
/******/ })()
;
//# sourceMappingURL=index.js.map