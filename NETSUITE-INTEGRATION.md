# NetSuite Integration

This system pushes emailed/uploaded invoices into **Oracle NetSuite** as Accounts Payable
**Vendor Bills**. The integration is **scaffolded**: the transform, validation, OAuth 2.0
client, SuiteQL resolver, and idempotent upsert are implemented and the API exposes an
**export-only** preview today; turning on live push is a credentials + sandbox-validation
step (see the checklist below).

> Decision of record: **true push, single-subsidiary, scaffold now / wire creds later.**

## How it works

```
PDF → Bedrock (Claude Sonnet 4.6, reads the PDF directly) → extracted JSON (DynamoDB)
     → transformToNetSuite() → vendorBill payload → (export preview today)
                                                  → (live: OAuth2 token → PUT eid:{externalId})
```

- **Endpoint (export-only):** `GET /invoices/{messageId}/{attachmentId}/netsuite`
  returns `{ netsuiteFormat, warnings, validation, flow, originalExtraction }`. It builds and
  validates the vendor-bill payload, folds validation/mapping issues into the AP `flow`
  decision, but does **not** call NetSuite.
- **Transaction endpoint:** `POST /invoices/{messageId}/{attachmentId}/netsuite/transactions`
  writes a durable DynamoDB outbox record before any push is queued. If live push is enabled
  and the invoice is ready, it queues a NetSuite worker message; otherwise the transaction is
  held for review/configuration and can be replayed later.
- **Replay endpoints:** `GET /netsuite/transactions`, `POST /netsuite/transactions/{transactionId}/replay`,
  and `POST /netsuite/transactions/replay?status=FAILED_RETRYABLE` support outage recovery.
- **Module:** [`backend/src/shared/netsuite.ts`](backend/src/shared/netsuite.ts) — pure,
  dependency-free (global `fetch` + `node:crypto`). Key exports: `transformToNetSuite`,
  `validateNetSuiteVendorBill`, `buildExternalId`, `getAccessToken`, `suiteql`,
  `upsertVendorBill`, `exampleNetSuiteConfig`.
- **Config:** [`backend/netsuite-config.json`](backend/netsuite-config.json) — non-secret
  crosswalks + defaults (see below).
- **Secret:** the CDK provisions a Secrets Manager secret `"<projectPrefix>/netsuite"`
  (`NETSUITE_SECRET_ARN` env on the API Lambda) for the OAuth 2.0 credentials.

## Field mapping (extracted JSON → vendorBill)

| Extracted | vendorBill | Notes |
|---|---|---|
| `vendor.taxId` / `vendor.name` | `entity` `{id}` | resolved via `vendorsByTaxId` then `vendorsByName`; unresolved → warning |
| `invoice.invoiceNumber` | `tranId` + `externalId` | `externalId` is the idempotency key |
| `invoice.invoiceDate` | `tranDate` | |
| `invoice.currency` | `currency` `{id}` | via `currenciesByCode` |
| `invoice.dueDate` / `paymentTerms` | `dueDate` / `terms` `{id}` | terms via `termsByName` |
| `invoice.description` / PO / service period | `memo` | preserves review context without inventing unsupported fields |
| `buyer.taxId` / `buyer.name` / config | `subsidiary` `{id}` | resolved via `subsidiariesByTaxId`, `subsidiariesByName`, then `subsidiaryId` fallback |
| `invoice.purchaseOrderNumber` | review warning | `purchaseOrdersByNumber` can map the PO id, but PO-backed bills should use a PO conversion / three-way-match flow |
| `lineItems[]` (NET) | `expense.items[]` | `account`/`department`/`class`/`taxCode` resolved via crosswalks; a summary line is created from `netAmount` when no lines are extracted |

`invoice.totalAmount` is **gross**; line amounts are **net**. The transform posts net lines
and emits a **reconciliation warning** if `sum(net) + taxAmount != totalAmount`.

## AP flow controls

Extraction stores AP review metadata on each invoice record:

- `reviewStatus`: `READY_FOR_NETSUITE` or `NEEDS_REVIEW`
- `controlFlags`: low confidence, missing required fields, potential duplicate, PO match required,
  non-standard document type, buyer/entity routing gap, and bank details captured for vendor-master verification
- `duplicateKey`: hash of vendor + invoice number + currency + gross total, indexed by DynamoDB GSI `duplicate`
- `autoBookEligible`: true only for high-confidence records with no warning/blocking flags

The NetSuite preview recalculates `flow` with transform warnings and validation errors included, so
unresolved vendor/subsidiary/currency/account mappings keep the invoice in review even when extraction was successful.

## Durable outbox and replay

NetSuite pushes use a database-first outbox:

