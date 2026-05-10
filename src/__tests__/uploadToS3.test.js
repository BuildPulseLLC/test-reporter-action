/**
 * uploadToS3 streaming lockdown.
 *
 * The function streams the archive file from disk into the S3 PUT body
 * rather than buffering it. These tests pin down the contract so a later
 * refactor cannot silently regress back to a fs.readFileSync path.
 *
 * What we lock down:
 *   - fs.createReadStream is used (NOT fs.readFileSync).
 *   - Content-Length is computed from fs.statSync and sent in the headers.
 *   - 2xx responses resolve, non-2xx reject as HttpError with the status code.
 *   - File-stream errors (mid-read I/O) reject and tear down the request.
 *   - HTTP request errors reject and tear down the file stream.
 *   - Timeout fires destroy() on both halves.
 */

jest.mock('@actions/core', () => ({
  warning: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn()
}))

const { EventEmitter } = require('events')

// We mock fs + https before requiring the module under test so that the
// const references captured by require('fs') / require('https') at module
// load time point at our test doubles.
jest.mock('fs')
jest.mock('https')

const fs = require('fs')
const https = require('https')

const { uploadToS3, HttpError } = require('../upload')

/**
 * Builds a fake fs.ReadStream — an EventEmitter exposing pipe() and destroy(),
 * just enough for uploadToS3's wiring to compile and run. pipe() does not
 * actually shuttle bytes; for the unit-test surface we only care that pipe()
 * was called with the request as its sink.
 */
function makeFakeFileStream() {
  const stream = new EventEmitter()
  stream.pipe = jest.fn()
  stream.destroy = jest.fn()
  return stream
}

/**
 * Builds a fake https.request return value — also an EventEmitter — that
 * captures the request callback so a test can drive the response side via
 * fakeRequest.respond(statusCode, body).
 */
function makeFakeRequest() {
  const req = new EventEmitter()
  req.write = jest.fn()
  req.end = jest.fn()
  req.destroy = jest.fn()
  return req
}

describe('uploadToS3 streaming', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('uses fs.createReadStream + pipes into the PUT request with Content-Length', async () => {
    const fakeStream = makeFakeFileStream()
    const fakeReq = makeFakeRequest()

    fs.statSync.mockReturnValue({ size: 4096 })
    fs.createReadStream.mockReturnValue(fakeStream)

    let capturedOptions
    https.request.mockImplementation((url, options, cb) => {
      capturedOptions = options
      // Asynchronously deliver a 200 response so the promise resolves.
      setImmediate(() => {
        const res = new EventEmitter()
        res.statusCode = 200
        cb(res)
        res.emit('end')
      })
      return fakeReq
    })

    await uploadToS3('https://s3.example.test/signed', '/tmp/archive.tar.gz')

    // No buffered read.
    expect(fs.readFileSync).not.toHaveBeenCalled()
    // Streamed read.
    expect(fs.createReadStream).toHaveBeenCalledWith('/tmp/archive.tar.gz')
    expect(fakeStream.pipe).toHaveBeenCalledWith(fakeReq)
    // Content-Length carried over from statSync.
    expect(capturedOptions.headers['Content-Length']).toBe(4096)
    expect(capturedOptions.headers['Content-Type']).toBe('application/gzip')
    expect(capturedOptions.method).toBe('PUT')
  })

  test('non-2xx response rejects as HttpError with status code', async () => {
    fs.statSync.mockReturnValue({ size: 1 })
    fs.createReadStream.mockReturnValue(makeFakeFileStream())

    https.request.mockImplementation((url, options, cb) => {
      setImmediate(() => {
        const res = new EventEmitter()
        res.statusCode = 503
        cb(res)
        res.emit('data', 'service unavailable')
        res.emit('end')
      })
      return makeFakeRequest()
    })

    await expect(
      uploadToS3('https://s3.example.test/signed', '/tmp/a.tgz')
    ).rejects.toMatchObject({
      name: 'HttpError',
      statusCode: 503
    })
  })

  test('file-stream error tears down request and rejects', async () => {
    const fakeStream = makeFakeFileStream()
    const fakeReq = makeFakeRequest()

    fs.statSync.mockReturnValue({ size: 1 })
    fs.createReadStream.mockReturnValue(fakeStream)
    https.request.mockReturnValue(fakeReq)

    const p = uploadToS3('https://s3.example.test/signed', '/tmp/a.tgz')

    // Simulate a mid-read I/O failure.
    setImmediate(() => fakeStream.emit('error', new Error('EIO: read failure')))

    await expect(p).rejects.toThrow('EIO: read failure')
    expect(fakeReq.destroy).toHaveBeenCalled()
  })

  test('request error destroys file stream and rejects', async () => {
    const fakeStream = makeFakeFileStream()
    const fakeReq = makeFakeRequest()

    fs.statSync.mockReturnValue({ size: 1 })
    fs.createReadStream.mockReturnValue(fakeStream)
    https.request.mockReturnValue(fakeReq)

    const p = uploadToS3('https://s3.example.test/signed', '/tmp/a.tgz')

    setImmediate(() => fakeReq.emit('error', new Error('ECONNRESET')))

    await expect(p).rejects.toThrow('ECONNRESET')
    expect(fakeStream.destroy).toHaveBeenCalled()
  })

  test('timeout destroys both halves and rejects with timeout error', async () => {
    const fakeStream = makeFakeFileStream()
    const fakeReq = makeFakeRequest()

    fs.statSync.mockReturnValue({ size: 1 })
    fs.createReadStream.mockReturnValue(fakeStream)
    https.request.mockReturnValue(fakeReq)

    const p = uploadToS3('https://s3.example.test/signed', '/tmp/a.tgz')

    setImmediate(() => fakeReq.emit('timeout'))

    await expect(p).rejects.toThrow('Upload timeout')
    expect(fakeReq.destroy).toHaveBeenCalled()
    expect(fakeStream.destroy).toHaveBeenCalled()
  })
})
