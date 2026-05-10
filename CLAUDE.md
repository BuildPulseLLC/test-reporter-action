# BuildPulse System Overview

BuildPulse is a CI analytics platform for detecting and tracking flaky tests. It is a full refactor of the legacy Rails monolith at `/Users/anthony.loera/Documents/buildpulse-legacy/buildpulse.io` (still served at `app.buildpulse.io`). The new system is a multi-repo monorepo:

| Repo | Tech Stack | Purpose |
|------|-----------|---------|
| `web-client/` | Next.js 16, React 19, TypeScript, MUI 7 | Main web application (app2.buildpulse.io) |
| `admin-client/` | Next.js 16, React 19, TypeScript, MUI 7 | Internal admin dashboard (admin.buildpulse.io) |
| `platform-api/` | Go 1.24, ECS Fargate | Public REST API replacing legacy Rails API |
| `test-reporter-action/` | Node.js | GitHub Action — this repo (formerly `buildpulse-action`) |
| `cognito-lambdas/` | Go 1.23, AWS Lambda | Cognito triggers — pre-sign-up, pre-token JWT enrichment |
| `migration-lambdas/` | Go 1.23, AWS Lambda | Data migration — PostgreSQL → DocumentDB |
| `test-reporter-lambdas/` | Go 1.23, AWS Lambda | Test result processing + notifications |
| `agents/` | Go 1.24, AWS Lambda + ECS Fargate | Internal SDLC + customer-facing agents |
| `environment/` | Terraform | Shared AWS infrastructure |

## System Data Flow

```
Customer CI → test-reporter-action → S3 (test results archive)
                                       ↓
                             process-test-results Lambda
                                       ↓
                                DocumentDB ←──── migration-orchestrator (at login)
                                       ↓
                          web-client (ECS Fargate) → User browser
                                       ↓
                         send-notifications Lambda (DynamoDB-triggered)
```

## Authentication Flow

```
User signup → Cognito pre-sign-up Lambda (validate)
User login  → Cognito pre-token-generation Lambda (enrich JWT with org/role claims)
                                ↓
                     SNS user-migration topic
                                ↓
                  migration-orchestrator Lambda (migrate PostgreSQL → DocumentDB)
```

## Current Migration Status (as of 2026-05-09)

- **Database**: DocumentDB 5.0 (I/O-Optimized) replaced MongoDB Atlas on 2026-03-30 and is the primary database. PostgreSQL is read-only.
- **Auth**: GitHub App auth shipped — web-client handles installation and repository webhook events.
- **Notifications**: DynamoDB-based per-repo scheduled notifications live in production
- **Legacy uploads**: S3 dual-write forwarding from new bucket → `buildpulse-uploads` (legacy) is active

## AWS Infrastructure

- **Region**: Always `us-west-2` — never `us-east-1`
- **ECS Fargate**: `web-client`, `admin-client`, `platform-api`, and the `agents` executor run here
- **Lambdas**: All Go Lambdas use `provided.al2023` runtime, `bootstrap` handler
- **Terraform state**: Each Lambda's `.infra/backend.tf` references `environment/` remote state via S3
- **Lambda descriptions**: Must NOT contain commas (Terraform validation error)
- **Go Lambda CI**: Always include `use_lockfile` in GitHub Actions workflows

---

# test-reporter-action — Repo-Specific Rules

## What This Repo Does

Packages JUnit XML test results and uploads them to BuildPulse. This is a **customer-facing** GitHub Action — any changes affect all BuildPulse users. Published to the marketplace under the `BuildPulseLLC/test-reporter-action` repo (formerly `buildpulse/buildpulse-action`).

## Architecture

- `action.yml` — GitHub Action definition (inputs, outputs, entrypoint)
- `src/index.js` — Main orchestration logic
- `src/archive.js` — Tar/gzip packaging of test result files
- `src/upload.js` — Signed URL fetch + S3 upload
- `src/auth.js` — API token auth vs legacy key/secret auth
- `src/metadata.js` — Git metadata collection (commit SHA, branch, repo info)

## Authentication Modes

1. **API Token (recommended)**: Sends `Authorization: Bearer <token>` to web-client's `/api/test-results/upload-url` endpoint
2. **Legacy key/secret**: Uses `BUILDPULSE_ACCESS_KEY_ID` + `BUILDPULSE_SECRET_ACCESS_KEY` — still supported but deprecated

## Upload URL Endpoint

The action calls `web-client`'s `POST /api/test-results/upload-url` to get a signed S3 URL, then uploads directly to S3. If you change the request/response shape of this endpoint, update `src/upload.js` accordingly.

## Testing

```bash
npm install
npm test
```

Tests use Jest. Mock the GitHub Actions toolkit (`@actions/core`, `@actions/github`) as needed.

## Versioning

Users pin to `BuildPulseLLC/test-reporter-action@v3`. Breaking changes require a new major version tag.
