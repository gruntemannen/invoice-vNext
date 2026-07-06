# NetSuite Integration

This system pushes emailed/uploaded invoices into Oracle NetSuite as AP transactions.
Standard payable invoices map to `vendorBill`; proforma invoices map to
`vendorPrepayment` because they are prepayment requests, not final AP vendor bills.

The integration is scaffolded: transform, validation, OAuth 2.0 client, SuiteQL resolver,
durable outbox, replay, and idempotent upsert are implemented. Live push stays disabled
until credentials and sandbox validation are complete.

## How It Works

```text
PDF/email/upload
  -> Bedrock extraction
  -> DynamoDB invoice record
  -> transformToNetSuite()
  -> NetSuite push envelope
       recordType: vendorBill | vendorPrepayment
       payload: clean NetSuite REST body
  -> durable transaction outbox
  -> optional live worker push by externalId
```

- `GET /invoices/{messageId}/{attachmentId}/netsuite` returns
  `{ netsuiteFormat, netSuiteRequest, warnings, configurationHints, validation, flow, originalExtraction }`.
- `netsuiteFormat` is the clean REST body.
- `netSuiteRequest` is the durable schema envelope with `schemaVersion`, `recordType`,
  `externalId`, document classification, business-unit routing, and payload.
- `configurationHints` lists the exact `netsuite-config.json` paths that need NetSuite
  internal IDs before live push can be enabled.
- `POST /invoices/{messageId}/{attachmentId}/netsuite/transactions` writes the transaction
  ledger record before any NetSuite call is queued.
- Replay endpoints support outage recovery:
  `GET /netsuite/transactions`,
  `POST /netsuite/transactions/{transactionId}/replay`, and
  `POST /netsuite/transactions/replay?status=FAILED_RETRYABLE`.

Key module: `backend/src/shared/netsuite.ts`

Key exports: `transformToNetSuite`, `validateNetSuiteRequest`, `buildExternalId`,
`getAccessToken`, `suiteql`, `upsertNetSuiteRecord`, `exampleNetSuiteConfig`.

## Standard Invoices -> vendorBill

| Extracted | vendorBill | Notes |
|---|---|---|
| `vendor.taxId` / `vendor.name` | `entity` `{ id }` | resolved through `vendorsByTaxId`, then `vendorsByName` |
| `invoice.invoiceNumber` | `tranId` + `externalId` | `externalId` is the idempotency key |
| `invoice.invoiceDate` | `tranDate` | required |
| `invoice.currency` | `currency` `{ id }` | via `currenciesByCode` |
| `invoice.dueDate` / `paymentTerms` | `dueDate` / `terms` `{ id }` | terms via `termsByName` |
| `buyer.*` | `subsidiary` and business dimensions | routed through recipient/business-unit mapping |
| `invoice.purchaseOrderNumber` | warning or PO ref context | PO-backed bills should use a PO match/conversion flow |
| `lineItems[]` net amounts | `expense.items[]` | GL, department, class, location, and tax code are crosswalked |

`invoice.totalAmount` is gross. Expense lines are net. The transform warns when
`sum(line net) + taxAmount != totalAmount`.

## Proformas -> vendorPrepayment

Proforma invoices are classified as prepayments when `invoice.invoiceType = "Proforma"` or
`invoice.transactionIntent = "VendorPrepayment"`.

| Extracted/config | vendorPrepayment | Notes |
|---|---|---|
| `vendor.taxId` / `vendor.name` | `entity` `{ id }` | same vendor resolution as vendor bills |
| `invoice.totalAmount` | `payment` | required prepayment amount |
| `invoice.invoiceDate` | `tranDate` | required |
| `prepaymentPaymentAccountId` | `account` `{ id }` | required NetSuite funding bank/credit-card account |
| `prepaymentAccountId` | `prepaymentAccount` `{ id }` | optional prepayment asset account override |
| `purchaseOrdersByNumber` | `purchaseOrder` `{ id }` | optional PO link |
| recipient route | `subsidiary`, `department`, `class`, `location`, custom segment | same business-unit mapping as bills |

Because this is a cash/prepayment workflow, proformas stay in AP review unless the NetSuite
schema and configuration are complete.

## Recipient -> Business-Unit Routing

The buyer/recipient is matched before payload validation. Crosswalks map recipient details to
a key in `businessUnits`:

- `businessUnitsByEntityCode`
- `businessUnitsByTaxId`
- `businessUnitsByName`
- `businessUnitsByEmailDomain`
- `businessUnitsByAddressContains`

Each `businessUnits.<key>` route can set:

- `businessUnitId`
- `businessUnitName`
- `subsidiaryId`
- `departmentId`
- `classId`
- `locationId`
- `customBodyFields`
- `customLineFields`

If `businessUnitSegmentFieldId` is configured, `businessUnitId` is emitted as `{ id }` on the
transaction body and expense lines. Missing recipient routing emits a NetSuite warning and
keeps the invoice in review.

