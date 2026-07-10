# NetSuite Integration

This system pushes emailed/uploaded invoices into Oracle NetSuite as AP transactions.
Standard payable invoices map to `vendorBill`; proforma invoices map to
`vendorPrepayment` because they are prepayment requests, not final AP vendor bills.

The integration includes transform, validation, OAuth 2.0 client, SuiteQL resolver, durable
outbox, replay, and idempotent upsert. Live push stays disabled by default until credentials
and sandbox validation are complete.

## Vendor VAT Enrichment

During extraction, supported vendor VAT numbers are checked and stored on
`extractedJson.vendor.vatValidation`, with a compact copy on
`extractedJson.meta.vendorVatValidation`.

Supported validators:

- `EU_VIES`: validates EU and Northern Ireland VAT IDs through the European Commission VIES API.
  The parser accepts prefixed VAT IDs such as `DE123456789`, maps Greece `GR` to VIES `EL`, can
  infer a country from the vendor address when only local VAT digits were extracted, and sends
  extracted vendor name/address fields for approximate matching.
- `CH_UID`: validates Swiss `CHE-###.###.### MWST/TVA/IVA` IDs. The parser normalizes the UID,
  checks the UID checksum locally, then calls the Swiss UID PublicServices `ValidateVatNumber`
  SOAP endpoint.

Both validators return the same status model: `VALID`, `INVALID`, `SKIPPED`, or `ERROR`.
Unsupported tax IDs are skipped with metadata. Lookup outages/timeouts are logged and stored as
metadata, but they do not fail extraction or prevent later NetSuite replay. Review warnings are
raised for invalid VATs or explicit registry match mismatches.

## Vendor Master Approval Workflow

When a completed invoice has a resolved vendor internal ID, the worker performs a conservative,
read-only vendor-master comparison independently of whether the invoice itself is ready to post:

1. Use the resolved vendor internal id from the transaction payload.
2. Fetch the NetSuite `vendor` record through the REST Record API.
3. Compare mapped extracted/VAT-validation fields against the current vendor record.
4. Store differences as a `VENDOR_MASTER_APPROVAL` item containing current and proposed values.
5. Wait for an authenticated admin to approve or reject the proposal in the UI.
6. After approval, queue the durable operation and PATCH the vendor. Rejected proposals are never
   sent and remain visible as audit history.

Only blank NetSuite fields are proposed unless `vendorSync.missingOnly` is explicitly `false`.

The default map only fills standard `companyName` and `email`. VAT and bank details vary by
NetSuite account, so map those to account-specific entity/custom fields in
`vendorSync.fields` before enabling live updates, for example:

```json
"vendorSync": {
  "enabled": true,
  "recordId": "vendor",
  "missingOnly": true,
  "fields": {
    "name": "companyName",
    "email": "email",
    "taxId": "custentity_vendor_vat_id",
    "iban": "custentity_vendor_iban",
    "bic": "custentity_vendor_bic",
    "vatValidationStatus": "custentity_vendor_vat_status",
    "vatRequestIdentifier": "custentity_vendor_vat_request_id"
  }
}
```

## How It Works

```text
PDF/email/upload
  -> Bedrock extraction
  -> EU VIES or Swiss UID VAT validation
  -> duplicate lookup + AP control flags
  -> DynamoDB invoice record
  -> transformToNetSuite()
  -> NetSuite push envelope
       recordType: vendorBill | vendorPrepayment
       payload: clean NetSuite REST body
  -> deterministic durable transaction outbox
       ready -> optional live worker push by externalId
       review -> held, never pushed by replay
  -> read-only vendor comparison
       changes -> admin approval queue -> approved PATCH
```

- `GET /invoices/{messageId}/{attachmentId}/netsuite` returns
  `{ netsuiteFormat, netSuiteRequest, warnings, configurationHints, validation, flow, originalExtraction }`.
- `netsuiteFormat` is the clean REST body.
- `netSuiteRequest` is the durable schema envelope with `schemaVersion`, `recordType`,
  `externalId`, document classification, business-unit routing, and payload.
- `configurationHints` lists the exact `netsuite-config.json` paths that need NetSuite
  internal IDs before live push can be enabled.
