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

`assessInvoiceFlow` also raises an explicit `vat_not_validated` warning whenever a `taxId` was
extracted but the status isn't `VALID` (i.e. `SKIPPED`, `ERROR`, or `INVALID`) — a VAT lookup
that couldn't run or failed is not treated as equivalent to "no check needed"; both force
`NEEDS_REVIEW` the same as an invalid VAT would.

### Vendor VAT Registry Data (Admin Console)

The invoice detail drawer shows the full registry response used to validate the vendor's VAT
number — not just the pass/fail badge — whenever `vendor.vatValidation` is present and not
`SKIPPED`: provider, status, the officially registered name/address (`name`/`address` from
VIES, when the member state returns them), per-field match indicators
(name/street/postal code/city/company type: `VALID`/`INVALID`/`NOT_PROCESSED`), and the lookup
timestamp. This is the same data a future "push to NetSuite vendor master" feature would source
its fields from — today it's display-only; nothing writes it back to NetSuite automatically.

## Vendor Master Sync

When a logged NetSuite AP transaction is processed with live push enabled, the worker now performs
a conservative vendor-master compare before creating/updating the AP record:

1. Use the resolved vendor internal id from the transaction payload.
2. Fetch the NetSuite `vendor` record through the REST Record API.
3. Compare mapped extracted/VAT-validation fields against the current vendor record.
4. PATCH only fields that are blank in NetSuite, unless `vendorSync.missingOnly` is explicitly
   set to `false`.
5. Store the sync result on the durable NetSuite transaction as `vendorSyncResult`.

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
| `invoice.dueDate` / `paymentTerms` | `dueDate` / `terms` `{ id }` | terms via `termsByName`; unmapped terms are left unset **without a warning** — NetSuite applies the vendor record's own default terms when a bill omits the field, so an unmapped value isn't a review-worthy gap the way an unresolved vendor/currency/account is |
| `buyer.*` | `subsidiary`, header `department`/`class`/`location`, and business dimensions | routed through recipient/business-unit mapping; header dimensions matter because some OneWorld subsidiaries require `Department` as a mandatory body field, not just per line |
| `invoice.purchaseOrderNumber` / `invoice.purchaseOrderLookupKey` | warning or PO ref context | the printed PO is preserved; the lookup key is only for NetSuite matching |
| `lineItems[]` net amounts | `expense.items[]` | GL, department, class, location, and tax code are crosswalked, falling back to the resolved business unit's or the company-wide default account/dimensions |

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
- `apAccountId`
- `expenseAccountId`
- `customBodyFields`
- `customLineFields`

If `businessUnitSegmentFieldId` is configured, `businessUnitId` is emitted as `{ id }` on the
transaction body and expense lines. `defaultBusinessUnitKey` is used only after entity code,
tax id, company name, email domain, and address matching all miss. Missing recipient routing
with no fallback emits a NetSuite warning and keeps the invoice in review.

`apAccountId`/`expenseAccountId` override the company-wide `apAccountId`/`defaults.expenseAccountId`
for this specific business unit's subsidiary. GL accounts are frequently subsidiary-scoped in a
OneWorld account, so a single global default can be right for the subsidiary it was configured
against and wrong for every other one — a live push against a different subsidiary can fail with
`Invalid Field Value ... for the following field: account` if the account isn't shared with that
subsidiary. Two ways to resolve that, and it's a real design choice, not just a config gap:

- If the org wants **one shared chart of accounts**, fix it in NetSuite directly: share the
  account with the missing subsidiaries (Lists → Accounting → Chart of Accounts → edit →
  Subsidiary field; check Include Children if the subsidiaries roll up under a shared parent).
  The REST API does not support editing this field (`PATCH`/`DELETE` return 400/405 regardless of
  payload shape), so this has to be a NetSuite UI change.
- If subsidiaries **genuinely use different accounts** (common across different local GAAP or
  currencies), set `apAccountId`/`expenseAccountId` on that business unit's route instead.

