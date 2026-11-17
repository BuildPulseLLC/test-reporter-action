/**
 * Local JUnit XML reader for the job summary.
 *
 * This is NOT the parser BuildPulse uses for ingestion (that runs server
 * side). It only needs enough of each file to count results and list the
 * failures, so it is a small tag scanner instead of a full XML parser, which
 * keeps the action free of an XML dependency. It is tolerant by design: a file
 * it cannot read is counted as unreadable and the rest of the summary still
 * renders.
 *
 * Test identity (suite + name) is normalized with the same rules BuildPulse
 * applies at ingestion, so a failure read here can be matched against the
 * flaky and quarantined tests the BuildPulse API returns.
 */

const fs = require('fs')
const path = require('path')

// Files larger than this are left out of the summary (they are still
// uploaded). Reading them whole would cost memory for a cosmetic feature.
const MAX_FILE_BYTES = 50 * 1024 * 1024

// One token per match: a CDATA section, a comment, or one of the tags we care
// about. CDATA and comments are matched so their contents (failure output
// often contains XML) are skipped instead of being read as tags. Attribute
// values may legally contain ">", hence the quoted-string alternatives.
const TOKEN_RE = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<(\/?)(testsuites|testsuite|testcase|failure|error|skipped)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g
const ATTR_RE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const ANSI_RE = /\u001b\[[^A-Za-z]*[A-Za-z]?/g

/**
 * Decode the five predefined XML entities plus numeric character references.
 * @param {string} s
 * @returns {string}
 */
function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s || ''
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, ent) => {
    switch (ent) {
      case 'lt': return '<'
      case 'gt': return '>'
      case 'amp': return '&'
      case 'quot': return '"'
      case 'apos': return "'"
    }
    const code = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10)
    try {
      return String.fromCodePoint(code)
    } catch {
      return m
    }
  })
}

/**
 * @param {string} raw - The attribute section of a tag
 * @returns {Object<string, string>}
 */
function parseAttrs(raw) {
  const attrs = {}
  if (!raw) return attrs
  ATTR_RE.lastIndex = 0
  let m
  while ((m = ATTR_RE.exec(raw)) !== null) {
    attrs[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3])
  }
  return attrs
}

/**
 * Text content of an element body: CDATA unwrapped, everything else decoded.
 * @param {string} body
 * @returns {string}
 */
function elementText(body) {
  let out = ''
  let last = 0
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g
  let m
  while ((m = re.exec(body)) !== null) {
    out += decodeEntities(body.slice(last, m.index)) + m[1]
    last = re.lastIndex
  }
  return out + decodeEntities(body.slice(last))
}