- Extraction automatically writes the transaction ledger record before any NetSuite call is
  queued. `POST /invoices/{messageId}/{attachmentId}/netsuite/transactions` returns or refreshes
  that deterministic record rather than creating duplicates.
- `GET /approvals?status=PENDING` returns duplicate and vendor-master approvals.
- `POST /approvals/{approvalId}/decision` stores the reviewer decision and queues an approved
  vendor update or recalculates an approved duplicate invoice.
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
| `invoice.purchaseOrderNumber` / `invoice.purchaseOrderLookupKey` | warning or PO ref context | the printed PO is preserved; the lookup key is only for NetSuite matching |
| `lineItems[]` net amounts | `expense.items[]` | GL, department, class, location, and tax code are crosswalked |

`invoice.totalAmount` is gross. Expense lines are net. The transform warns when
`sum(line net) + taxAmount != totalAmount`. If a PO is present, the transform does not alter the
invoice PO number. It may use `purchaseOrderLookupKey` for crosswalk lookup and emits a warning so
AP can decide whether the invoice belongs in a PO-backed bill or three-way-match flow.

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

Company-name mapping is also exposed in code as `mapCompanyNameToBusinessUnit(companyName, config)`.
It resolves through `crosswalks.businessUnitsByName`, then falls back to `defaultBusinessUnitKey`
when that fallback is configured.

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
transaction body and expense lines. `defaultBusinessUnitKey` is used only after entity code,
tax id, company name, email domain, and address matching all miss. Missing recipient routing
with no fallback emits a NetSuite warning and keeps the invoice in review.

## Duplicate Invoice Handling

Duplicate detection hashes vendor, invoice number, currency, and gross total. A match creates a
`potential_duplicate` blocker and keeps the invoice in AP review by default.

Every detected duplicate creates a pending item in the shared approval queue. Admins can make one
of two final decisions from the queue or invoice detail:

- `REJECT_NETSUITE`: keep the blocker active permanently and record that the duplicate must not
  be sent to NetSuite.
- `ALLOW_NETSUITE`: record who approved the duplicate and when, clear only the duplicate blocker,
  and allow the invoice to proceed if no other blockers or warnings remain.

Before a decision, the invoice remains `HOLD_FOR_REVIEW`. The decision, reviewer, timestamp, and
note are stored on `extractedJson.meta.duplicateReview` and in the approval record. Approval
refreshes the existing outbox payload and recomputes every AP control; it does not bypass PO,
mapping, validation, or other warnings. `HELD_FOR_REVIEW` transactions cannot be submitted through
the replay endpoint, so rejected and undecided duplicates remain blocked.

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
- review `vendorSync.fields` for the target account; keep only fields that are writable on the NetSuite vendor REST record
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

NetSuite pushes are database-first and autonomous:

1. Extraction builds the NetSuite push envelope.
2. Extraction writes one deterministic `NETSUITE_TRANSACTION` item to DynamoDB.
3. Only after the transaction is logged, and only when all controls pass, is the worker queued.
4. The worker marks the transaction `IN_FLIGHT`, calls NetSuite by idempotent `externalId`,
   then records `SUCCEEDED`, `FAILED_RETRYABLE`, or `FAILED_PERMANENT`.
5. Retryable outage failures remain queryable and replayable even if SQS later DLQs the message.

Transaction statuses:

- `HELD_FOR_REVIEW`: extracted or mapped data is not ready for NetSuite; direct replay is blocked.
- `HELD_FOR_CONFIGURATION`: live push is disabled; transaction is logged for later replay.
- `QUEUED`: logged and queued.
- `IN_FLIGHT`: worker attempt is active.
- `SUCCEEDED`: NetSuite upsert completed.
- `FAILED_RETRYABLE`: outage/rate-limit/network/server failure; safe to replay.
- `FAILED_PERMANENT`: validation/auth/client failure that must be corrected and revalidated.

Approval records use `PENDING`, `APPROVED`, `REJECTED`, `APPLYING`, `APPLIED`,
`FAILED_RETRYABLE`, and `FAILED_PERMANENT`. Only approved vendor changes are writable operations.

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