Separately: NetSuite auto-generates a **system special AP account** per use (e.g. "Sys. Gen.
Accounts Payable") that resolves the vendor bill's AP posting automatically based on the vendor
and subsidiary. Don't set an explicit `apAccountId` override for this — leaving it unset and
letting NetSuite resolve it itself is the correct default; an explicit override can be rejected
even when the underlying system account would have worked fine on its own.

## Duplicate Invoice Handling

Duplicate detection hashes vendor, invoice number, currency, and gross total. A match creates a
`potential_duplicate` blocker and keeps the invoice in AP review by default.

Admins can save one of two invoice-level decisions from the detail drawer:

- `HOLD_FOR_REVIEW`: keep the duplicate blocker active. This is the default when no admin
  decision exists.
- `ALLOW_NETSUITE`: record who approved the duplicate and when, clear only the duplicate blocker,
  and allow the invoice to proceed if no other blockers or warnings remain.

The decision is stored on `extractedJson.meta.duplicateReview` and mirrored on the invoice row.
NetSuite preview and transaction logging both recompute the AP flow from the stored decision, so
a duplicate that is still held logs as `HELD_FOR_REVIEW`, while an allowed duplicate can be queued
when validation, configuration, and live-push settings permit it.

## Auto-Booking

`transformToNetSuite`/`validateNetSuiteRequest` are pure functions over already-loaded, non-secret
config — no NetSuite call needed to know whether an invoice *would* resolve cleanly. `extract.ts`
runs them inline right after VAT validation and duplicate detection (mirroring what the manual
"NetSuite Preview" action does), so `reviewStatus`/`autoBookEligible` reflect live crosswalk
resolution from the moment extraction finishes, not just extraction-quality signals.

When `NETSUITE_AUTO_BOOK_ENABLED` is set and `flow.autoBookEligible` is true (see the Auto-Booking
Criteria list in the main README), extraction itself logs and queues the NetSuite transaction —
tagged `bookingMode: "AUTO"` — with no button click. `autoBookEligible` now gates only on
blocker-severity flags (`flow.hasBlockingFlags`) plus a confidence threshold — the exact same bar
the manual "Approve & Send to NetSuite" button uses. A genuine duplicate or a hard NetSuite
validation failure (missing required field, e.g. an unresolved vendor entity) is the only thing
that holds an invoice back; warning-severity flags (PO not matched, GL account defaulted,
first-time vendor, VAT not yet validated) surface for AP visibility but no longer block the
automatic push. This was a deliberate loosening from an earlier, stricter "zero flags of any
kind" bar — see `flow.ts`'s `autoBookEligible` comment for the current rule.

The first-time-vendor signal (`firstTimeVendorHold` in `flow.ts`, checked via
`hasVendorBookingHistory` in `transactions.ts`) is informational only now — it no longer holds
the vendor's first transaction for manual approval, it just flags it (`first_time_vendor_auto_book_hold`,
warning severity) so AP can see it happened. The history check itself is unchanged: a bounded,
best-effort scan of recent transactions (not a dedicated index) — accurate at this app's current
scale, worth revisiting if transaction volume grows enough that "recent" stops covering a
vendor's true first transaction.

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

**NetSuite's upsert-by-external-id PUT does not reliably do a full sublist replace on a repeat
call for the same external ID** — observed directly in the sandbox: it appended a second copy of
the expense lines instead of replacing them, doubling the recorded total. This surfaces after a
client-side timeout on a request that actually completed on NetSuite's end (the abort races the
real response, so our side records `FAILED_PERMANENT` while NetSuite has already committed the
record). `upsertNetSuiteRecord` therefore does a `GET` on the same `eid:{externalId}` URL before
every `PUT`; if the record already exists, that's treated as already succeeded
(`UpsertResult.alreadyExisted: true`) and the `PUT` is skipped entirely, rather than trusting only
the DynamoDB transaction ledger's own status to decide whether a push is safe to (re)attempt.

If a duplicate does happen (e.g. from before this check existed), fix it directly in NetSuite —
the REST API does not support removing a sublist line either (`DELETE`/`PATCH` on a line
sub-resource return 405/404); a UI edit or void/recreate is the only path.

The transaction ledger also mirrors `netSuiteTransactionId`/`netSuiteTransactionStatus`/
`netSuiteBookingMode` onto the invoice row so both the manual approve endpoint
(`createNetSuiteTransactionIfNeeded` in `transactions.ts`) and the auto-book path share one
idempotency check. A transaction only blocks a fresh attempt while its status is genuinely live
(`QUEUED`/`IN_FLIGHT`/`SUCCEEDED`); a stale `HELD_FOR_REVIEW`/`HELD_FOR_CONFIGURATION`/`FAILED_*`
one is superseded by a new, freshly-validated attempt instead of blocking retries forever.

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
      with the resolved subsidiary in OneWorld. Don't assume a single company-wide
      `apAccountId`/`defaults.expenseAccountId` works for every subsidiary — check each real
      subsidiary a live invoice will route through, not just the one used to configure it.
- [ ] Confirm whether `Department` (and `Class`/`Location`) is a **mandatory body field** for the
      target subsidiary's vendor bill form, not just per expense line — some OneWorld
      configurations reject a bill with department set only on lines.
- [ ] Leave `apAccountId` unset for subsidiaries whose AP posting is handled by NetSuite's own
      system special account; only configure an explicit override where the account genuinely
      needs one.
- [ ] Deliberately test a retry (e.g. by replaying a transaction that already succeeded) and
      confirm it does not create duplicate expense lines in NetSuite — the check-before-upsert
      guard should make this a no-op, but verify against the actual target account.
- [ ] Decide whether PO invoices should be transformed from/matched to purchase orders instead
      of directly posted as expense bills.
- [ ] Compare extracted IBAN/BIC against the NetSuite vendor master before auto-booking.
- [ ] Validate duplicate handling for same vendor/invoice/amount retries, corrected invoices,
      reminders, and proformas.
- [ ] If enabling `netSuiteAutoBookEnabled`, confirm the crosswalk is populated enough that
      auto-booking isn't either a no-op (everything still holds on missing vendor/account
      config) or pushing invoices that need a human look — since only a duplicate or a hard
      NetSuite validation failure blocks it now, review what's actually landing in NetSuite
      unattended before relying on this for real vendor bills.
- [ ] Build a companion SuiteScript RESTlet if original PDF attachment is required; REST Record
      API alone cannot upload file bytes.
- [ ] Keep `netSuiteLivePushEnabled` false until sandbox validation and credentials are complete.
