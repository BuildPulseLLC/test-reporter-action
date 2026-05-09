# test-reporter-action Audit — Grades

**Audit date:** 2026-05-09
**Auditor:** Claude (deep audit)
**Overall grade:** D+

## Summary

Customer-facing GitHub Action that packages JUnit XML files and uploads them to BuildPulse. The core orchestration in `src/index.js` is short, readable, and modularized cleanly into `auth`, `archive`, `upload`, `metadata`, and `sampler`. The flow itself is sensible.

However, this repo has serious customer-impacting problems for something published to the GitHub Marketplace under `BuildPulseLLC/test-reporter-action@v3`:

1. **No tests at all.** `npm test` fails with "No tests found" (`package.json:9`). For an action that affects every BuildPulse customer's CI, this is unacceptable.
2. **Secrets are not masked.** `core.setSecret()` is never called for `api-token`, `key`, or `secret`. A future code path that logs or echoes any of these (or a debug print of the request body) will leak them in the customer's CI log.
3. **10 npm vulnerabilities** including 1 critical and 5 high. `fast-xml-parser` is a *direct* dependency in `package.json:23` but is not actually imported anywhere in `src/`. It's pure attack surface.
4. **No retries.** Single-shot fetch + single-shot S3 PUT. A transient blip = failed customer build.
5. **Whole-file `readFileSync` upload** — large archives are fully buffered into memory with `Content-Length: fileSize` (`upload.js:97-131`).
6. The legacy `run.sh` (Go binary downloader) still ships in the repo (`run.sh`) but is unreferenced by `action.yml` — confusing dead code in a customer-facing repo.

The codebase is small enough that fixes are straightforward. The grade reflects shipping-worthy hygiene gaps, not architectural problems.

## Category breakdowns

### Code quality — C

- Clean module split. `index.js:63-233` reads top-to-bottom; auth/archive/upload/metadata each do one thing.
- **Zero tests.** No `__tests__/`, no `*.test.js`, and `npm test` exits 1 with `No tests found` (`package.json:9`). Jest is in `devDependencies` (`package.json:29`) but never used. README claims "`npm install && npm test`" works (`README.md:124-127`) — false.
- The two auth-validation paths are duplicated almost verbatim. `validateAuthInputs()` in `auth.js:48-62` checks the same condition that `authenticate()` in `auth.js:16-41` checks, then `index.js:90-94` rechecks via `validateAuthInputs` and throws a different error than `authenticate()` would have thrown (`auth.js:38`).
- `core.debug()` is used for the file list (`index.js:135-137`) — good — but `core.info()` log lines like `Runner: ${runner.cpus} CPUs...` (`index.js:98`) and `Found ${testFiles.length}` (`index.js:134`) are always-on, which is fine, but no progress indicator for slow archive/upload steps.
- `archive.js:94-98` swallows non-`ENOENT` archive warnings to `console.warn` instead of `core.warning` — these won't show up as GHA annotations.
- `runCommand()` resolves with exit code on `close` but `child.on('error', reject)` (`index.js:55`) means a spawn error rejects the promise, which then bubbles to `core.setFailed(error.message)` — but the action will skip the entire upload of any partial XML the test command may have produced. The `if: '!cancelled()'` pattern in the README (`README.md:34`) doesn't help here because the action returned early.
- `inputs.commit || process.env.GITHUB_SHA` (`index.js:150`) — but `action.yml:85` already defaults `commit` to `${{ github.sha }}`, so the `||` fallback is dead in normal GHA use; harmless but confusing.
- Node 20 only (`action.yml:130`). Customers on older self-hosted runners with `node16`-only support will silently fail; no version check.
- Cleanup of the temp dir is wrapped in try/empty-catch (`index.js:220-224`), so leaks are silent — but more importantly, **on the error path** (the `catch` at `index.js:230-232`), the temp dir is never cleaned up at all. Long-running self-hosted runners accumulate `buildpulse-*` dirs in `os.tmpdir()`.

### Security — D