1. The API builds the vendor-bill payload and writes a `NETSUITE_TRANSACTION` item to DynamoDB.
2. Only after the transaction is logged does the API enqueue the NetSuite worker.
3. The worker marks the transaction `IN_FLIGHT`, calls NetSuite by idempotent `externalId`, then records `SUCCEEDED`, `FAILED_RETRYABLE`, or `FAILED_PERMANENT`.
4. Every attempt appends an event to the transaction record with timestamp, status, and error/location details.
5. Retryable outage failures remain queryable and replayable even if the SQS message later lands in the NetSuite DLQ.

Transaction statuses:

- `HELD_FOR_REVIEW`: extracted or mapped data is not ready for NetSuite.
- `HELD_FOR_CONFIGURATION`: live push is disabled; the transaction is logged for later replay.
- `QUEUED`: logged and queued for the NetSuite worker.
- `IN_FLIGHT`: worker attempt is active.
- `SUCCEEDED`: NetSuite upsert completed.
- `FAILED_RETRYABLE`: outage/rate-limit/network/server failure; safe to replay.
- `FAILED_PERMANENT`: validation/auth/client failure that needs correction before replay.

Live push is controlled by `infra/lib/config.ts` (`netSuiteLivePushEnabled`). Keep it `false`
until sandbox validation and NetSuite credentials are complete; transaction logging still works.

## NetSuite account setup (for live push)

1. **Enable features:** Setup → Company → Enable Features → SuiteCloud → **REST Web Services**
   and **OAuth 2.0** (accept the SuiteCloud Terms of Service).
2. **Integration record:** Setup → Integration → Manage Integrations → New. Enable OAuth 2.0
   client credentials; upload the **public certificate** (note the **Certificate ID**).
3. **Role:** create a least-privilege role with **REST Web Services** (Full) and
   **"Log in using OAuth 2.0 Access Tokens"** (Full) — **NOT** the Token-Based Authentication
   permission (that is OAuth 1.0/TBA and will not authorize this flow). Add Vendor Bill
   create/edit + vendor/account/currency view.
4. **Secret value** (`NETSUITE_SECRET_ARN`): JSON
   `{ "accountId": "...", "clientId": "...", "certificateId": "...", "privateKeyPem": "...", "alg": "PS256" }`.
5. **Config** (`netsuite-config.json`): populate the crosswalks (`vendorsByTaxId`,
   `vendorsByName`, `subsidiariesByTaxId`, `subsidiariesByName`, `accountsByCode`,
   `currenciesByCode`, `departmentsByCode`, `classesByCode`, `termsByName`,
   `purchaseOrdersByNumber`) and `subsidiaryId` / `apAccountId` / `defaults.expenseAccountId`
   with the target account's internal ids.
   Use the `suiteql()` helper to look ids up.

## Idempotency

Live push uses `PUT .../record/v1/vendorBill/eid:{externalId}` (upsert by external id), so SQS
redeliveries / retries with the same `externalId` update rather than duplicate the bill. Pair
this with a DynamoDB conditional state transition when wiring the worker.

## Sandbox-validation checklist (before enabling live push)

These were flagged uncertain by research and **must be confirmed against the target account**
(see `TODO(sandbox)` markers in `netsuite.ts`):

- [ ] **Tax engine** — per-line `taxCode` is honored only under **SuiteTax**; on legacy tax it
      is ignored/rejected. Decide tax-exclusive posting vs SuiteTax.
- [ ] **Expense sublist over REST** — exposure depends on Accounting Preferences; if AP only
      accepts the `item` sublist over REST, switch line mapping.
- [ ] **`tranId`** — may be read-only/auto-numbered; if rejected, rely on `externalId` only.
- [ ] **Subsidiary/entity routing** — in a OneWorld account `subsidiary` is required and
      the vendor/accounts must be shared with it. Populate `subsidiariesByTaxId/name` for
      the buyer legal entities, or set `subsidiaryId` only for a true single-subsidiary flow.
- [ ] **PO-backed invoices** — if `purchaseOrderNumber` is present, validate whether the
      account should convert/match the PO before saving a bill rather than posting a direct
      expense vendor bill.
- [ ] **Vendor bank verification** — extraction captures IBAN/BIC values, but live push
      should compare them against the NetSuite vendor master before auto-booking.
- [ ] **Duplicate behavior** — validate the DynamoDB `duplicate` index and AP handling for
      same vendor/invoice/amount retries, corrected invoices, and reminders.
- [ ] **Source PDF attach** — REST cannot upload file bytes; attaching the original PDF needs a
      companion **SuiteScript RESTlet** (File Cabinet create + `record.attach`).
- [ ] **Auto-post gating** — hold low-confidence extractions for human review rather than
      auto-creating bills (a wrong vendor posts the liability against the wrong party).