## Configuration

Edit `backend/netsuite-config.json`. It contains non-secret values only.

Configure NetSuite endpoints in the admin console under **Config**. The UI stores Test and
Prod runtime settings in DynamoDB:

- account id, REST API base URL, OAuth token endpoint
- optional per-environment Secrets Manager ARN/name
- OAuth scope, Record API path, SuiteQL path
- vendor bill and vendor prepayment record ids
- request timeout, SuiteTax enabled, and `tranId` allowed options

The "Use account defaults" action derives the standard account-specific REST host from the
account id; sandbox ids with underscores are converted to NetSuite's lower-case hyphen host
format. Explicit endpoint fields always win.

Required before live vendor-bill push:

- `vendorsByTaxId` or `vendorsByName`
- `currenciesByCode`
- `accountsByCode` or `defaults.expenseAccountId`
- `apAccountId` when the account requires an AP account
- subsidiary/business-unit routing for OneWorld

Required before live proforma/prepayment push:

- all vendor-bill basics that still apply
- `prepaymentPaymentAccountId`
- NetSuite Vendor Prepayments feature enabled
- NetSuite role permissions for Vendor Prepayment create/edit
- optional `prepaymentAccountId` if the default prepayment account is not enough

Credentials live in Secrets Manager under the environment secret configured in **Config**, or
fall back to `NETSUITE_SECRET_ARN` when that field is blank. Private keys and client
credentials are never stored in DynamoDB or `netsuite-config.json`.

## Durable Outbox And Replay

NetSuite pushes are database-first:

1. The API builds the NetSuite push envelope.
2. The API writes a `NETSUITE_TRANSACTION` item to DynamoDB.
3. Only after the transaction is logged does the API enqueue the NetSuite worker.
4. The worker marks the transaction `IN_FLIGHT`, calls NetSuite by idempotent `externalId`,
   then records `SUCCEEDED`, `FAILED_RETRYABLE`, or `FAILED_PERMANENT`.
5. Retryable outage failures remain queryable and replayable even if SQS later DLQs the message.

Transaction statuses:

- `HELD_FOR_REVIEW`: extracted or mapped data is not ready for NetSuite.
- `HELD_FOR_CONFIGURATION`: live push is disabled; transaction is logged for later replay.
- `QUEUED`: logged and queued.
- `IN_FLIGHT`: worker attempt is active.
- `SUCCEEDED`: NetSuite upsert completed.
- `FAILED_RETRYABLE`: outage/rate-limit/network/server failure; safe to replay.
- `FAILED_PERMANENT`: validation/auth/client failure that needs correction before replay.

## NetSuite Account Setup

1. Enable REST Web Services and OAuth 2.0.
2. Create an integration record with OAuth 2.0 client credentials and upload the public
   certificate.
3. Create a least-privilege role with REST Web Services and "Log in using OAuth 2.0 Access
   Tokens". Do not use the older Token-Based Authentication permission for this flow.
4. Grant create/edit permissions for Vendor Bill and Vendor Prepayment, plus view permissions
   for vendor/account/currency/subsidiary/dimensions.
5. Store the secret JSON:
   `{ "accountId": "...", "clientId": "...", "certificateId": "...", "privateKeyPem": "...", "alg": "PS256" }`.
6. Populate `netsuite-config.json` with target-account internal ids. Use the `suiteql()`
   helper to look ids up.

## Idempotency

Live push uses:

```text
PUT /record/v1/{recordType}/eid:{externalId}
```

The durable transaction envelope records `recordType`, so replay uses the same NetSuite record
type originally built for the invoice.

## Sandbox Validation Checklist

- [ ] Confirm `vendorBill` `expense.items` is writable over REST in the target account.
- [ ] Confirm `vendorPrepayment` REST support, Vendor Prepayments feature, default prepayment
      account, and role permissions.
- [ ] Confirm `prepaymentPaymentAccountId` is a valid bank/credit-card funding account in the
      transaction currency.
- [ ] Confirm whether `tranId` is writable or auto-numbered.
- [ ] Confirm SuiteTax versus legacy tax behavior before sending per-line `taxCode`.
- [ ] Populate and validate recipient/business-unit routing.
- [ ] Confirm vendor, accounts, departments, classes, locations, and custom segments are shared
      with the resolved subsidiary in OneWorld.
- [ ] Decide whether PO invoices should be transformed from/matched to purchase orders instead
      of directly posted as expense bills.
- [ ] Compare extracted IBAN/BIC against the NetSuite vendor master before auto-booking.
- [ ] Validate duplicate handling for same vendor/invoice/amount retries, corrected invoices,
      reminders, and proformas.
- [ ] Build a companion SuiteScript RESTlet if original PDF attachment is required; REST Record
      API alone cannot upload file bytes.
- [ ] Keep `netSuiteLivePushEnabled` false until sandbox validation and credentials are complete.
