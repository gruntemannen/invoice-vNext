# Invoice Extractor

Serverless invoice processing for a centralized AP inbox. The system ingests invoices from
email or browser upload, extracts structured data with Claude on Amazon Bedrock, validates and
enriches vendor data, and prepares NetSuite AP transactions with a durable replayable outbox.

![AWS](https://img.shields.io/badge/AWS-Serverless-orange)
![Bedrock](https://img.shields.io/badge/AI-Claude%20Sonnet%204.6-blue)
![NetSuite](https://img.shields.io/badge/ERP-NetSuite-2e7d32)

## Current Solution

Invoice Extractor currently provides:

- PDF invoice intake from Amazon SES email or authenticated browser upload.
- Direct PDF extraction with Claude Sonnet 4.6 on Amazon Bedrock.
- DynamoDB persistence for source metadata, extracted JSON, confidence, review flags,
  duplicate fingerprints, NetSuite runtime settings, and NetSuite transaction logs.
- EU/Northern Ireland VAT validation through the European Commission VIES API.
- Swiss `CHE... MWST/TVA/IVA` VAT validation through the Swiss UID PublicServices endpoint.
- AP review controls for missing data, low confidence, duplicates, PO matching, non-standard
  documents, proformas, and vendor bank details.
- Admin duplicate handling: hold duplicate invoices for review or allow a reviewed duplicate to
  continue to NetSuite.
- NetSuite AP payload generation for `vendorBill` and `vendorPrepayment`.
- Runtime NetSuite endpoint configuration for Test and Prod in the admin console.
- Durable NetSuite transaction logging before any live push attempt.
- Replay endpoints for NetSuite outages or retryable failures.
- Optional live NetSuite worker with OAuth 2.0 M2M, idempotent upsert, and vendor-master
  compare/fill for configured missing fields.

Live NetSuite push is deliberately controlled by `netSuiteLivePushEnabled`. With the default
`false`, the app still logs NetSuite transactions and keeps them replayable, but the worker does
not call NetSuite.

## Architecture

```text
Email path:
  Inbound email -> Amazon SES -> S3 raw/ -> Ingest Lambda -> SQS

Upload path:
  Admin UI -> API Lambda -> presigned S3 PUT -> S3 uploads/ -> Upload Ingest Lambda -> SQS

Processing:
  SQS -> Extract Lambda -> Claude Sonnet 4.6 on Bedrock
      -> normalize + reconcile extraction
      -> EU VIES or Swiss UID VAT validation
      -> duplicate lookup + AP control flags
      -> DynamoDB invoice record

Review and integration:
  CloudFront PWA -> Cognito Hosted UI -> JWT-protected API Lambda
      -> invoice audit/detail/download/delete
      -> NetSuite preview
      -> durable NetSuite transaction log
      -> optional NetSuite worker push
      -> replay after outage
```

## End-To-End Flow

1. An invoice arrives by email or browser upload.
2. The ingest path stores the PDF in S3, writes a pending invoice record to DynamoDB, and queues
   extraction in SQS.
3. The Extract Lambda sends the PDF directly to Claude Sonnet 4.6. There is no separate OCR step.
4. The extraction is normalized into vendor, buyer, invoice header, service period, remittance,
   bank details, and line items.
5. Proforma invoices are marked as `VendorPrepayment`; standard invoices remain `VendorBill`.
6. The printed PO value is preserved as `invoice.purchaseOrderNumber`. A separate
   `invoice.purchaseOrderLookupKey` may be derived for NetSuite matching, but the invoice PO is
   not rewritten.
7. Vendor VAT enrichment runs:
   - EU and Northern Ireland VAT IDs use VIES.
   - Swiss `CHE-###.###.### MWST/TVA/IVA` IDs use Swiss UID validation.
   - Unsupported tax IDs are skipped with metadata rather than failing extraction.
8. Duplicate detection hashes vendor, invoice number, currency, and gross total, then checks a
   sparse DynamoDB duplicate index.
9. Duplicate invoices are held for AP review by default. An admin can mark the duplicate as
   allowed for NetSuite; this clears only the duplicate blocker, not unrelated validation issues.
10. The AP flow assigns `READY_FOR_NETSUITE` or `NEEDS_REVIEW` and stores reader-facing control
   flags.
11. The admin console lets AP review the record, download the PDF, preview NetSuite, log a
    NetSuite transaction, or delete the invoice and PDF.
12. NetSuite transaction logging writes a `NETSUITE_TRANSACTION` item before anything is queued.
13. If live push is enabled and the item is ready/configured, the NetSuite worker fetches the
    transaction, optionally fills configured missing vendor-master fields, performs the idempotent
    NetSuite upsert, and records success or failure events.
14. Retryable failures can be replayed individually or in bulk after NetSuite recovers.

## Key Components

- `frontend/`: static PWA admin console deployed to S3 and CloudFront.
- `backend/src/ingest.ts`: parses inbound SES email and queues attachments.
- `backend/src/upload-ingest.ts`: handles S3 upload events for browser uploads.
- `backend/src/extract.ts`: extraction orchestration, confidence, VAT enrichment, duplicate
  lookup, and DynamoDB update.
- `backend/src/shared/vies.ts`: EU VIES and Swiss UID VAT validation.
- `backend/src/shared/flow.ts`: AP review status, auto-book eligibility, and control flags.
- `backend/src/shared/netsuite.ts`: NetSuite transform, validation, OAuth, SuiteQL, live upsert,
  business-unit routing, and vendor-master sync.
- `backend/src/shared/transactions.ts`: durable NetSuite outbox, status model, and replay helpers.
- `backend/src/api.ts`: authenticated API endpoints for audit, upload, config, NetSuite preview,
  transaction logging, and replay.
- `infra/`: AWS CDK app for buckets, queues, table, Lambdas, API Gateway, Cognito, CloudFront,
  alarms, KMS, and Secrets Manager.

## Admin Console

The admin console is protected by Amazon Cognito. Self-signup is disabled; create users in the
stack's Cognito user pool.

Views:

- **Dashboard**: totals, success rate, completed/failed/pending counts, average confidence,
  30-day trend, and recent failures.
- **Audit**: searchable invoice records with detail drawer, extracted JSON, VAT status, control
  flags, NetSuite preview, durable transaction logging, PDF download, and delete.
- **Upload**: PDF-only upload through presigned S3 PUT.
- **Config**: Test and Prod NetSuite endpoint settings.

## VAT Validation

The extractor stores VAT validation on `extractedJson.vendor.vatValidation` and a compact summary
on `extractedJson.meta.vendorVatValidation`.

Supported providers:

| Provider | Input examples | Behavior |
|---|---|---|
| `EU_VIES` | `DE123456789`, `FR...`, `NL...`, `XI...` | Calls European Commission VIES REST API and records valid/invalid status plus returned registry/match fields. |
| `CH_UID` | `CHE-116.289.195 MWST`, `CHE116289195 TVA` | Validates Swiss UID checksum, then calls Swiss UID PublicServices `ValidateVatNumber`. |

Lookup outages and timeouts are stored as `ERROR` metadata and do not fail extraction. Invalid
VATs create review warnings. Swiss and EU results share the same status model:
`VALID`, `INVALID`, `SKIPPED`, or `ERROR`.

## NetSuite Integration

Standard invoices map to NetSuite `vendorBill`. Proforma invoices map to `vendorPrepayment`
because they are prepayment requests, not final AP bills.

Implemented:

- NetSuite AP transform and validation.
- NetSuite Test/Prod runtime endpoint settings in DynamoDB.
- OAuth 2.0 M2M JWT client assertion.
- SuiteQL helper.
- Idempotent REST upsert by external ID.
- Vendor-master compare/fill before AP push when `vendorSync` is configured.
- Durable transaction outbox and replay endpoints.

Default live behavior:

- `netSuiteLivePushEnabled: false` logs transactions but does not call NetSuite.
- `netSuiteLivePushEnabled: true` queues ready/configured transactions to the NetSuite worker.

See [NETSUITE-INTEGRATION.md](NETSUITE-INTEGRATION.md) for NetSuite field mapping and the
sandbox checklist.

## NetSuite Runtime Configuration

The admin console **Config** page stores Test and Prod endpoint settings in DynamoDB:

- active push target: Test or Prod
- account ID
- REST API base URL
- OAuth token endpoint
- optional per-environment Secrets Manager ARN/name
- OAuth scope
- Record API path
- SuiteQL path
- vendor bill record ID
- vendor prepayment record ID
- request timeout
- SuiteTax enabled
- `tranId` allowed

Both Test and Prod are shown so AP/admin users can maintain both sets of settings. The selector
chooses the active target stamped on NetSuite previews and transaction logs; live worker calls use
the environment stored on the transaction.

Non-secret NetSuite defaults and crosswalks live in `backend/netsuite-config.json`. Secrets live
in AWS Secrets Manager, either from the environment-specific Config value or the stack-level
`NETSUITE_SECRET_ARN` fallback.

## Vendor Master Sync

When a live NetSuite transaction has a resolved vendor internal ID, the worker can fetch the
NetSuite vendor record and fill configured blank fields. It does not overwrite populated fields
unless `vendorSync.missingOnly` is set to `false`.

Supported source fields:

- `name`
- `email`
- `taxId`
- `address`
- `iban`
- `bic`
- `bankName`
- `vatValidationStatus`
- `vatRequestIdentifier`

The default mapping is intentionally conservative: `name -> companyName` and `email -> email`.
VAT, bank, and custom entity fields must be mapped to account-specific NetSuite field IDs before
live updates.

## Deployment

### Prerequisites

- AWS account and AWS CLI profile.
- Node.js 20+ and npm.
- AWS CDK CLI.
- Amazon Bedrock model access for Claude Sonnet 4.6.
- A region compatible with your ingestion path. For email receiving, use an SES inbound region
  such as `eu-west-1`.

### Install

```bash
cd infra
npm install

cd ../backend
npm install
```

### Configure

Edit `infra/lib/config.ts`.

```typescript
export const config = {
  region: "eu-west-1",
  projectPrefix: "invoice-extractor",
  bedrockModelId: "eu.anthropic.claude-sonnet-4-6",
  maxUploadBytes: 10 * 1024 * 1024,
  dataRetentionDays: 90,
  extractReservedConcurrency: 5,
  viesLookupEnabled: true,
  viesRequestTimeoutMs: 6000,
  netSuiteLivePushEnabled: false,

  memberAccountName: "invoice-extractor",
  memberAccountEmail: "your-email@company.com",
  managementAccountId: "YOUR_MGMT_ACCOUNT_ID"
};
```

### Deploy Single Account

```bash
cd infra
npx cdk bootstrap
npx cdk deploy InvoiceExtractorStack --context stacks=InvoiceExtractorStack
```

### Deploy With AWS Organizations Helpers

```bash
cd infra
npx cdk deploy OrgAccountStack --context stacks=OrgAccountStack
npx cdk deploy MemberBootstrapStack --context stacks=MemberBootstrapStack
npx cdk deploy InvoiceExtractorStack --context stacks=InvoiceExtractorStack
```

### Create Admin Users

Use the stack output `UserPoolId`, then create or manage users in Cognito. Example:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true
```

Open the stack output `FrontendUrl` and sign in through Cognito Hosted UI.

## API Reference

Every API route requires `Authorization: Bearer <id_token>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/stats` | Dashboard totals, success rate, trend, and recent failures. |
| `GET` | `/invoices?limit=25&nextToken=...` | List invoice audit rows. |
| `GET` | `/invoices/{messageId}/{attachmentId}` | Get full invoice detail. |
| `DELETE` | `/invoices/{messageId}/{attachmentId}` | Delete invoice row and PDF. |
| `GET` | `/invoices/{messageId}/{attachmentId}/download` | Return a 15-minute presigned PDF URL. |
| `POST` | `/upload` | Create a presigned PDF upload URL. |
| `POST` | `/invoices/{messageId}/{attachmentId}/duplicate-review` | Save `HOLD_FOR_REVIEW` or `ALLOW_NETSUITE` for a duplicate invoice. |
| `GET` | `/config/netsuite` | Read NetSuite Test/Prod runtime settings. |
| `POST` | `/config/netsuite` | Save NetSuite Test/Prod runtime settings. |
| `GET` | `/invoices/{messageId}/{attachmentId}/netsuite` | Build NetSuite preview, validation, and config hints. |
| `POST` | `/invoices/{messageId}/{attachmentId}/netsuite/transactions` | Log a durable NetSuite transaction and optionally queue live push. |
| `GET` | `/netsuite/transactions?status=FAILED_RETRYABLE` | List NetSuite transaction log rows. |
| `POST` | `/netsuite/transactions/{transactionId}/replay` | Replay one replayable transaction. |
| `POST` | `/netsuite/transactions/replay?status=FAILED_RETRYABLE&limit=25` | Bulk replay replayable transactions. |

Upload request body:

```json
{
  "filename": "invoice.pdf",
  "fileSize": 123456
}
```

NetSuite preview response:

```json
{
  "netsuiteFormat": {},
  "netSuiteRequest": {},
  "netSuiteEnvironment": {},
  "warnings": [],
  "configurationHints": [],
  "validation": { "valid": false, "errors": [] },
  "flow": {},
  "originalExtraction": {}
}
```

## Extracted Data Shape

Representative stored extraction:

```json
{
  "vendor": {
    "name": "PKF Consulting AG",
    "taxId": "CHE-116.289.195 MWST",
    "address": "Example Street 1, 8000 Zurich",
    "email": "ap@example.com",
    "bankDetails": {
      "ibans": ["CH9300762011623852957"],
      "bic": "POFICHBEXXX",
      "bankName": "PostFinance",
      "accountName": "PKF Consulting AG",
      "accountNumber": null
    },
    "vatValidation": {
      "provider": "CH_UID",
      "status": "VALID",
      "normalizedVat": "CHE-116.289.195 MWST",
      "valid": true,
      "countryCode": "CH",
      "uid": "CHE-116.289.195",
      "vatSuffix": "MWST"
    }
  },
  "buyer": {
    "name": "Entirely AG",
    "taxId": null,
    "address": null,
    "email": null,
    "entityCode": null
  },
  "invoice": {
    "invoiceNumber": "1321770 / 3180",
    "purchaseOrderNumber": "PO -9-25-0027",
    "purchaseOrderLookupKey": "9-25-0027",
    "invoiceType": "Standard",
    "transactionIntent": "VendorBill",
    "invoiceDate": "2026-07-06",
    "dueDate": null,
    "currency": "CHF",
    "paymentTerms": null,
    "description": null,
    "servicePeriod": { "startDate": null, "endDate": null },
    "remittanceReference": null,
    "netAmount": 3471.09,
    "taxAmount": 281.16,
    "totalAmount": 3752.25
  },
  "lineItems": [],
  "meta": {
    "confidenceScore": 1,
    "reviewStatus": "READY_FOR_NETSUITE",
    "autoBookEligible": true,
    "duplicateReview": {
      "action": "ALLOW_NETSUITE",
      "reviewedAt": "2026-07-07T10:30:00.000Z",
      "reviewedBy": "ap@example.com"
    },
    "controlFlags": []
  }
}
```

Important extraction rules:

- `invoice.totalAmount` is gross.
- `lineItems.amount` and `lineItems.unitPrice` are net/pre-tax.
- Proformas set `invoice.transactionIntent` to `VendorPrepayment`.
- `purchaseOrderNumber` preserves the invoice text; `purchaseOrderLookupKey` is only for matching.
- Duplicate invoices default to `HOLD_FOR_REVIEW`; `ALLOW_NETSUITE` is an admin decision stored
  with timestamp and reviewer.
- Vendor names remain in the original language/script.

## Operations

### Monitor

CloudWatch namespace: `InvoiceExtractor`

- `ExtractionSuccess`
- `ExtractionFailure`
- `ExtractionDurationMs`
- upload/rejection and NetSuite worker metrics where emitted

Useful logs:

- `/aws/lambda/InvoiceExtractorStack-ExtractLambda*`
- `/aws/lambda/InvoiceExtractorStack-ApiLambda*`
- `/aws/lambda/InvoiceExtractorStack-UploadIngestLambda*`
- `/aws/lambda/InvoiceExtractorStack-NetSuiteWorkerLambda*`

### Replay NetSuite Outages

When NetSuite is down, transaction rows remain in DynamoDB. After recovery:

```bash
curl -H "Authorization: Bearer <id_token>" \
  "https://<api>/netsuite/transactions?status=FAILED_RETRYABLE"

curl -X POST -H "Authorization: Bearer <id_token>" \
  "https://<api>/netsuite/transactions/replay?status=FAILED_RETRYABLE&limit=25"
```

### Delete Test Invoices

Deleting a row from the Audit drawer removes the DynamoDB item and the stored PDF object.
Deleted records cannot be requeued unless the PDF is uploaded again.

## Troubleshooting

### Extraction Failed

Check the Extract Lambda logs. Common causes:

- Bedrock model access not enabled.
- Bedrock quota/throttling.
- File is not a valid PDF for browser upload.
- External VAT lookup timeout. This is recorded as metadata and should not fail extraction.
- DynamoDB marshalling or schema issues. The shared writer removes nested `undefined` values.

### VAT Shows `SKIPPED`

The tax ID was present but not supported by a configured validator. Current supported validation
paths are EU/Northern Ireland VIES and Swiss UID/MWST/TVA/IVA.

### NetSuite Preview Has Warnings

Preview can produce warnings before any live push:

- vendor, currency, account, subsidiary, department, class, PO, or terms not mapped
- proforma/prepayment account missing
- gross/net reconciliation mismatch
- vendor-master fields require review
- buyer/business-unit route missing or falling back to default

Warnings are expected while crosswalks and runtime settings are being populated.

### Upload Fails

- Browser uploads accept PDFs only.
- Check `maxUploadBytes`.
- Verify the browser is authenticated and the API returns a presigned S3 URL.
- Check S3 CORS and Upload Ingest Lambda logs.

## Security

- Cognito Hosted UI and JWT authorizer protect every API route.
- Self-signup is disabled; users are admin-created.
- S3 buckets block public access and enforce SSL.
- Attachment bucket and DynamoDB use the customer-managed KMS key.
- DynamoDB point-in-time recovery is enabled.
- S3 object versioning is enabled.
- Lambda roles use least-privilege grants.
- NetSuite credentials live in Secrets Manager, not in DynamoDB or source config.
- Bedrock concurrency is capped by `extractReservedConcurrency`.

## Cost Controls

- Serverless pay-per-use architecture.
- DynamoDB on-demand capacity.
- DynamoDB TTL and S3 lifecycle controlled by `dataRetentionDays`.
- CloudWatch log retention is two weeks.
- Bedrock invocation concurrency is capped.

For roughly 1,000 invoices/month, typical infrastructure cost is small compared with Bedrock
model usage. Actual cost depends on PDF size, token volume, retries, and retention.

## Documentation

- [Project Structure](PROJECT-STRUCTURE.md)
- [Bedrock Setup](BEDROCK-SETUP.md)
- [NetSuite Integration](NETSUITE-INTEGRATION.md)

## License

MIT License - see [LICENSE](LICENSE) for details.