- **Secrets are never masked.** `core.setSecret()` is not called for `inputs.apiToken`, `inputs.key`, or `inputs.secret` anywhere in `src/` (`index.js:66-80`, `auth.js:16-41`). GHA only auto-masks values registered as repo secrets; if a customer passes a token via a non-secret input, or any future code path includes the token in a thrown error, it will appear plaintext in the public CI log. This is a one-line fix and has no downside.
- The auth header `Authorization: Bearer ${apiToken}` (`auth.js:21`) is constructed and passed straight into `request()` (`upload.js:65-72`). If the API ever returns a 3xx redirect, Node's `https.request` does **not** follow redirects by default, so the auth header isn't replayed to a third-party host — that's actually safe by accident, but if anyone wraps this with a redirect-following client (like upgrading to `fetch`), they need to know.
- **HTTPS not enforced.** `upload.js:23` and `upload.js:101` fall back to plain `http` if the URL says `http:`. The default API host is HTTPS (`upload.js:11`), but `inputs.apiHost` (`index.js:78`) is overridable via input *and* env var with no validation — a malicious or misconfigured `BUILDPULSE_API_HOST=http://evil/` env var on a self-hosted runner would silently send the bearer token in cleartext. Reject non-HTTPS unless an explicit dev-mode flag is set.
- **Path traversal in archive entry names.** `archive.js:108` and `archive.js:117` use `path.basename(file)` for the archive entry name — that's fine for the archive itself (no traversal in entries) — but the *source* paths come from a glob over `inputs.path` (`index.js:129`) with `followSymbolicLinks: true` (`index.js:37`). If a customer's repo contains a symlinked report file pointing at `/etc/shadow`, this action will read and upload it. For a customer running BuildPulse against an untrusted PR, this is a vector for exfiltration.
- **No decompression-bomb defense on upload side** — but the action only *creates* tar.gz, it doesn't extract anything, so this is a non-issue here. Make sure `process-test-results` Lambda enforces it.
- **`fast-xml-parser` is a direct, vulnerable, unused dependency.** `package.json:23` declares `fast-xml-parser ^4.3.4`, but `grep -r "fast-xml-parser" src/` returns nothing. `npm audit` flags it as **critical** (CVE entity-encoding bypass) plus 4 more advisories on it alone. Remove it.
- **`yaml` direct dep is also vulnerable** (`package.json:25`, GHSA-48c2-rrv3-qjmp, stack overflow on deeply nested YAML). Used only for *writing* the metadata YAML in `archive.js:72`, so the customer can't trigger it — but bump it to silence the audit.
- **`npm audit`: 10 vulnerabilities (4 moderate, 5 high, 1 critical).** All have a fix available via `npm audit fix`. Notable: `undici` (5 advisories), `picomatch` (ReDoS), `brace-expansion` (ReDoS), `ajv` (ReDoS).
- `package-lock.json` is committed (good), pinning transitive deps. `archiver`, `@actions/core`, `@actions/glob` are all reputable and maintained.
- `repository-path` is used as a `cwd` for `execSync('git ...')` calls in `metadata.js:14-20` and `metadata.js:29-44`. The git commands themselves are static strings, so there's no shell injection from `repository-path` (the path is just `cwd`), but `metadata.js:54` does `git log -1 --format=%s ${commitSha}` with `commitSha` interpolated. `commitSha` is sourced from `inputs.commit` or `env.GITHUB_SHA` (`index.js:150`); a customer-controlled `commit` input passed as `--upload-pack=...` or with shell metacharacters could matter — but `execSync` here is invoked without `shell: true`, and the command string is parsed by Node, so it's still tokenized safely. Still, `git rev-parse ${commitSha}^{tree}` (`metadata.js:29`) and the `git log` command should pass `commitSha` as an arg array to `execFileSync`, not interpolate. Defense in depth.
- The `command:` input (`action.yml:102-114`) executes shell-quoted strings with `spawn(command, { shell: true })` (`index.js:50-53`). This is *intentional* and documented, so it's fine — but it means a poisoned workflow file could run arbitrary commands as the runner user. Standard for GHA.
- `dependabot[bot]` skip path (`index.js:83-87`) does not check for `apiToken` separately from key/secret — re-reading: it does, the condition is `!apiToken && !key && !secret`. OK.

