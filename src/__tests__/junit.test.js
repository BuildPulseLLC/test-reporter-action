/**
 * Local JUnit reader used by the job summary.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const { parseJUnitXml, readJUnitFiles, isJUnitPath, normalizeSuiteName, normalizeTestName } = require('../junit')

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="CheckoutTest" tests="5">
    <testcase classname="CheckoutTest" name="applies discount" time="1.5">
      <failure message="expected 902 to be below 800&#10;at line 3">stack trace here</failure>
    </testcase>
    <testcase classname="CheckoutTest" name="charges tax" time="0.25"/>
    <testcase classname="CheckoutTest" name="skipped one" time="0"><skipped/></testcase>
    <testcase classname="CheckoutTest" name="errors &amp; more" time="2">
      <error><![CDATA[
        TypeError: x is undefined
        <testcase name="not a real test"/>
      ]]></error>
    </testcase>
    <!-- <testcase name="commented out"/> -->
    <testcase classname="CheckoutTest" name="a &gt; b" time="1,000.25"><system-out>ok</system-out></testcase>
  </testsuite>
</testsuites>`

describe('parseJUnitXml', () => {
  const r = parseJUnitXml(SAMPLE)

  test('counts tests, failures (failure + error), skips and duration', () => {
    expect(r.tests).toBe(5)
    expect(r.failed).toBe(2)
    expect(r.skipped).toBe(1)
    expect(r.durationSec).toBeCloseTo(1.5 + 0.25 + 0 + 2 + 1000.25)
  })

  test('ignores tags inside CDATA and comments', () => {
    expect(r.failures.map((f) => f.name)).toEqual(['applies discount', 'errors & more'])
  })

  test('uses the first line of the message attribute, else the first body line', () => {
    expect(r.failures[0]).toMatchObject({
      suite: 'CheckoutTest',
      classname: 'CheckoutTest',
      message: 'expected 902 to be below 800'
    })
    expect(r.failures[1].message).toBe('TypeError: x is undefined')
  })

  test('reads a bare <testsuite> root and strips ANSI codes', () => {
    const out = parseJUnitXml('<testsuite name=""><testcase name="\u001b[31mred\u001b[0m"><failure/></testcase></testsuite>')
    expect(out.failures).toEqual([{ suite: 'default', classname: '', name: 'red', file: '', message: '' }])
  })

  test('failure wins over skipped on the same test case', () => {
    const out = parseJUnitXml('<testsuite name="s"><testcase name="t"><skipped/><failure message="boom"/></testcase></testsuite>')
    expect(out.failed).toBe(1)
    expect(out.skipped).toBe(0)
  })

  test('attribute values may contain ">"', () => {
    const out = parseJUnitXml('<testsuite name="s"><testcase name="x > y" time="1"/></testsuite>')
    expect(out.tests).toBe(1)
  })
})

describe('identity normalization (kept in step with BuildPulse ingestion)', () => {
  test('suite names', () => {
    expect(normalizeSuiteName('')).toBe('default')
    expect(normalizeSuiteName('rspec12')).toBe('rspec')
    expect(normalizeSuiteName('rspec-api')).toBe('rspec-api')
  })

  test('test names', () => {
    expect(normalizeTestName('Exam Partition 2 #482 - Browser Id 3 - Unit | foo: works')).toBe('Unit | foo: works')
    expect(normalizeTestName('"before each" hook for "loads the page"')).toBe('loads the page')
    expect(normalizeTestName('plain')).toBe('plain')
  })
})

describe('readJUnitFiles', () => {
  let dir
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-junit-'))
    fs.writeFileSync(path.join(dir, 'a.xml'), SAMPLE)
    fs.writeFileSync(path.join(dir, 'b.xml'), '<testsuite name="b"><testcase name="ok" time="3"/></testsuite>')
    fs.writeFileSync(path.join(dir, 'coverage.xml'), '<testsuite><testcase name="not junit"/></testsuite>')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello')
    fs.mkdirSync(path.join(dir, 'sub.xml'))
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('totals across JUnit files and skips non-JUnit paths', () => {
    const files = ['a.xml', 'b.xml', 'coverage.xml', 'notes.txt', 'sub.xml', 'missing.xml'].map((f) => path.join(dir, f))
    const r = readJUnitFiles(files)
    expect(r).toMatchObject({ tests: 6, passed: 3, failed: 2, skipped: 1, filesRead: 2, filesSkipped: 1 })
    expect(r.failures).toHaveLength(2)
  })

  test('isJUnitPath mirrors ingestion: .xml without "coverage" in the name', () => {
    expect(isJUnitPath('reports/junit.XML')).toBe(true)
    expect(isJUnitPath('reports/cobertura-coverage.xml')).toBe(false)
    expect(isJUnitPath('reports/junit.json')).toBe(false)
  })
})
