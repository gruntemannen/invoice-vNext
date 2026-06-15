# Invoice Extractor

**Serverless invoice processing system** that extracts structured data from PDF invoices using AI, with built-in NetSuite integration.

![Architecture](https://img.shields.io/badge/AWS-Serverless-orange) ![Bedrock](https://img.shields.io/badge/AI-Claude%20Sonnet%204.6-blue) ![NetSuite](https://img.shields.io/badge/ERP-NetSuite-2e7d32)

## Overview

Invoice Extractor is a production-ready, serverless application that:
- Accepts PDF invoice uploads via web UI
- Extracts structured JSON using Claude Sonnet 4.6 on Amazon Bedrock (reads PDFs directly)
- Stores results in DynamoDB with confidence scoring
- Transforms data to NetSuite format
- Provides a modern PWA interface for review and management

## Key Features

- **AI-Powered Extraction**: Uses Claude Sonnet 4.6 for accurate invoice data extraction directly from PDFs (no OCR needed)
- **Multi-Language Support**: Works with invoices in any language (Japanese, Chinese, Korean, European languages, etc.)
- **NetSuite Ready**: Built-in transformation to NetSuite AP format
- **Multi-Account Architecture**: Designed for AWS Organizations with separate workload accounts
- **Confidence Scoring**: Automatic quality assessment of extracted data
- **PWA Support**: Installable web app with offline capabilities
- **Cost Optimized**: Pay-per-use serverless architecture

## Architecture

```
┌─────────────┐
│   Web UI    │ (CloudFront + S3)
│   (PWA)     │
└──────┬──────┘
       │
       ▼
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  API Lambda │────▶│ Upload to S3 │────▶│ DynamoDB    │
└─────────────┘     └──────┬───────┘     └─────────────┘
                          │
                          ▼
                   ┌──────────────┐
                   │ Extract      │
                   │ Lambda       │
                   │ (Sonnet 4.6) │
                   └──────────────┘
```

### How It Works

1. User uploads a PDF invoice via the web UI
2. PDF is stored in S3 and a processing job is queued
3. Extract Lambda reads the PDF and sends it directly to Claude Sonnet 4.6
4. Claude visually analyzes the document and extracts structured data
5. Results are validated, confidence-scored, and stored in DynamoDB
6. User can view extracted data and download NetSuite format

### Components

- **Frontend**: Static HTML/JS/CSS hosted on S3 + CloudFront
- **API Lambda**: Handles uploads, downloads, list, delete, and NetSuite transformation
- **Upload Ingest Lambda**: Triggered by S3 events, creates DynamoDB records
- **Extract Lambda**: Sends PDFs to Claude Sonnet 4.6, validates and stores results
- **DynamoDB**: Stores invoice metadata and extracted JSON
- **SQS**: Queues extraction jobs with DLQ for failed processing

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
  region: "eu-central-1",
  projectPrefix: "invoice-extractor",
};
```

3. **Deploy** (see [Deployment Guide](#deployment-guide) for multi-account setup):
```bash
cd infra
npx cdk deploy InvoiceExtractorStack --context stacks=InvoiceExtractorStack
```

4. **Access the UI**:
   - The deployment outputs a CloudFront URL
   - Open in browser and start uploading invoices

## Usage

### Upload Invoice
1. Navigate to the web UI
2. Click "Choose File" and select a PDF invoice
3. Click "Upload"
4. Wait for processing (typically 5-15 seconds)

### Review Extracted Data
- View list of processed invoices
- Click an invoice to see:
  - PDF preview
  - Extracted JSON data
  - Confidence score
  - Any warnings

### Get NetSuite Format
```bash
curl https://your-api-url/invoices/{messageId}/{attachmentId}/netsuite
```

Returns NetSuite-compatible JSON ready for import.

## NetSuite Integration

The system includes built-in NetSuite compatibility:

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

### Environment Variables

**Extract Lambda**:
- `BEDROCK_MODEL_ID`: AI model (default: `eu.anthropic.claude-sonnet-4-6` — the EU cross-region inference profile for Claude Sonnet 4.6; use the `us.`/`jp.`/`au.` prefix or `global.` for other geos)

**API Lambda**:
- `MAX_UPLOAD_BYTES`: Max file size (default: 10MB)

### Cost Controls

- **CloudWatch Logs**: 2-week retention
- **DynamoDB TTL**: 90 days (configurable)
- **S3 Lifecycle**: Transition to IA after 30 days
- **Lambda Reserved Concurrency**: Limit extraction Lambda to control Bedrock costs

### Bedrock Model Access

Ensure Claude Sonnet 4.6 access is enabled:
1. Go to AWS Bedrock Console (in the deployment region, e.g. eu-central-1)
2. Navigate to "Model access"
3. Enable "Claude Sonnet 4.6" (Anthropic)
4. Confirm the cross-region inference profile is usable (the default model id is the EU geo profile `eu.anthropic.claude-sonnet-4-6`)

## API Reference

### Endpoints

**List Invoices**
```
GET /invoices?limit=25&nextToken=...
```

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
- `invoice.invoiceType` is "Standard" or "Prepayment" (for proforma invoices).
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

- **No public S3 access**: All buckets use CloudFront OAI
- **IAM least privilege**: Separate roles per Lambda
- **SSL enforced**: All S3 buckets require SSL
- **CORS configured**: API allows only necessary origins
- **No authentication**: Add API Gateway authorizer for production

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
