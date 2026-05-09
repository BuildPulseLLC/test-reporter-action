/**
 * Jest configuration for the BuildPulse test-reporter-action.
 *
 * Notes:
 * - The project is plain CommonJS Node.js, no Babel/TypeScript transforms.
 * - Tests live under `src/__tests__/` so they're co-located with the code
 *   they exercise but isolated from the bundled output. ncc only follows
 *   `require()` chains starting at `src/index.js`, and nothing in production
 *   code requires the test files, so they are never included in `dist/`.
 *   The explicit `testPathIgnorePatterns` for `dist/` is belt-and-suspenders.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  clearMocks: true,
  // Surface verbose output on CI so a failing assertion is easy to read.
  verbose: true
}