### Performance — C+

- **No retries, no backoff.** Both `getUploadUrl` (`upload.js:57-88`) and `uploadToS3` (`upload.js:96-134`) are single-shot. A transient TLS hiccup, a 502 from the API, a 503 from S3 — all fail the customer's CI step with no retry. Action best practice (and what the legacy `run.sh:83` did with `curl --retry 3`) is at minimum 3 retries with exponential backoff on 5xx/network errors.
- **In-memory upload.** `upload.js:97` does `fs.readFileSync(filePath)` and `req.write(fileBuffer)` (`upload.js:131`). For a 100MB+ archive (large monorepos with thousands of test files), this allocates the whole buffer in V8 heap. Should be a `fs.createReadStream(filePath).pipe(req)`. Also the `Content-Length` is set from `statSync` (`upload.js:98`) which is correct for streaming too.
- **Highest gzip level (`level: 9`)** in `archive.js:88-90` — burns CPU on every customer build for marginal size savings. Default (level 6) is the right call unless someone has measured this.
- **Bundle size 2.5MB** for `dist/index.js` (2,516,420 bytes, 77,448 lines). Source map `index.js.map` is 2.95MB and is *bundled in the dist directory* — it's not strictly needed at runtime (the `--source-map` ncc flag puts it there). Since `runs.using: node20` (`action.yml:130`) loads `dist/index.js`, the source map is downloaded by every customer on every run and adds latency to the action's startup. Drop the source map from the published bundle (publish a separate artifact or only build with source maps in dev).
- **Sampler does `os.cpus()` every 1s** (`sampler.js:89`) — fine.
- Action startup has to spawn a full Node process and load the 2.5MB bundle. Every customer build pays ~0.5–1s for this; not much to do beyond reducing bundle size. `archiver` is the heaviest dep — could be replaced with a tiny pure-JS tar-gz writer, but probably not worth it.
- `dist/` modification time (Apr 25) matches `src/` (Apr 25) — bundle is in sync at the time of audit. **No CI check enforces this**, so a future PR could land with stale `dist/`.

### Documentation — B-

- README is well structured with API token usage, legacy usage, wrap-mode example, full input/output table (`README.md:96-120`).
- README claims `npm test` works (`README.md:124-127`); it doesn't. Either delete the line or add tests.
- `action.yml` input descriptions are thorough (`action.yml:9-119`), with shortlinks for GitHub docs. Good.
- The `api-host` input is documented as "for internal testing only" (`action.yml:117`) but has no validation — a customer who copy-pastes a workflow with `api-host: http://...` will silently send their token cleartext (see Security).
- **Versioning/migration: missing.** This repo was renamed from `buildpulse/buildpulse-action` to `BuildPulseLLC/test-reporter-action`, and the major version went from v2 → v3. The README mentions `@v3` (`README.md:35`) but there is no `MIGRATION.md`, no "Upgrading from v2" section, no release notes here. Customers on `buildpulse/buildpulse-action@v2` need to know what changed (the auth shape, the dropped `cli-host` input, the removed Go binary download in `run.sh`). `package.json:3` is still `"version": "2.0.0"` even though the GHA tag is v3.
- README says "Mock the GitHub Actions toolkit (`@actions/core`, `@actions/github`) as needed" — but `@actions/github` isn't a dep at all (`package.json:19-25`). Either stale text from the old repo or aspirational.
- `CLAUDE.md` is accurate to the current code (`src/` listing, auth modes, upload flow). Good.
- Bitbucket Pipelines support exists in `metadata.js:78-106` but is not mentioned in the README at all. Either it's intentionally undocumented (in which case it's hidden surface area), or the README needs a "Bitbucket Pipelines" section.
- No `CONTRIBUTING.md`, no description of how to release / publish a new version of the action.
- `package.json:2` name is `buildpulse-action`, not `test-reporter-action` — minor cosmetic mismatch with the repo/marketplace name.

