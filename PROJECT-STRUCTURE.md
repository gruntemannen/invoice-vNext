# Project Structure

A serverless invoice-processing application that ingests invoices by email or browser upload,
extracts structured AP data with Claude on Amazon Bedrock, stores reviewable records in
DynamoDB, validates vendor VAT details, and prepares replayable NetSuite AP transactions.

## Top-level

- `frontend/`: static Cognito-authenticated admin PWA deployed to S3 and CloudFront.
- `backend/`: Lambda source, shared extraction/integration code, and non-secret NetSuite
  crosswalk defaults.
- `infra/`: AWS CDK app that deploys the serverless workload and optional account helpers.
- `README.md`: primary GitHub-facing documentation and operating guide.
- `BEDROCK-SETUP.md`: Bedrock model-access setup.
- `NETSUITE-INTEGRATION.md`: NetSuite mapping, runtime settings, replay, and sandbox checklist.

## Frontend (`frontend/`)

- `index.html`, `app.js`, `styles.css`: admin console with Cognito Hosted UI login, dashboard,
  audit/detail drawer with a unified lifecycle status (Imported/On Hold/Processed/Failed) and a
  VAT-registry data panel, upload, NetSuite preview / approve-and-send / live transaction status,
  PDF download, delete, and NetSuite Test/Prod configuration.
- `sw.js`, `sw-register.js`, `manifest.json`, `favicon.svg`: PWA service worker, manifest,
  and icon assets.
- `config.json`: generated at deploy time with the API base URL, Cognito IDs, and AWS region.

## Backend (`backend/`)

- `src/api.ts`: JWT-protected HTTP API for stats, invoice list/detail/download/delete, upload,
  duplicate review decisions, NetSuite runtime config, NetSuite preview, durable transaction
  logging, and replay.
- `src/extract.ts`: SQS extraction worker. Reads PDFs, invokes Claude Sonnet 4.6, normalizes the
  extraction, enriches VAT details, detects duplicates, runs the NetSuite transform inline to
  assign AP flow state with live crosswalk awareness, optionally auto-books a fully clean
  invoice, and writes DynamoDB records.
- `src/ingest.ts`: SES email ingest path from S3 `raw/` objects into attachment records and SQS.
- `src/upload-ingest.ts`: browser-upload ingest path from S3 `uploads/` objects into SQS.
- `src/netsuite-worker.ts`: optional live NetSuite push worker. Loads durable transactions,
  compares/fills configured vendor-master fields, checks NetSuite for an existing record by
  external ID before every upsert, and records success or retryable/permanent failure.
- `src/shared/bedrock.ts`: Bedrock model invocation helpers.
- `src/shared/vies.ts`: EU VIES and Swiss UID/MWST/TVA/IVA VAT validation.
- `src/shared/flow.ts`: AP review status, auto-book eligibility, blocker-vs-warning distinction
  (`hasBlockingFlags`), the first-time-vendor auto-book guardrail, and control flags.
- `src/shared/netsuite.ts`: NetSuite transform, validation, business-unit routing (including
  per-business-unit AP/expense account overrides), OAuth 2.0 M2M, SuiteQL, check-then-upsert, and
  vendor-master sync planning.
- `src/shared/transactions.ts`: durable NetSuite outbox, status model, list/replay helpers,
  transaction event history, and the idempotent create-or-reuse helper shared by the manual
  approve endpoint and the auto-book path.
- `src/shared/netsuite-settings.ts`: DynamoDB-backed Test/Prod NetSuite endpoint settings.
- `src/shared/dynamo.ts`, `s3.ts`, `email.ts`, `prompts.ts`, `confidence.ts`, `stats.ts`,
  `metrics.ts`, `logger.ts`: common AWS and extraction utilities.
- `scripts/ab-eval.ts`: model A/B evaluation harness.
- `netsuite-config.json`: non-secret NetSuite crosswalks, business-unit routes, defaults, and
  vendor-sync field map.

## Infra (`infra/`)

- `lib/config.ts`: deploy-time configuration such as region, project prefix, Bedrock model,
  upload limit, retention, extraction concurrency, VAT lookup options, and the NetSuite
  live-push/auto-book toggles.
- `lib/workload-stack.ts`: main CDK stack for S3, DynamoDB, SQS/DLQ, Lambda, HTTP API, Cognito,
  CloudFront, KMS, Secrets Manager, alarms, and route wiring.
- `lib/member-bootstrap-stack.ts`: optional bootstrap helpers for a member AWS account.
- `lib/org-account-stack.ts`: optional AWS Organizations account creation helper.
- `bin/app.ts`: CDK entrypoint; `--context stacks=...` selects which stack(s) to synth/deploy.
