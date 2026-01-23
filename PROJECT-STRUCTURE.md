# Project Structure

This repository contains a serverless application for extracting invoice data using AI and reviewing results in a web UI.

## Top-level

- `frontend/`: Static web UI (S3 + CloudFront)
- `backend/`: Lambda source code (ingest/upload/API/extraction)
- `infra/`: AWS CDK app (deploys the stack)
- `README.md`: Primary documentation
- `ORACLE-FUSION-*.md`: Oracle Fusion transformation documentation

## Backend

- `backend/src/api.ts`: HTTP API (list/detail/download/delete/oracle-fusion/upload)
- `backend/src/extract.ts`: Extract Lambda (PDF → Claude 3.5 Sonnet → JSON)
- `backend/src/ingest.ts`: SES email ingest (optional flow)
- `backend/src/upload-ingest.ts`: S3 upload ingest (creates records and queues extraction)
- `backend/src/shared/`: Shared utilities (Bedrock invocation, DynamoDB, S3, prompts, etc.)

## Infra

- `infra/lib/workload-stack.ts`: Main stack (S3, DynamoDB, SQS, Lambdas, API, CloudFront)
- `infra/lib/member-bootstrap-stack.ts`: Optional multi-account bootstrap helpers
- `infra/lib/org-account-stack.ts`: Optional AWS Organizations account creation
- `infra/lib/config.ts`: Configuration (region, project prefix)