## Top 5 recommended improvements

1. **Mask all credentials with `core.setSecret()` immediately after `getInput`** [S] — `index.js:66-80`. One-liner per secret. Customer log leaks are a P0 if they ever happen, and this is a cheap insurance policy.
2. **Add retries with exponential backoff to `getUploadUrl` and `uploadToS3`** [M] — `upload.js:57-134`. Retry 5xx and connection errors 3–5 times with backoff. Match what the legacy Go reporter did. Currently a single transient blip fails the customer's CI.
3. **Fix all `npm audit` issues, especially: remove unused `fast-xml-parser`, bump `yaml` and `archiver`** [S] — `package.json:23-25`. `fast-xml-parser` is a critical-severity unused direct dep — pure liability.
4. **Add a real test suite** [L] — at minimum unit tests for `auth.js`, `archive.js` (correct entries, metadata yaml shape), `upload.js` (with `nock`), and `metadata.js` (GH and Bitbucket env-var matrices). Wire to GH Actions CI on PRs. Currently `npm test` *fails* (`package.json:9`).
5. **Stream the archive to S3 instead of buffering** [S] — `upload.js:97,131`. Replace `readFileSync` + `req.write(fileBuffer)` with `fs.createReadStream(archivePath).pipe(req)`. Also enforce HTTPS on `apiHost` (`index.js:78`) and add a CI step that fails if `dist/` is out of sync with `src/` (`@vercel/ncc-check` pattern).

## What was NOT covered

- Did not audit `dist/index.js` content beyond confirming it includes `setSecret` from `@actions/core` (so the symbol is available) and that its mtime matches `src/`. Did not run a build to verify byte-for-byte that the bundle reflects the source.
- Did not audit `node_modules/` for the actual installed versions vs. lockfile.
- Did not exercise the action against a live BuildPulse environment — purely static analysis.
- Did not test the wrap-mode `command` flow with real test commands or verify the sampler results across OS variants.
- Did not look at the Bitbucket Pipelines code path with real env vars.
- Did not audit the upstream API contract (`POST /api/test-results/upload-url` in `web-client`) to confirm the request/response shape matches what `upload.js` sends/parses.
- Did not check whether the action.yml inputs (e.g. `repository`, `account`) are still actually used in the legacy auth flow on the server side.

## Notes for the next reviewer

- The **`run.sh`** file (`run.sh:1-122`) is dead code: it downloads a Go binary and shells out to it, and is *not referenced from* `action.yml` anymore (`action.yml:130-131` uses `node20`/`dist/index.js`). Delete it or it will confuse future devs into thinking the action still uses the legacy reporter.
- The auth header keys for legacy mode (`X-BuildPulse-Access-Key`, `X-BuildPulse-Secret-Key` in `auth.js:30-32`) need to be cross-checked against the web-client API endpoint — easy to typo and silently break legacy customers.
- `process.env.BUILDPULSE_API_HOST` (`index.js:78`) is a hidden second way to override the API host that isn't documented in `action.yml` or README — flag this for product/security review.
- `archive.js:23` writes `source: 'buildpulse-action'` into `buildpulse.yml`. The `process-test-results` Lambda may key off this string. If you rename the source, check the Lambda first.
- `package.json:3` version is `2.0.0`, marketplace tag is `v3`. Decide whether `package.json` version matters for this repo (it doesn't get published to npm as a library, so probably no, but still worth aligning).
- `inputs.commit` is interpolated into `git log -1 --format=%s ${commitSha}` (`metadata.js:54`) and `git rev-parse ${commitSha}^{tree}` (`metadata.js:29`). Refactor to `execFileSync('git', ['log', '-1', '--format=%s', commitSha], { cwd })` for defense-in-depth even though `execSync` doesn't shell-evaluate by default.
- `validateAuthInputs` (`auth.js:48-62`) and `authenticate` (`auth.js:16-41`) duplicate the same conditional; consider consolidating to one function that returns an `{ ok, auth, error }` shape.
