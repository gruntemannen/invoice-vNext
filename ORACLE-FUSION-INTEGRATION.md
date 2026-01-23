# Oracle Fusion Cloud Payables Integration

This document describes the optional Oracle Fusion Cloud Payables transformation included in **Invoice Extractor**.

## Overview

Invoice Extractor produces a simple extracted JSON shape (vendor, invoice, lineItems). A transformation endpoint converts that output into an Oracle Fusion compatible payload.

## Architecture

```
PDF → Text extraction → Bedrock (Nova Lite) → Extracted JSON → Transform → Oracle Fusion JSON
```

## Extracted JSON (input to transformation)

The extractor returns:

- `vendor.name` (seller)
- `vendor.taxId` (optional)
- `vendor.address` (string, optional)
- `invoice.invoiceNumber`, `invoice.invoiceDate`, `invoice.currency`
- `invoice.totalAmount` (gross, includes tax)
- `invoice.taxAmount` (tax amount)
- `lineItems[]` with `description`, `quantity`, `unitPrice`, `amount` (net/pre-tax)

Notes:
- If `meta.warnings` contains `reconciled_*`, the system applied deterministic corrections for common PDF table parsing issues.

## Oracle Fusion Transformation

### API Endpoint

Get Oracle Fusion format for an invoice:
```text
GET /invoices/{messageId}/{attachmentId}/oracle-fusion
```

Response:
```json
{
  "oracleFormat": {
    "Source": "INVOICE_EXTRACTOR",
    "InvoiceNumber": "340068146",
    "InvoiceAmount": 5837.40,
    "InvoiceDate": "2025-12-12",
    "InvoiceCurrency": "USD",
    "InvoiceType": "Standard",
    "BusinessUnit": "US1 Business Unit",
    "Supplier": "Oracle Software (Schweiz) GmbH",
    "SupplierNumber": "ORACLE-CH",
    "SupplierSite": "ZURICH",
    "GlDate": "2025-12-12",
    "PaymentTerms": "Net Due in 30 Days",
    "lines": [
      {
        "LineNumber": 1,
        "LineType": "Item",
        "LineAmount": 5400.00,
        "Description": "Oracle Fusion Risk Management Cloud Service",
        "Quantity": 10,
        "UnitPrice": 540.00,
        "distributions": [
          {
            "DistributionLineNumber": 1,
            "DistributionLineType": "Item",
            "Amount": 5400.00,
            "DistributionCombination": "100-5000-IT"
          }
        ]
      }
    ]
  },
  "validation": {
    "valid": true,
    "errors": []
  },
  "originalExtraction": { ... }
}
```

## Configuration

### Supplier Mapping

Edit `backend/oracle-fusion-config.json` to map vendor names to Oracle Supplier IDs:

```json
{
  "supplierMapping": {
    "Oracle Software (Schweiz) GmbH": {
      "supplierNumber": "ORACLE-CH",
      "supplierSite": "ZURICH"
    },
    "Your Vendor Name": {
      "supplierId": 12345,
      "supplierSite": "MAIN"
    }
  }
}
```

### Default Accounting

Configure default GL account segments:

```json
{
  "defaultDistribution": {
    "account": "5000",
    "costCenter": "100",
    "department": "IT"
  }
}
```

### Business Unit

Set your Oracle Fusion business unit:

```json
{
  "businessUnit": "US1 Business Unit"
}
```

## Integration Steps

### 1. Configure Supplier Mapping

Before importing invoices, map your vendors to Oracle Fusion suppliers:

1. Get list of vendors from extracted invoices
2. Look up corresponding Supplier IDs in Oracle Fusion
3. Add mappings to `oracle-fusion-config.json`

### 2. Test Transformation

Upload a test invoice and call the Oracle Fusion endpoint:

```bash
curl https://your-api.execute-api.eu-central-1.amazonaws.com/invoices/{messageId}/{attachmentId}/oracle-fusion
```

Verify the output matches Oracle Fusion requirements.

### 3. Import to Oracle Fusion

Use the Oracle Fusion REST API to import invoices:

```bash
POST https://your-instance.oraclecloud.com/fscmRestApi/resources/11.13.18.05/payablesInterfaceInvoices
Authorization: Bearer {token}
Content-Type: application/json

{
  "Source": "INVOICE_EXTRACTOR",
  "InvoiceNumber": "340068146",
  ...
}
```

Then trigger the import process:

```bash
POST https://your-instance.oraclecloud.com/fscmRestApi/resources/11.13.18.05/payablesInterfaceInvoices/action/submitImportInvoices
```

### 4. Automate (Optional)

Create a Lambda function that:
1. Polls for completed extractions
2. Transforms to Oracle Fusion format
3. Calls Oracle Fusion API to import
4. Updates DynamoDB with import status

## Oracle Fusion API Requirements

### Required Fields
- `Source` - Invoice source identifier
- `InvoiceNumber` - Unique invoice number
- `InvoiceAmount` - Total invoice amount
- `InvoiceDate` - Invoice date
- `InvoiceCurrency` - Currency code
- `BusinessUnit` - Operating unit
- Supplier identification (one of):
  - `Supplier` (name)
  - `SupplierNumber`
  - `SupplierId`

### Optional Fields
- `InvoiceType` - Defaults to "Standard"
- `GlDate` - Defaults to invoice date
- `PaymentTerms`
- `Description`
- `SupplierSite`

### Line Items
Each line requires:
- `LineNumber` - Sequence number
- `LineType` - Usually "Item"
- `LineAmount` - Line amount
- `distributions` - At least one distribution with accounting

## Chart of Accounts

The distribution combination format depends on your Oracle COA structure. Update the `buildDistributionCombination` function in `backend/src/shared/oracle-fusion.ts` to match your format.

Example formats:
- Segment-based: `"01-100-5000-IT-000"` (Company-CostCenter-Account-Dept-Project)
- Concatenated: `"01.100.5000.IT.000"`
- Natural account: `"5000"`

## Validation

The transformation includes validation to ensure:
- All required Oracle Fusion fields are present
- Supplier is mapped or identifiable
- Line items have proper accounting distributions
- Amounts and dates are in correct format

## Troubleshooting

### Supplier Not Found
If a vendor name doesn't match any mapping:
- Add the vendor to `supplierMapping` in config
- Or use `Supplier` field with vendor name (Oracle will try to match)

### Missing Accounting
If line items lack accounting codes:
- Ensure `defaultDistribution` is configured
- Or extract account codes from invoice line descriptions

### Invalid Business Unit
- Verify the business unit name matches exactly in Oracle Fusion
- Check user has access to the business unit

## Cost Considerations

Oracle Fusion API calls are included in your Oracle Cloud subscription. No additional costs for API usage within reasonable limits.

## Security

- Store Oracle Fusion credentials in AWS Secrets Manager
- Use OAuth 2.0 for API authentication
- Implement retry logic with exponential backoff
- Log all API calls for audit trail

## Next Steps

1. Configure supplier mappings for your vendors
2. Test transformation with sample invoices
3. Set up Oracle Fusion API credentials
4. Build automation Lambda for continuous import
5. Monitor import success rates and errors

## References

- [Oracle Fusion Payables REST API](https://docs.oracle.com/en/cloud/saas/financials/24c/farfa/)
- [Import Payables Invoices](https://docs.oracle.com/en/cloud/saas/financials/24c/farfa/op-payablesinterfaceinvoices-post.html)
- [Oracle Cloud Authentication](https://docs.oracle.com/en/cloud/saas/financials/24c/farfa/Authentication.html)