// Suite and name normalization, kept in step with BuildPulse ingestion so
// local failures match the identities the API reports:
//   - an empty suite name is stored as "default"
//   - parallel RSpec shard suites ("rspec1", "rspec2", ...) collapse to "rspec"
//   - ember-exam's per-run "Exam Partition N #R - Browser Id B - " prefix is dropped
//   - Mocha hook failures ('"before each" hook for "x"') are attributed to "x"
const RSPEC_SHARD_RE = /^rspec\d+$/
const EMBER_EXAM_PREFIX_RE = /^Exam Partition \d+(?: #\d+)?(?: - Browser Id \d+)? - /

function normalizeSuiteName(name) {
  if (!name) return 'default'
  if (RSPEC_SHARD_RE.test(name)) return 'rspec'
  return name
}

function normalizeTestName(name) {
  let n = (name || '').replace(EMBER_EXAM_PREFIX_RE, '')
  if (n.includes('"before each"') || n.includes('"before all"')) {
    const marker = '" hook for "'
    const idx = n.indexOf(marker)
    if (idx !== -1) {
      const rest = n.slice(idx + marker.length)
      const end = rest.lastIndexOf('"')
      if (end !== -1) n = rest.slice(0, end)
    }
  }
  return n
}

/**
 * First non-blank line of the failure message attribute, falling back to the
 * element body (jest-junit puts the whole failure in the body).
 * @param {string} message
 * @param {string} body
 * @returns {string}
 */
function firstLine(message, body) {
  for (const source of [message, body]) {
    if (!source) continue
    for (const line of source.split('\n')) {
      const t = line.trim()
      if (t) return t
    }
  }
  return ''
}

function toSeconds(value) {
  if (!value) return 0
  const n = parseFloat(String(value).replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Parse one JUnit XML document.
 * @param {string} xml
 * @returns {{ tests: number, failed: number, skipped: number, durationSec: number, failures: Array }}
 */
function parseJUnitXml(xml) {
  const text = xml.indexOf('\u001b') === -1 ? xml : xml.replace(ANSI_RE, '')
  const result = { tests: 0, failed: 0, skipped: 0, durationSec: 0, failures: [] }
  const suites = []
  let current = null
  let pending = null // an open <failure>/<error> whose body we still need

  const finish = () => {
    if (!current) return
    result.tests++
    result.durationSec += current.time
    if (current.status === 'failed') {
      result.failed++
      result.failures.push({
        suite: current.suite,
        classname: current.classname,
        name: current.name,
        file: current.file,
        message: current.message
      })
    } else if (current.status === 'skipped') {
      result.skipped++
    }
    current = null
  }

  TOKEN_RE.lastIndex = 0
  let m
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const tag = m[2]
    if (!tag) continue // CDATA or comment
    const closing = m[1] === '/'
    const selfClosing = m[4] === '/'

    if (closing) {
      if (tag === 'testsuite') {
        suites.pop()
      } else if (tag === 'testcase') {
        finish()
      } else if ((tag === 'failure' || tag === 'error') && pending && current) {
        if (!current.message) {
          current.message = firstLine('', elementText(text.slice(pending.bodyStart, m.index)))
        }
        pending = null
      }
      continue
    }

    const attrs = parseAttrs(m[3])
    if (tag === 'testsuite') {
      if (!selfClosing) suites.push(attrs.name || '')
    } else if (tag === 'testcase') {
      finish() // tolerate a missing </testcase>
      current = {
        suite: normalizeSuiteName(suites.length ? suites[suites.length - 1] : ''),
        classname: attrs.classname || '',
        name: normalizeTestName(attrs.name || ''),
        file: attrs.file || '',
        time: toSeconds(attrs.time),
        status: 'passed',
        message: ''
      }
      if (selfClosing) finish()
    } else if (current && (tag === 'failure' || tag === 'error')) {
      if (current.status !== 'failed') {
        current.status = 'failed'
        current.message = firstLine(attrs.message, '')
        pending = selfClosing ? null : { bodyStart: TOKEN_RE.lastIndex }
      }
    } else if (current && tag === 'skipped') {
      if (current.status === 'passed') current.status = 'skipped'
    }
  }
  finish()
  return result
}

/**
 * Whether BuildPulse ingestion treats this path as a JUnit file: an .xml file
 * whose name does not contain "coverage" (those are read as coverage reports).
 * @param {string} filePath
 * @returns {boolean}
 */
function isJUnitPath(filePath) {
  const base = path.basename(filePath).toLowerCase()
  return base.endsWith('.xml') && !base.includes('coverage')
}

/**
 * Read and total every JUnit file in the list. Never throws.
 * @param {string[]} files - Paths as matched by the action's `path` input
 * @returns {{ tests: number, passed: number, failed: number, skipped: number,
 *   durationSec: number, failures: Array, filesRead: number, filesSkipped: number }}
 */
function readJUnitFiles(files) {
  const totals = {
    tests: 0, passed: 0, failed: 0, skipped: 0, durationSec: 0,
    failures: [], filesRead: 0, filesSkipped: 0
  }
  for (const file of files || []) {
    if (!isJUnitPath(file)) continue
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      if (stat.size > MAX_FILE_BYTES) {
        totals.filesSkipped++
        continue
      }
      const r = parseJUnitXml(fs.readFileSync(file, 'utf8'))
      totals.tests += r.tests
      totals.failed += r.failed
      totals.skipped += r.skipped
      totals.durationSec += r.durationSec
      totals.failures.push(...r.failures)
      totals.filesRead++
    } catch {
      totals.filesSkipped++
    }
  }
  totals.passed = totals.tests - totals.failed - totals.skipped
  return totals
}

/**
 * Key used to match a local failure against a test from the BuildPulse API.
 * @param {string} suite
 * @param {string} name
 * @returns {string}
 */
function testKey(suite, name) {
  return `${suite}\u0000${name}`
}

module.exports = {
  readJUnitFiles,
  parseJUnitXml,
  isJUnitPath,
  normalizeSuiteName,
  normalizeTestName,
  testKey,
  MAX_FILE_BYTES
}
