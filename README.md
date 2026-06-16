# Invoice Extractor

**Serverless invoice processing system** that extracts structured data from PDF invoices using AI, with built-in NetSuite integration.

![Architecture](https://img.shields.io/badge/AWS-Serverless-orange) ![Bedrock](https://img.shields.io/badge/AI-Claude%20Sonnet%204.6-blue) ![NetSuite](https://img.shields.io/badge/ERP-NetSuite-2e7d32)

## Overview

Invoice Extractor is a production-ready, serverless application that:
- Ingests PDF invoices from **email** (Amazon SES) and **web upload**
- Extracts structured JSON using Claude Sonnet 4.6 on Amazon Bedrock (reads PDFs directly)
- Stores results in DynamoDB with confidence scoring
- Pushes invoices to **NetSuite** as Accounts Payable vendor bills (export-only scaffold today; OAuth 2.0 push-ready)
- Provides a **Cognito-authenticated admin console** for ingestion stats, success rates, and audit

## Key Features

- **AI-Powered Extraction**: Uses Claude Sonnet 4.6 for accurate invoice data extraction directly from PDFs (no OCR needed)
- **Email + Web Ingestion**: Accepts invoices via Amazon SES email receiving or direct web upload
- **Multi-Language Support**: Works with invoices in any language (Japanese, Chinese, Korean, European languages, etc.)
- **NetSuite Integration**: Transforms extracted data into a NetSuite REST vendor bill — export-only today, with an OAuth 2.0 (M2M) push scaffold included
- **Admin Console**: Cognito-authenticated dashboard with ingestion stats, success rates, and a DynamoDB audit view
- **Secure by Default**: JWT-protected API, least-privilege IAM, DynamoDB PITR, S3 versioning, a Bedrock concurrency cap, and CloudWatch alarms
- **Confidence Scoring**: Automatic quality assessment of extracted data
- **Multi-Account Architecture**: Designed for AWS Organizations with separate workload accounts
- **Cost Optimized**: Pay-per-use serverless architecture

## Architecture

```
Ingestion
  Email  ─▶ Amazon SES ─▶ S3 (raw/)   ─▶ Ingest Lambda ┐
  Upload ─▶ S3 (uploads/)             ─▶ Upload Lambda ┘─▶ SQS
                                                          │
Processing                                                ▼
                                  Extract Lambda (Claude Sonnet 4.6, reads PDF)
                                                          │
                                                          ▼
                                                      DynamoDB
                                                          ▲
Access  (Cognito JWT on every route)                      │
  Admin UI (CloudFront PWA) ─▶ API Lambda ────────────────┘
                                  └─▶ NetSuite vendor bill (export-only)
```

### How It Works

1. An invoice arrives by **email** (Amazon SES → S3 `raw/`) or **web upload** (→ S3 `uploads/`)
2. An ingest Lambda records it in DynamoDB and queues a processing job (SQS)
3. The Extract Lambda sends the PDF directly to Claude Sonnet 4.6
4. Claude visually analyzes the document and extracts structured data
5. Results are validated, confidence-scored, and stored in DynamoDB
6. Admins sign in to the console (Cognito) to review stats/audit, and can export any invoice as a NetSuite vendor bill

### Components

- **Admin UI**: Static PWA (S3 + CloudFront) — Cognito hosted-UI login, dashboard (stats / success rate / trend), and a DynamoDB audit view
- **Cognito**: User pool + JWT authorizer protecting every API route
- **API Lambda**: Authenticated endpoints — list, **stats**, detail, download, delete, upload, and NetSuite export
- **Ingest Lambda**: Parses inbound SES email (S3 `raw/`) and queues attachments
- **Upload Ingest Lambda**: Handles web uploads (S3 `uploads/`)
- **Extract Lambda**: Sends PDFs to Claude Sonnet 4.6, validates and stores results
- **DynamoDB**: Stores invoice metadata and extracted JSON (PITR enabled)
- **SQS**: Queues extraction jobs with a DLQ + CloudWatch alarms

## Quick Start

### Prerequisites

- AWS Account with Organizations (or single account)
- AWS CLI configured
- Node.js 20+ and npm
- CDK CLI: `npm install -g aws-cdk`

### Deployment

1. **Clone and install dependencies**:
```bash
git clone <repository-url>
cd invoice-extractor
cd infra && npm install
cd ../backend && npm install
```

2. **Configure** (edit `infra/lib/config.ts`):
```typescript
export const config = {
  memberAccountEmail: "your-email@company.com",
  memberAccountName: "invoice-extractor",
  managementAccountId: "YOUR_MGMT_ACCOUNT_ID",

  // Deploy region. For the email path this MUST support SES inbound receiving
  // (e.g. us-east-1, us-west-2, eu-west-1). eu-central-1 does NOT.
  region: "eu-west-1",
  projectPrefix: "invoice-extractor",

  // Bedrock extraction model — a cross-region inference profile whose geo prefix
  // (us./eu./jp./au./global.) matches `region`.
  bedrockModelId: "eu.anthropic.claude-sonnet-4-6",

  maxUploadBytes: 10 * 1024 * 1024,   // max invoice attachment size (bytes)
  dataRetentionDays: 90,              // DynamoDB TTL / attachment retention
  extractReservedConcurrency: 5,      // cap on concurrent Bedrock calls (cost control)
};
```

3. **Deploy** (see [Deployment Guide](#deployment-guide) for multi-account setup):
```bash
cd infra
npx cdk deploy InvoiceExtractorStack --context stacks=InvoiceExtractorStack
```

4. **Create an admin user & sign in**:
   - Create a user in the Cognito user pool (stack output `UserPoolId`) — self-signup is disabled
   - Open the CloudFront URL (output `FrontendUrl`), sign in via the Cognito hosted UI, and you land on the dashboard

## Usage

### Sign in
The admin console is protected by Amazon Cognito. Open the CloudFront URL and sign in via the
hosted UI; the app stores the returned id token and sends it as a bearer token on every API call.

### Dashboard
- KPI cards: total ingested, success rate, completed / failed / pending, average confidence
- 30-day ingestion trend (ingested vs completed vs failed)
- Recent failures, each linking straight to the record

### Audit (browse DynamoDB)
- Filter by status and search by vendor / subject / sender / invoice number
- Open any record for full metadata, the extracted JSON, a PDF download, and delete

### Ingest invoices
- **Email**: send to the SES-verified address (lands in S3 `raw/` and is processed automatically)
- **Upload**: use the Upload action in the console (presigned PUT to S3 `uploads/`)

### Export to NetSuite
For any invoice, build the NetSuite vendor-bill payload (authenticated):
```bash
curl -H "Authorization: Bearer <id_token>" \
  https://your-api-url/invoices/{messageId}/{attachmentId}/netsuite
```
Returns `{ netsuiteFormat, warnings, validation, originalExtraction }`. See the
[NetSuite Integration Guide](NETSUITE-INTEGRATION.md) to enable live push.

## NetSuite Integration

Extracted invoices map to NetSuite Accounts Payable **vendor bills**. The transform, OAuth 2.0
(M2M) client, SuiteQL resolver, and idempotent upsert are implemented; the API is **export-only**
today (it builds + validates the payload), and live push is a credentials + sandbox-validation step.

### Features
- Transform extracted JSON → NetSuite REST `vendorBill` payload (expense sublist)
- Configurable crosswalks (vendor / GL account / currency / department / class / terms → internal ids)
- OAuth 2.0 M2M (JWT client-assertion) client, SuiteQL resolver, idempotent `eid:` upsert
- Validation + gross-vs-net reconciliation before import

### Configuration

Edit `backend/netsuite-config.json` (non-secret crosswalks + defaults):

```json
{
  "subsidiaryId": "",
  "apAccountId": "",
  "defaults": { "departmentId": "", "classId": "", "locationId": "", "taxCodeId": "" },
  "crosswalks": {
    "vendorsByTaxId": { "VAT123456": "4521" },
    "vendorsByName": {},
    "accountsByCode": { "5000": "212" },
    "currenciesByCode": { "USD": "1", "EUR": "4" },
    "departmentsByCode": {},
    "classesByCode": {},
    "termsByName": { "Net 30": "5" }
  }
}
```

NetSuite OAuth 2.0 credentials live in AWS Secrets Manager (`NETSUITE_SECRET_ARN`), not in this file.

See [NetSuite Integration Guide](NETSUITE-INTEGRATION.md) for setup, field mapping, and the sandbox-validation checklist.

## Deployment Guide

### Single Account Deployment

```bash
cd infra
npm install
npx cdk bootstrap
npx cdk deploy InvoiceExtractorStack
```

### Multi-Account Deployment (Organizations)

See [DEPLOYMENT-NOTES.md](DEPLOYMENT-NOTES.md) for detailed instructions.

## Configuration

### `infra/lib/config.ts`

All deploy-time choices live in one file and are threaded into the stack and the Lambda
environment variables:

| Field | Purpose |
|---|---|
| `region` | AWS region. Must support SES inbound receiving if you use the email path (eu-central-1 does not). |
| `projectPrefix` | Prefix for all resource names (lowercase, DNS-safe). |
| `bedrockModelId` | Bedrock model id (cross-region inference profile); its geo prefix must match `region`. |
| `maxUploadBytes` | Max invoice attachment size (default 10 MiB). |
| `dataRetentionDays` | DynamoDB TTL + attachment retention in days (default 90). |
| `extractReservedConcurrency` | Cap on concurrent Bedrock invocations (cost control; tune to your account quota). |
| `managementAccountId` / `memberAccount*` | AWS Organizations multi-account settings. |

### Cost Controls

- **CloudWatch Logs**: 2-week retention
- **DynamoDB TTL**: `dataRetentionDays` (default 90)
- **S3 Lifecycle**: Transition to IA after 30 days
- **Reserved Concurrency**: `extractReservedConcurrency` caps Bedrock spend

### Bedrock Model Access

Ensure Claude Sonnet 4.6 access is enabled:
1. Go to AWS Bedrock Console (in the deployment region, e.g. eu-west-1)
2. Navigate to "Model access"
3. Enable "Claude Sonnet 4.6" (Anthropic)
4. Confirm the cross-region inference profile is usable (the default model id is the EU geo profile `eu.anthropic.claude-sonnet-4-6`)

## API Reference

### Endpoints

All endpoints require a Cognito JWT: `Authorization: Bearer <id_token>`.

**List Invoices**
```
GET /invoices?limit=25&nextToken=...
```

**Dashboard Stats**
```
GET /stats
```
Returns totals, success rate, average confidence, a 30-day trend, and recent failures.

**Get Invoice Detail**
```
GET /invoices/{messageId}/{attachmentId}
```

**Get NetSuite Format**
```
GET /invoices/{messageId}/{attachmentId}/netsuite
```

**Download PDF**
```
GET /invoices/{messageId}/{attachmentId}/download
```

**Delete Invoice**
```
DELETE /invoices/{messageId}/{attachmentId}
```

**Request Upload URL**
```
POST /upload
Body: { "filename": "invoice.pdf", "fileSize": 123456 }
```

## Extracted Data Schema

```json
{
  "vendor": {
    "name": "Supplier Name",
    "taxId": "VAT123456",
    "address": "123 Main St, City, 12345, Country"
  },
  "invoice": {
    "invoiceNumber": "INV-001",
    "purchaseOrderNumber": "PO-12345",
    "invoiceType": "Standard",
    "invoiceDate": "2025-01-15",
    "dueDate": "2025-02-15",
    "currency": "USD",
    "totalAmount": 1234.56,
    "taxAmount": 123.45
  },
  "lineItems": [
    {
      "description": "Product/Service",
      "quantity": 10,
      "unitPrice": 100.00,
      "amount": 1000.00
    }
  ],
  "meta": {
    "confidenceScore": 0.95,
    "extractionModel": "eu.anthropic.claude-sonnet-4-6",
    "warnings": []
  }
}
```

Notes:
- `invoice.totalAmount` **includes tax** (gross).
- `lineItems.unitPrice` and `lineItems.amount` are **pre-tax** (net).
- `invoice.invoiceType` is "Standard" or "Proforma".
- Vendor names are preserved in original language/script (Japanese, Chinese, etc.).

## Monitoring

### CloudWatch Metrics

Namespace: `InvoiceExtractor`

- `ExtractionSuccess` - Successful extractions
- `ExtractionFailure` - Failed extractions
- `ExtractionDurationMs` - Processing time

### CloudWatch Logs

- `/aws/lambda/InvoiceExtractorStack-ExtractLambda*` - Extraction logs
- `/aws/lambda/InvoiceExtractorStack-ApiLambda*` - API logs
- `/aws/lambda/InvoiceExtractorStack-UploadIngestLambda*` - Upload logs

## Troubleshooting

### Invoice Extraction Failed

Check CloudWatch logs for the Extract Lambda:
```bash
aws logs tail /aws/lambda/InvoiceExtractorStack-ExtractLambda* --follow
```

Common issues:
- **Model access denied**: Enable Claude model access in Bedrock console
- **Marketplace subscription**: Ensure AWS Marketplace permissions are configured
- **Low confidence**: PDF quality issues or complex layout
- **Timeout**: Increase Lambda timeout or memory

### Upload Fails

- Check file size (max 10MB by default)
- Ensure PDF format (not image or other format)
- Check S3 bucket permissions

### NetSuite Transformation Errors

- Verify the crosswalks in `netsuite-config.json` resolve vendor / account / currency to NetSuite internal ids
- Check `subsidiaryId` / `apAccountId` match the target NetSuite account
- Ensure all required fields are extracted (entity, tranDate, at least one expense line)

## Security

- **Authentication**: Amazon Cognito user pool + JWT authorizer on every API route (invite-only, optional TOTP MFA)
- **No public S3 access**: All buckets use CloudFront OAI; SSL enforced
- **IAM least privilege**: Separate roles per Lambda; NetSuite credentials in Secrets Manager
- **CORS**: API restricted to the CloudFront origin
- **Data protection**: DynamoDB PITR, S3 versioning, and model-output PII kept out of logs
- **Cost/abuse controls**: reserved concurrency on the Bedrock Lambda + email attachment validation

## Cost Estimate

For 1,000 invoices/month:

- **Lambda**: ~$5 (execution time)
- **Bedrock (Claude Sonnet 4.6)**: ~$15-25 (input/output tokens)
- **DynamoDB**: ~$1 (on-demand)
- **S3**: ~$1 (storage + requests)
- **CloudFront**: ~$1 (data transfer)

**Total**: ~$23-33/month

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Documentation

- [Project Structure](PROJECT-STRUCTURE.md)
- [Bedrock Setup](BEDROCK-SETUP.md)
- [NetSuite Integration](NETSUITE-INTEGRATION.md)
