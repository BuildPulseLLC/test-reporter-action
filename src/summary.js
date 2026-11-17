/**
 * GitHub job summary for the BuildPulse upload step.
 *
 * Renders totals and the failed tests from the JUnit files this step already
 * collected, labels each failure with its BuildPulse flaky status when the API
 * answers in time, and links to the repository in BuildPulse.
 *
 * Nothing in here may fail or noticeably slow the job: every entry point
 * catches its own errors, the API lookup has a hard 3 s deadline, and it runs
 * while the upload is in flight.
 */

const core = require('@actions/core')
const { readJUnitFiles, testKey } = require('./junit')
const { lookupFlakyStatus } = require('./flaky')

const DEFAULT_MAX_FAILURES = 20
const MAX_NAME_CHARS = 300
const MAX_MESSAGE_CHARS = 200
const DEFAULT_WEB_HOST = 'https://buildpulse.io'

const LABELS = {
  quarantined: 'Quarantined',
  flaky: 'Known flaky',
  new: 'New failure',
  unknown: 'Failed'
}

/**
 * Whether the `job-summary` input is on. Empty means the default (on).
 * @param {string} value
 * @returns {boolean}
 */
function isSummaryEnabled(value) {
  const v = (value || '').trim().toLowerCase()
  return !['false', 'no', 'off', '0'].includes(v)
}

/**
 * Escape text for a GitHub markdown table cell: HTML-significant characters
 * become entities, markdown punctuation is backslash-escaped, and newlines
 * collapse to spaces so a cell stays on one row.
 * @param {string} s
 * @returns {string}
 */
function escapeMarkdown(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}[\]()#+!|~-])/g, '\\$1')
}

function truncate(s, max) {
  const chars = Array.from(s || '')
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : chars.join('')
}

function formatCount(n) {
  return Number(n).toLocaleString('en-US')
}

/**
 * Human duration: "850ms", "12.3s", "4m 12s", "1h 5m".
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  const s = Number(seconds) || 0
  if (s <= 0) return '0s'
  if (s < 1) return `${Math.round(s * 1000)}ms`
  if (s < 10) return `${(Math.round(s * 10) / 10).toString()}s`
  if (s < 60) return `${Math.round(s)}s`
  const total = Math.round(s)
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`
}

function plural(n, one, many) {
  return `${formatCount(n)} ${n === 1 ? one : many}`
}

/**
 * Label one failure from the flaky lookup.
 * @param {Object} failure
 * @param {Object} flaky - lookupFlakyStatus().flaky
 * @returns {'quarantined'|'flaky'|'new'|'unknown'}
 */
function classifyFailure(failure, flaky) {
  if (!flaky || !flaky.ok) return 'unknown'
  const key = testKey(failure.suite, failure.name)
  if (flaky.quarantined.has(key)) return 'quarantined'
  if (flaky.flaky.has(key)) return 'flaky'
  // A partial list cannot prove a test is not flaky.
  return flaky.complete ? 'new' : 'unknown'
}

/**
 * Build the dashboard links from what the upload and the API returned.
 * @param {Object} params
 * @param {string} [params.webHost]
 * @param {string} [params.organizationId]
 * @param {string} [params.repositoryId] - BuildPulse repository id (not the GitHub id)
 * @returns {{ testRuns?: string, flakyTests?: string, repositories?: string }}
 */
function buildLinks({ webHost, organizationId, repositoryId }) {
  if (!organizationId) return {}
  let origin
  try {
    origin = new URL(webHost || DEFAULT_WEB_HOST).origin
  } catch {
    return {}
  }
  const org = `${origin}/organizations/${encodeURIComponent(organizationId)}`
  if (!repositoryId) return { repositories: `${org}/repositories` }
  const repo = `${org}/repositories/${encodeURIComponent(repositoryId)}`
  return { testRuns: `${repo}/test-runs`, flakyTests: `${repo}/flaky-tests` }
}

/**
 * Render the summary markdown. Pure: no I/O.
 * @param {Object} params
 * @param {Object} params.results - readJUnitFiles() output
 * @param {Object} [params.flaky] - lookupFlakyStatus().flaky, or undefined when not looked up
 * @param {Object} [params.links] - buildLinks() output
 * @param {boolean} [params.uploadFailed]
 * @param {number} [params.maxFailures]
 * @returns {string}
 */
