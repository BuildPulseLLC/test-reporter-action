const fs = require('fs')
const os = require('os')
const path = require('path')
const yaml = require('yaml')
const { getPullRequestHeadSha } = require('../metadata')
const { createMetadataYaml } = require('../archive')

const HEAD = '995acfa1c3b2d4e5f60718293a4b5c6d7e8f9012'

function eventFile(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-event-'))
  const file = path.join(dir, 'event.json')
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload))
  return file
}

describe('getPullRequestHeadSha', () => {
  test('reads pull_request.head.sha on pull_request events', () => {
    const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventFile({ pull_request: { head: { sha: HEAD } } }) }
    expect(getPullRequestHeadSha(env)).toBe(HEAD)
  })

  test('reads it on pull_request_target events', () => {
    const env = { GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: eventFile({ pull_request: { head: { sha: HEAD } } }) }
    expect(getPullRequestHeadSha(env)).toBe(HEAD)
  })

  test('is null on other events even when the payload has a PR', () => {
    const env = { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventFile({ pull_request: { head: { sha: HEAD } } }) }
    expect(getPullRequestHeadSha(env)).toBeNull()
  })

  test('is null without an event file, with unreadable JSON, or a malformed sha', () => {
    expect(getPullRequestHeadSha({ GITHUB_EVENT_NAME: 'pull_request' })).toBeNull()
    expect(getPullRequestHeadSha({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/nonexistent/event.json' })).toBeNull()
    expect(getPullRequestHeadSha({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventFile('{not json') })).toBeNull()
    expect(getPullRequestHeadSha({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventFile({ pull_request: { head: { sha: 'abc' } } }) })).toBeNull()
  })
})

describe('createMetadataYaml pull_request block', () => {
  const base = { timestamp: 't', commit: 'c', commitMessage: 'm', branch: 'b', treeSha: 'tr', owner: 'o', repo: 'r' }

  test('writes head_sha next to the PR number', () => {
    const doc = yaml.parse(createMetadataYaml({ ...base, prNumber: '5', prHeadSha: HEAD }))
    expect(doc.git.pull_request).toEqual({ number: 5, head_sha: HEAD })
  })

  test('omits head_sha when it is unknown', () => {
    const doc = yaml.parse(createMetadataYaml({ ...base, prNumber: '5', prHeadSha: null }))
    expect(doc.git.pull_request).toEqual({ number: 5 })
  })

  test('writes no pull_request block without a PR number', () => {
    const doc = yaml.parse(createMetadataYaml({ ...base, prHeadSha: HEAD }))
    expect(doc.git.pull_request).toBeUndefined()
  })
})
