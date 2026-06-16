# Project Structure

A serverless application that ingests invoices (email or web upload), extracts structured data
with Claude on Amazon Bedrock, stores it in DynamoDB, serves a Cognito-authenticated admin
console, and can export each invoice as a NetSuite vendor bill.

## Top-level

- `frontend/`: Static admin-UI PWA (S3 + CloudFront)
- `backend/`: Lambda source + the NetSuite config and the A/B eval script
- `infra/`: AWS CDK app (deploys the stack)
- `README.md`: Primary documentation
- `BEDROCK-SETUP.md`: Enabling Bedrock model access
- `NETSUITE-INTEGRATION.md`: NetSuite vendor-bill integration + sandbox checklist

## Frontend (`frontend/`)

- `index.html`, `app.js`, `styles.css`: Admin console — Cognito hosted-UI login, dashboard
  (stats / success rate / 30-day trend / recent failures), and a DynamoDB audit view with
  per-record detail, PDF download, and delete
- `sw.js`, `sw-register.js`, `manifest.json`, `favicon.svg`: PWA service worker + manifest
- Runtime config is injected at deploy time as `config.json` (API base URL, Cognito ids, region)

## Backend (`backend/`)

- `src/api.ts`: HTTP API — `list` / `stats` / `detail` / `download` / `delete` / `netsuite` / `upload`
- `src/extract.ts`: Extract Lambda (PDF → Claude Sonnet 4.6 → JSON, normalized + confidence-scored)
- `src/ingest.ts`: SES email ingest (S3 `raw/` → attachment store → SQS)
- `src/upload-ingest.ts`: Web-upload ingest (S3 `uploads/` → SQS)
- `src/shared/`: `bedrock.ts` (model invoke), `netsuite.ts` (vendor-bill transform + OAuth 2.0
  M2M client + SuiteQL + idempotent upsert), `stats.ts` (dashboard aggregation), `dynamo.ts`,
  `s3.ts`, `email.ts`, `prompts.ts`, `confidence.ts`, `metrics.ts`, `logger.ts`
- `scripts/ab-eval.ts`: Model A/B evaluation harness (Sonnet 4.6 vs Haiku 4.5 vs Nova 2 Lite)
- `netsuite-config.json`: Non-secret NetSuite crosswalks + defaults

## Infra (`infra/`)

- `lib/config.ts`: All deploy-time config (region, projectPrefix, bedrockModelId, maxUploadBytes,
  dataRetentionDays, extractReservedConcurrency, and the org-account settings)
- `lib/workload-stack.ts`: Main stack — S3 (CMK on attachments, versioning, access logs),
  DynamoDB (CMK + PITR), SQS + DLQ + CloudWatch alarms, Lambdas, HTTP API + Cognito user pool
  & JWT authorizer, CloudFront (+ security-headers/CSP), Secrets Manager (NetSuite creds)
- `lib/member-bootstrap-stack.ts`: Optional multi-account bootstrap helpers
- `lib/org-account-stack.ts`: Optional AWS Organizations account creation
- `bin/app.ts`: CDK app entry; the `stacks` context selects which stack(s) to synth/deploy