function buildSummary({ results, flaky, links = {}, uploadFailed = false, maxFailures = DEFAULT_MAX_FAILURES }) {
  const lines = []
  const filesNote = plural(results.filesRead, 'JUnit file', 'JUnit files')

  if (results.tests === 0) {
    lines.push('### BuildPulse: no test cases found', '')
    lines.push(`Read ${filesNote} and found no test cases.`)
  } else {
    const failures = results.failures.map((f) => ({ ...f, status: classifyFailure(f, flaky) }))
    const counts = { quarantined: 0, flaky: 0, new: 0, unknown: 0 }
    for (const f of failures) counts[f.status]++

    const parts = []
    if (counts.new) parts.push(`${formatCount(counts.new)} new`)
    if (counts.flaky) parts.push(`${formatCount(counts.flaky)} known flaky`)
    if (counts.quarantined) parts.push(`${formatCount(counts.quarantined)} quarantined`)
    const failedText = `${formatCount(results.failed)} failed` + (parts.length ? ` (${parts.join(', ')})` : '')

    lines.push(
      `### BuildPulse: ${plural(results.tests, 'test', 'tests')}, ${failedText}, ` +
      `${formatCount(results.skipped)} skipped, ${formatDuration(results.durationSec)}`,
      ''
    )
    lines.push(
      `${formatCount(results.passed)} passed. ${formatDuration(results.durationSec)} is the sum of test durations ` +
      `across ${filesNote}.`
    )

    if (failures.length) {
      // Most actionable first: new failures, then unlabeled, then known flaky, then quarantined.
      const order = { new: 0, unknown: 1, flaky: 2, quarantined: 3 }
      const sorted = failures
        .map((f, i) => ({ f, i }))
        .sort((a, b) => order[a.f.status] - order[b.f.status] || a.i - b.i)
        .map(({ f }) => f)
      const shown = sorted.slice(0, maxFailures)

      lines.push('', '| Status | Test | Failure |', '| --- | --- | --- |')
      for (const f of shown) {
        const where = f.classname || f.suite
        const test = where && where !== 'default'
          ? `${escapeMarkdown(truncate(where, MAX_NAME_CHARS))} › ${escapeMarkdown(truncate(f.name, MAX_NAME_CHARS))}`
          : escapeMarkdown(truncate(f.name, MAX_NAME_CHARS))
        const message = f.message ? escapeMarkdown(truncate(f.message, MAX_MESSAGE_CHARS)) : ' '
        lines.push(`| ${LABELS[f.status]} | ${test} | ${message} |`)
      }
      if (sorted.length > shown.length) {
        lines.push('', `And ${plural(sorted.length - shown.length, 'more failed test', 'more failed tests')}.`)
      }

      lines.push('')
      if (flaky && flaky.ok) {
        lines.push(
          `New failure means BuildPulse does not list the test as flaky or quarantined. ` +
          `This repository has ${plural(flaky.flakyCount, 'known flaky test', 'known flaky tests')} and ` +
          `${formatCount(flaky.quarantinedCount)} quarantined in BuildPulse.`
        )
        if (!flaky.complete) {
          lines.push(
            '',
            'Not every flaky and quarantined test could be checked in time, so failures that did not match ' +
            'are marked Failed rather than New failure.'
          )
        }
      } else if (flaky) {
        lines.push(`Flaky status is unavailable: ${flaky.reason}.`)
      }
    }
  }

  if (results.filesSkipped) {
    lines.push(
      '',
      `${plural(results.filesSkipped, 'file was', 'files were')} not counted because ` +
      `${results.filesSkipped === 1 ? 'it' : 'they'} could not be read or exceeded 50 MB.`
    )
  }

  if (uploadFailed) {
    lines.push('', 'The upload to BuildPulse failed, so this run will not appear in BuildPulse.')
  } else if (links.testRuns) {
    lines.push('', `View in BuildPulse: [test runs](${links.testRuns}), [flaky tests](${links.flakyTests})`)
  } else if (links.repositories) {
    lines.push('', `View in BuildPulse: [repositories](${links.repositories})`)
  }

  return lines.join('\n') + '\n'
}

/**
 * Read the local results and start the BuildPulse lookup. Call before the
 * upload so the lookup overlaps it. Never throws.
 * @param {Object} params
 * @param {boolean} params.enabled - The job-summary input
 * @param {string[]} params.files - Matched result files
 * @param {string} [params.apiToken]
 * @param {string} [params.repository] - "owner/name"
 * @param {string} [params.apiHost]
 * @param {Object} [params.lookupOptions] - Passed through to lookupFlakyStatus (tests)
 * @returns {Object|null} State for finishSummary, or null when disabled
 */
function startSummary({ enabled, files, apiToken, repository, apiHost, lookupOptions = {} }) {
  if (!enabled) return null
  try {
    const results = readJUnitFiles(files)
    const lookup = lookupFlakyStatus({
      apiToken,
      repository,
      apiHost,
      includeFlaky: results.failed > 0,
      ...lookupOptions
    }).catch((err) => ({ flaky: { ok: false, reason: err.message }, repositoryId: null }))
    return { results, lookup, apiToken, apiHost }
  } catch (err) {
    core.info(`BuildPulse job summary skipped: ${err.message}`)
    return null
  }
}

/**
 * Wait for the lookup, render, and append to $GITHUB_STEP_SUMMARY. Never throws.
 * @param {Object|null} state - From startSummary
 * @param {Object} params
 * @param {Object} [params.uploadResult] - upload() result, when the upload succeeded
 * @param {boolean} [params.uploadFailed]
 * @returns {Promise<string|null>} The markdown written, or null
 */
async function finishSummary(state, { uploadResult, uploadFailed = false } = {}) {
  if (!state) return null
  try {
    if (!process.env.GITHUB_STEP_SUMMARY) {
      core.debug('GITHUB_STEP_SUMMARY is not set; skipping the BuildPulse job summary')
      return null
    }
    const { flaky, repositoryId } = await state.lookup
    const links = buildLinks({
      webHost: state.apiHost,
      organizationId: uploadResult && uploadResult.organizationId,
      repositoryId
    })
    const markdown = buildSummary({
      results: state.results,
      // Flaky status only matters when something failed.
      flaky: state.results.failed > 0 ? flaky : undefined,
      links,
      uploadFailed
    })
    await core.summary.addRaw(markdown).write()
    return markdown
  } catch (err) {
    core.info(`BuildPulse job summary skipped: ${err.message}`)
    return null
  }
}

module.exports = {
  buildSummary,
  buildLinks,
  classifyFailure,
  escapeMarkdown,
  formatDuration,
  isSummaryEnabled,
  startSummary,
  finishSummary,
  LABELS
}
