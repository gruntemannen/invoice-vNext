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
  returns `{ netsuiteFormat, warnings, validation, originalExtraction }`. It builds and
  validates the vendor-bill payload but does **not** call NetSuite.
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
| `invoice.description` | `memo` | |
| (config) | `subsidiary` `{id}` | only when `subsidiaryId` is set (single-subsidiary) |
| `lineItems[]` (NET) | `expense.items[]` | `account`/`department`/`class`/`taxCode` resolved via crosswalks |

`invoice.totalAmount` is **gross**; line amounts are **net**. The transform posts net lines
and emits a **reconciliation warning** if `sum(net) + taxAmount ≠ totalAmount`.

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
   `accountsByCode`, `currenciesByCode`, `departmentsByCode`, `classesByCode`, `termsByName`)
   and `subsidiaryId` / `apAccountId` / `defaults` with the target account's internal ids.
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
- [ ] **Subsidiary** — single-subsidiary here; in a OneWorld account `subsidiary` is required
      and the vendor/accounts must be shared with it.
- [ ] **Source PDF attach** — REST cannot upload file bytes; attaching the original PDF needs a
      companion **SuiteScript RESTlet** (File Cabinet create + `record.attach`).
- [ ] **Auto-post gating** — hold low-confidence extractions for human review rather than
      auto-creating bills (a wrong vendor posts the liability against the wrong party).
