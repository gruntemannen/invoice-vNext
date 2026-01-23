# Oracle Fusion Integration - Quick Start

Invoice Extractor includes an **optional** endpoint that transforms extracted invoice JSON into an Oracle Fusion Cloud Payables compatible payload.

## API Endpoint

Get Oracle Fusion format for any extracted invoice:

```bash
GET /invoices/{messageId}/{attachmentId}/oracle-fusion
```

## Quick Test

1. **Upload an invoice** in the web UI

2. **Get the Oracle Fusion format**:
   - Note the `messageId` and `attachmentId` from the invoice detail
   - Call: `GET /invoices/{messageId}/{attachmentId}/oracle-fusion` against your deployed API base URL

3. **Review the output**:
   ```json
   {
     "oracleFormat": {
       "Source": "INVOICE_EXTRACTOR",
       "InvoiceNumber": "340068146",
       "InvoiceAmount": 5837.40,
       "InvoiceDate": "2025-12-12",
       "InvoiceCurrency": "USD",
       "BusinessUnit": "US1 Business Unit",
       "Supplier": "Oracle Software (Schweiz) GmbH",
       "SupplierNumber": "ORACLE-CH",
       "lines": [...]
     },
     "validation": {
       "valid": true,
       "errors": []
     }
   }
   ```

## Configuration

### 1. Update Supplier Mappings

Edit `backend/oracle-fusion-config.json`:

```json
{
  "supplierMapping": {
    "Your Vendor Name": {
      "supplierNumber": "VENDOR-001",
      "supplierSite": "MAIN"
    }
  }
}
```

### 2. Set Your Business Unit

```json
{
  "businessUnit": "Your Business Unit Name"
}
```

### 3. Configure Default Accounting

```json
{
  "defaultDistribution": {
    "account": "5000",
    "costCenter": "100",
    "department": "IT"
  }
}
```

## Next Steps

1. **Test with your invoices** - Upload real invoices and check Oracle Fusion output
2. **Map your vendors** - Add all your suppliers to the mapping config
3. **Adjust accounting** - Update default GL accounts to match your COA
4. **Build automation** - Create a Lambda to auto-import to Oracle Fusion API

## Oracle Fusion Import

To import into Oracle Fusion:

```bash
# 1. Get the Oracle Fusion format from your API
curl https://your-api/invoices/{messageId}/{attachmentId}/oracle-fusion > invoice.json

# 2. Post to Oracle Fusion API
curl -X POST \
  https://your-instance.oraclecloud.com/fscmRestApi/resources/11.13.18.05/payablesInterfaceInvoices \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d @invoice.json

# 3. Trigger import process
curl -X POST \
  https://your-instance.oraclecloud.com/fscmRestApi/resources/11.13.18.05/payablesInterfaceInvoices/action/submitImportInvoices \
  -H "Authorization: Bearer {token}"
```

## Files Added

- `backend/src/shared/oracle-fusion.ts` - Transformation logic
- `backend/oracle-fusion-config.json` - Configuration file
- `ORACLE-FUSION-INTEGRATION.md` - Full documentation

## Support

See `ORACLE-FUSION-INTEGRATION.md` for complete documentation including:
- Detailed field mappings
- Chart of accounts configuration
- Troubleshooting guide
- Security best practices
