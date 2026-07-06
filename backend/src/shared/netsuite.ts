/**
 * NetSuite Vendor Bill Push Integration
 *
 * Replaces the legacy Oracle Fusion transform. The decision of record is:
 *   "true push, single-subsidiary, scaffold now / wire creds later."
 *
 * This module:
 *   - Transforms extracted invoice JSON -> NetSuite REST AP transaction payload.
 *   - Resolves header/line references via configurable crosswalks.
 *   - Implements an OAuth 2.0 M2M (client-credentials + JWT client-assertion)
 *     token client, a SuiteQL resolver helper, and an idempotent upsert by
 *     external id.
 *
 * IMPORTANT (export-only for now): the API handler is EXPORT-ONLY. We build and
 * validate the payload but do NOT call getAccessToken / suiteql / upsertVendorBill
 * until real credentials and a sandbox account are wired in. The live-push
 * functions are implemented and ready but intentionally not invoked from api.ts.
 *
 * Constraints honored:
 *   - Compiles under `strict` tsc.
 *   - No new npm deps: uses only the global fetch and node:crypto.
 *   - Does NOT import any @aws-sdk package.
 *
 * ---------------------------------------------------------------------------
 * NetSuite role / auth note:
 *   The integration role MUST have the permission "Log in using OAuth 2.0
 *   Access Tokens" (Setup > Access). This is DIFFERENT from the older
 *   "Token-Based Authentication" (TBA) permission used for OAuth 1.0 — do NOT
 *   grant TBA for this flow; the client-credentials JWT flow needs the OAuth 2.0
 *   permission instead.
 * ---------------------------------------------------------------------------
 */

import { createSign, randomUUID } from "node:crypto";

// ===========================================================================
// Secret + configuration types
// ===========================================================================

/**
 * Credentials material. Loaded at runtime from a secrets store (Secrets Manager,
 * SSM, etc.) — intentionally not bundled in config JSON.
 *
 * - certificateId: the NetSuite-issued "Certificate ID" (kid) for the mapped
 *   client certificate, used as the JWT header `kid`.
 * - privateKeyPem: the PEM private key that matches the uploaded certificate.
 * - alg: signing algorithm. NetSuite accepts PS256/RS256 (RSA) or ES256 (EC).
 */
export interface NetSuiteSecret {
  accountId: string;
  clientId: string;
  certificateId: string;
  privateKeyPem: string;
  alg: "PS256" | "RS256" | "ES256";
}

/**
 * Non-secret configuration: defaults + crosswalks that map the extractor's
 * human-readable codes/names to NetSuite internal ids.
 *
 * subsidiaryId is optional because this scaffold targets a SINGLE subsidiary.
 * TODO(sandbox): in a OneWorld account, subsidiary IS required on the vendor
 * bill AND the chosen vendor/accounts must be shared with that subsidiary, or
 * the upsert fails. In a non-OneWorld account there is no subsidiary field at
 * all — leave subsidiaryId unset so we never emit the ref. Confirm which kind
 * of account the sandbox is before turning on live push.
 */
export interface NetSuiteConfig {
  subsidiaryId?: string;
  apAccountId?: string;
  /**
   * NetSuite vendor prepayment funding account (bank or credit card account).
   * Required before a proforma invoice can be pushed as a vendorPrepayment.
   */
  prepaymentPaymentAccountId?: string;
  /** Optional vendor prepayment asset account override. */
  prepaymentAccountId?: string;
  /**
   * Optional custom segment field used for recipient -> business-unit routing,
   * e.g. "cseg_business_unit". If set, the resolved businessUnitId is emitted
   * on the transaction body and expense lines as { id }.
   */
  businessUnitSegmentFieldId?: string;
  defaults?: {
    expenseAccountId?: string;
    departmentId?: string;
    classId?: string;
    locationId?: string;
    taxCodeId?: string;
  };
  crosswalks: {
    vendorsByTaxId: Record<string, string>;
    vendorsByName: Record<string, string>;
    accountsByCode: Record<string, string>;
    currenciesByCode: Record<string, string>;
    departmentsByCode: Record<string, string>;
    classesByCode: Record<string, string>;
    termsByName: Record<string, string>;
    subsidiariesByTaxId?: Record<string, string>;
    subsidiariesByName?: Record<string, string>;
    purchaseOrdersByNumber?: Record<string, string>;
    businessUnitsByTaxId?: Record<string, string>;
    businessUnitsByName?: Record<string, string>;
    businessUnitsByEntityCode?: Record<string, string>;
    businessUnitsByEmailDomain?: Record<string, string>;
    businessUnitsByAddressContains?: Record<string, string>;
  };
  businessUnits?: Record<string, NetSuiteBusinessUnitRoute>;
}

export type NetSuiteCustomFieldValue = string | number | boolean | NetSuiteRef;

export interface NetSuiteBusinessUnitRoute {
  /** NetSuite internal id for the business-unit custom segment, if used. */
  businessUnitId?: string;
  businessUnitName?: string;
  subsidiaryId?: string;
  departmentId?: string;
  classId?: string;
  locationId?: string;
  customBodyFields?: Record<string, NetSuiteCustomFieldValue>;
  customLineFields?: Record<string, NetSuiteCustomFieldValue>;
}

export interface NetSuiteBusinessUnitRoutingResult extends NetSuiteBusinessUnitRoute {
  businessUnitKey: string;
  matchedBy: "buyer.entityCode" | "buyer.taxId" | "buyer.name" | "buyer.emailDomain" | "buyer.address";
  matchedValue: string;
}

// ===========================================================================
// REST vendorBill payload types
//
// In the NetSuite REST Record API, every reference field (entity, subsidiary,
// currency, account, department, class, location, terms, taxCode) is an OBJECT
// of shape { id: string } (the internal id). The expense sublist is wrapped as
// { expense: { items: ExpenseLine[] } }.
// ===========================================================================

/** A reference to another NetSuite record by internal id. */
export interface NetSuiteRef {
  id: string;
}

/**
 * One row of the vendor bill "expense" sublist (the non-item / GL-coded
 * expenses path). We use the expense sublist rather than the item sublist
 * because extracted invoices are GL-coded, not PO/item-matched.
 *
 * TODO(sandbox): whether the `expense` sublist is exposed over REST depends on
 * the account's Accounting Preferences. If "Expenses & Items" is OFF for AP, a
 * vendor bill may only accept the `item` sublist over REST and POSTing
 * `expense.items` returns an error. Verify the sublist is writable in the
 * sandbox; if not, we must switch to the `item` sublist (different field names).
 */
export interface ExpenseLine {
  account?: NetSuiteRef;
  amount: number;
  memo?: string;
  // TODO(sandbox): the line dimension field is `department` on the expense
  // sublist in most accounts, but some surface it as a custom column. Confirm
  // exact REST field names in the sandbox (e.g. `class` vs `costCenter`,
  // `department` vs `cseg*` custom segments).
  department?: NetSuiteRef;
  class?: NetSuiteRef;
  location?: NetSuiteRef;
  // TODO(sandbox): per-line `taxCode` is only honored when SuiteTax is enabled.
  // On legacy (non-SuiteTax) accounts the tax code lives elsewhere and this
  // field is ignored or rejected. See header note below.
  taxCode?: NetSuiteRef;
}

/** The wrapped expense sublist as required by the REST record API. */
export interface ExpenseSublist {
  items: ExpenseLine[];
}

/**
 * The vendor bill header. All ref fields are { id } objects. tranId is the
 * human-facing bill number.
 *
 * TODO(sandbox): `tranId` may be READ-ONLY / auto-numbered. If "Auto-Generated
 * Numbers" is enabled for Vendor Bills, NetSuite ignores or rejects a supplied
 * tranId. In that case rely solely on externalId for our reference and drop
 * tranId from the payload. Verify in the sandbox.
 */
export interface VendorBill {
  externalId: string;
  tranId?: string;
  tranDate?: string;
  dueDate?: string;
  memo?: string;
  entity?: NetSuiteRef; // the vendor
  subsidiary?: NetSuiteRef;
  currency?: NetSuiteRef;
  terms?: NetSuiteRef;
  account?: NetSuiteRef; // AP account
  // TODO(sandbox): header-level `taxCode` / SuiteTax `taxDetails` — only one of
  // the two models applies depending on whether SuiteTax is installed. We emit
  // neither at the header today; reconciliation is surfaced as a warning instead.
  expense?: ExpenseSublist;
}

/**
 * NetSuite vendor prepayment payload. Proforma invoices are treated as
 * prepayment requests rather than AP vendor bills because they normally precede
 * delivery/final invoicing and should debit a prepayment asset account instead
 * of booking AP expense immediately.
 */
export interface VendorPrepayment {
  externalId: string;
  tranId?: string;
  tranDate?: string;
  memo?: string;
  entity?: NetSuiteRef; // the vendor/payee
  subsidiary?: NetSuiteRef;
  currency?: NetSuiteRef;
  /** Funding bank or credit-card account. Required by NetSuite. */
  account?: NetSuiteRef;
  /** Optional prepayment asset account override. */
  prepaymentAccount?: NetSuiteRef;
  payment: number;
  department?: NetSuiteRef;
  class?: NetSuiteRef;
  location?: NetSuiteRef;
  purchaseOrder?: NetSuiteRef;
}

export type NetSuiteRecordType = "vendorBill" | "vendorPrepayment";
export type NetSuiteTransactionIntent = "vendor_bill" | "vendor_prepayment";
export type NetSuiteRecordPayload = VendorBill | VendorPrepayment;

export interface NetSuiteDocumentClassification {
  invoiceType?: string;
  transactionIntent: NetSuiteTransactionIntent;
  isProforma: boolean;
}

/**
 * Durable push envelope stored in the transaction ledger. The envelope lets the
 * worker route different NetSuite records while keeping the actual REST body
 * clean under `payload`.
 */
export interface NetSuitePushRequest {
  schemaVersion: "netsuite-ap-v1";
  recordType: NetSuiteRecordType;
  restRecordId: NetSuiteRecordType;
  operation: "upsertByExternalId";
  externalId: string;
  document: NetSuiteDocumentClassification;
  businessUnitRouting?: NetSuiteBusinessUnitRoutingResult;
  payload: NetSuiteRecordPayload;
}

export interface NetSuiteConfigurationHint {
  path: string;
  value: string;
  reason: string;
  requiredForLivePush: boolean;
  example?: unknown;
}

// ===========================================================================
// External id
// ===========================================================================

const EXTERNAL_ID_MAX = 80;

function sanitizeIdPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Deterministic external id used as the idempotency key for upsert.
 *
 * Prefers INV-{vendor}-{invoiceNumber}; falls back to meta.messageId. Always
 * sanitized to [A-Za-z0-9_-] and length-capped so it is safe in the
 * `eid:{externalId}` URL segment.
 */
export function buildExternalId(extracted: any): string {
  const vendorName: string = extracted?.vendor?.name ?? "";
  const invoiceNumber: string = extracted?.invoice?.invoiceNumber ?? "";
  const messageId: string = extracted?.meta?.messageId ?? "";

  let raw: string;
  if (invoiceNumber) {
    const vendorPart = sanitizeIdPart(vendorName).slice(0, 24);
    const invoicePart = sanitizeIdPart(invoiceNumber);
    raw = `INV-${vendorPart ? vendorPart + "-" : ""}${invoicePart}`;
  } else if (messageId) {
    raw = `MSG-${sanitizeIdPart(messageId)}`;
  } else {
    raw = `INV-${randomUUID()}`;
  }

  const cleaned = sanitizeIdPart(raw).slice(0, EXTERNAL_ID_MAX);
  return cleaned || `INV-${randomUUID()}`.slice(0, EXTERNAL_ID_MAX);
}

// ===========================================================================
// Transform
// ===========================================================================

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function buildExpenseSourceLines(lineItems: any[], invoice: any, warnings: string[]): any[] {
  if (lineItems.length > 0) return lineItems;

  const taxAmount = round2(toNumber(invoice?.taxAmount));
  const netAmount = round2(toNumber(invoice?.netAmount));
  const grossAmount = round2(toNumber(invoice?.totalAmount));
  const fallbackAmount = netAmount > 0 ? netAmount : round2(grossAmount - taxAmount);

  if (fallbackAmount > 0) {
    warnings.push(
      "No line items found; created one summary expense line from the invoice net amount."
    );
    return [
      {
        lineNumber: 1,
        description: invoice?.description ?? "Invoice total",
        amount: fallbackAmount,
      },
    ];
  }

  return [];
}

function buildMemo(invoice: any): string {
  const parts = [
    invoice?.description,
    invoice?.purchaseOrderNumber ? `PO ${invoice.purchaseOrderNumber}` : null,
    invoice?.servicePeriod?.startDate || invoice?.servicePeriod?.endDate
      ? `Service period ${invoice?.servicePeriod?.startDate ?? "?"} to ${invoice?.servicePeriod?.endDate ?? "?"}`
      : null,
    invoice?.remittanceReference ? `Payment ref ${invoice.remittanceReference}` : null,
  ]
    .filter(Boolean)
    .map((part) => String(part).trim())
    .filter(Boolean);

  return parts.join(" | ").slice(0, 999);
}

function isProformaInvoice(invoice: any): boolean {
  const invoiceType = String(invoice?.invoiceType ?? "").trim();
  const intent = String(invoice?.transactionIntent ?? "").trim();
  return /pro\s*forma|proforma/i.test(invoiceType) || /prepayment/i.test(intent);
}

function classifyDocument(invoice: any): NetSuiteDocumentClassification {
  const proforma = isProformaInvoice(invoice);
  return {
    invoiceType: invoice?.invoiceType ? String(invoice.invoiceType) : undefined,
    transactionIntent: proforma ? "vendor_prepayment" : "vendor_bill",
    isProforma: proforma,
  };
}

function asRef(id: string | undefined): NetSuiteRef | undefined {
  return id ? { id } : undefined;
}

function normalizeLookup(value: unknown): string {
  const text =
    value && typeof value === "object"
      ? Object.values(value as Record<string, unknown>).join(" ")
      : String(value ?? "");
  return text
    .normalize("NFKD")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function lookupCrosswalk(map: Record<string, string> | undefined, value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw || !map) return undefined;
  if (map[raw]) return map[raw];
  const wanted = normalizeLookup(raw);
  const found = Object.entries(map).find(([key]) => normalizeLookup(key) === wanted);
  return found?.[1];
}

function emailDomain(email: unknown): string {
  const match = String(email ?? "").trim().toLowerCase().match(/@([^@\s>]+)>?$/);
  return match?.[1] ?? "";
}

function resolveBusinessUnitRouting(
  buyer: any,
  config: NetSuiteConfig,
  warnings: string[]
): NetSuiteBusinessUnitRoutingResult | undefined {
  const cw = config.crosswalks;
  const checks: Array<{
    matchedBy: NetSuiteBusinessUnitRoutingResult["matchedBy"];
    value: string;
    routeKey?: string;
  }> = [
    {
      matchedBy: "buyer.entityCode",
      value: String(buyer?.entityCode ?? "").trim(),
      routeKey: lookupCrosswalk(cw.businessUnitsByEntityCode, buyer?.entityCode),
    },
    {
      matchedBy: "buyer.taxId",
      value: String(buyer?.taxId ?? "").trim(),
      routeKey: lookupCrosswalk(cw.businessUnitsByTaxId, buyer?.taxId),
    },
    {
      matchedBy: "buyer.name",
      value: String(buyer?.name ?? "").trim(),
      routeKey: lookupCrosswalk(cw.businessUnitsByName, buyer?.name),
    },
    {
      matchedBy: "buyer.emailDomain",
      value: emailDomain(buyer?.email),
      routeKey: lookupCrosswalk(cw.businessUnitsByEmailDomain, emailDomain(buyer?.email)),
    },
  ];

  const address = normalizeLookup(buyer?.address);
  if (address && cw.businessUnitsByAddressContains) {
    const addressMatch = Object.entries(cw.businessUnitsByAddressContains).find(([needle]) =>
      address.includes(normalizeLookup(needle))
    );
    if (addressMatch) {
      checks.push({
        matchedBy: "buyer.address",
        value: addressMatch[0],
        routeKey: addressMatch[1],
      });
    }
  }

  const match = checks.find((candidate) => candidate.value && candidate.routeKey);
  if (!match?.routeKey) {
    if (buyer?.name || buyer?.taxId || buyer?.entityCode || buyer?.email || buyer?.address) {
      warnings.push(
        "Invoice recipient did not match any NetSuite business-unit routing crosswalk; subsidiary/business-unit dimensions require review."
      );
    }
    return undefined;
  }

  const configuredRoute = config.businessUnits?.[match.routeKey];
  const route: NetSuiteBusinessUnitRoute = configuredRoute ?? { businessUnitId: match.routeKey };
  if (!configuredRoute) {
    warnings.push(
      `Recipient matched business unit key "${match.routeKey}", but businessUnits.${match.routeKey} is not configured; only the key is recorded.`
    );
  }

  return {
    ...route,
    businessUnitKey: match.routeKey,
    matchedBy: match.matchedBy,
    matchedValue: match.value,
  };
}

function refCustomFields(
  fields: Record<string, NetSuiteCustomFieldValue> | undefined
): Record<string, NetSuiteCustomFieldValue> {
  return fields ? { ...fields } : {};
}

function applyCustomFields(target: Record<string, unknown>, fields?: Record<string, NetSuiteCustomFieldValue>) {
  for (const [fieldId, value] of Object.entries(refCustomFields(fields))) {
    if (value === undefined || value === null || value === "") continue;
    target[fieldId] = value;
  }
}

function applyBusinessUnitSegment(
  target: Record<string, unknown>,
  config: NetSuiteConfig,
  route?: NetSuiteBusinessUnitRoutingResult
) {
  if (!route?.businessUnitId || !config.businessUnitSegmentFieldId) return;
  target[config.businessUnitSegmentFieldId] = { id: route.businessUnitId };
}

function configKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function hasMapping(map: Record<string, string> | undefined, value: unknown): boolean {
  return Boolean(lookupCrosswalk(map, value));
}

export function buildNetSuiteConfigurationHints(
  extracted: any,
  config: NetSuiteConfig
): NetSuiteConfigurationHint[] {
  const hints: NetSuiteConfigurationHint[] = [];
  const cw = config.crosswalks;
  const vendor = extracted?.vendor ?? {};
  const buyer = extracted?.buyer ?? {};
  const invoice = extracted?.invoice ?? {};
  const lines: any[] = Array.isArray(extracted?.lineItems) ? extracted.lineItems : [];

  const vendorTaxId = String(vendor?.taxId ?? "").trim();
  const vendorName = String(vendor?.name ?? "").trim();
  if (
    (vendorTaxId || vendorName) &&
    !hasMapping(cw.vendorsByTaxId, vendorTaxId) &&
    !hasMapping(cw.vendorsByName, vendorName)
  ) {
    hints.push({
      path: vendorTaxId
        ? `crosswalks.vendorsByTaxId["${configKey(vendorTaxId)}"]`
        : `crosswalks.vendorsByName["${configKey(vendorName)}"]`,
      value: vendorTaxId || vendorName,
      reason: "Map the invoice issuer to the NetSuite vendor internal id.",
      requiredForLivePush: true,
      example: "<vendorInternalId>",
    });
  }

  const currency = String(invoice?.currency ?? "").trim();
  if (currency && !hasMapping(cw.currenciesByCode, currency)) {
    hints.push({
      path: `crosswalks.currenciesByCode["${configKey(currency)}"]`,
      value: currency,
      reason: "Map invoice currency to the NetSuite currency internal id.",
      requiredForLivePush: true,
      example: "<currencyInternalId>",
    });
  }

  const paymentTerms = String(invoice?.paymentTerms ?? "").trim();
  if (paymentTerms && !hasMapping(cw.termsByName, paymentTerms)) {
    hints.push({
      path: `crosswalks.termsByName["${configKey(paymentTerms)}"]`,
      value: paymentTerms,
      reason: "Map extracted payment terms to the NetSuite terms internal id, or normalize the extractor output to an existing NetSuite term name.",
      requiredForLivePush: false,
      example: "<termsInternalId>",
    });
  }

  const buyerTaxId = String(buyer?.taxId ?? "").trim();
  const buyerName = String(buyer?.name ?? "").trim();
  const buyerEntityCode = String(buyer?.entityCode ?? "").trim();
  const buyerDomain = emailDomain(buyer?.email);
  const routeResolved = Boolean(resolveBusinessUnitRouting(buyer, config, []));
  const subsidiaryResolved =
    routeResolved ||
    hasMapping(cw.subsidiariesByTaxId, buyerTaxId) ||
    hasMapping(cw.subsidiariesByName, buyerName) ||
    Boolean(config.subsidiaryId);
  if ((buyerTaxId || buyerName || buyerEntityCode || buyerDomain) && !subsidiaryResolved) {
    const path =
      buyerEntityCode
        ? `crosswalks.businessUnitsByEntityCode["${configKey(buyerEntityCode)}"]`
        : buyerTaxId
          ? `crosswalks.businessUnitsByTaxId["${configKey(buyerTaxId)}"]`
          : buyerDomain
            ? `crosswalks.businessUnitsByEmailDomain["${configKey(buyerDomain)}"]`
            : `crosswalks.businessUnitsByName["${configKey(buyerName)}"]`;
    const value = buyerEntityCode || buyerTaxId || buyerDomain || buyerName;
    const businessUnitKey = normalizeLookup(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    hints.push({
      path,
      value,
      reason: "Map the invoice recipient to a configured NetSuite business unit/subsidiary route.",
      requiredForLivePush: true,
      example: businessUnitKey || "<businessUnitKey>",
    });
    hints.push({
      path: `businessUnits["${businessUnitKey || "<businessUnitKey>"}"]`,
      value: buyerName || value,
      reason: "Define the NetSuite subsidiary and dimensions for the recipient route.",
      requiredForLivePush: true,
      example: {
        subsidiaryId: "<subsidiaryInternalId>",
        departmentId: "<departmentInternalId>",
        classId: "<classInternalId>",
        locationId: "<locationInternalId>",
        businessUnitId: "<businessUnitSegmentInternalId>",
      },
    });
  }

  const document = classifyDocument(invoice);
  if (document.transactionIntent === "vendor_prepayment" && !config.prepaymentPaymentAccountId) {
    hints.push({
      path: "prepaymentPaymentAccountId",
      value: "",
      reason: "Vendor prepayments require a NetSuite bank or credit-card funding account.",
      requiredForLivePush: true,
      example: "<bankOrCreditCardAccountInternalId>",
    });
  }

  const linesMissingAccount = document.transactionIntent !== "vendor_prepayment" &&
    lines.some((line) => {
      const accountCode = String(line?.account ?? "").trim();
      return !accountCode || !hasMapping(cw.accountsByCode, accountCode);
    }) &&
    !config.defaults?.expenseAccountId &&
    !config.apAccountId;
  if (linesMissingAccount) {
    hints.push({
      path: "defaults.expenseAccountId",
      value: "",
      reason: "At least one invoice line has no mapped GL account; configure a default/suspense expense account or extract/map line account codes.",
      requiredForLivePush: true,
      example: "<expenseAccountInternalId>",
    });
  }

  const missingClassCodes = new Set<string>();
  for (const line of lines) {
    const costCenter = String(line?.costCenter ?? "").trim();
    if (costCenter && !hasMapping(cw.classesByCode, costCenter) && !config.defaults?.classId) {
      missingClassCodes.add(costCenter);
    }
  }
  for (const code of missingClassCodes) {
    hints.push({
      path: `crosswalks.classesByCode["${configKey(code)}"]`,
      value: code,
      reason: "Map extracted cost center/class code to the NetSuite class internal id, or configure defaults.classId.",
      requiredForLivePush: false,
      example: "<classInternalId>",
    });
  }

  return dedupeConfigurationHints(hints);
}

function dedupeConfigurationHints(hints: NetSuiteConfigurationHint[]): NetSuiteConfigurationHint[] {
  const seen = new Set<string>();
  return hints.filter((hint) => {
    const key = `${hint.path}:${hint.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Placeholder internal id used when a reference cannot be resolved through a
 * crosswalk and no default is configured. It is intentionally non-numeric and
 * clearly marked so it can NEVER be mistaken for a real NetSuite internal id and
 * so validation/live-push will reject it loudly. Export-only flows surface it
 * in `warnings`.
 */
export const UNRESOLVED_PLACEHOLDER = "__UNRESOLVED__";

/**
 * Transform an extracted invoice into a NetSuite AP transaction payload.
 *
 * Mapping summary:
 *   invoice.invoiceNumber -> tranId + externalId (via buildExternalId)
 *   invoice.invoiceDate   -> tranDate
 *   invoice.currency      -> currency ref (crosswalk currenciesByCode)
 *   invoice.dueDate       -> dueDate
 *   invoice.paymentTerms  -> terms ref (crosswalk termsByName)
 *   invoice.description/PO/servicePeriod -> memo
 *   buyer.taxId/name or config.subsidiaryId -> subsidiary ref
 *   config.apAccountId    -> header AP account ref
 *   lineItems[] (NET)     -> expense.items[]:
 *       account  via accountsByCode (else default expenseAccount/apAccount + warning)
 *       amount   = line net amount
 *       memo     = line description
 *       department via departmentsByCode (line.department, else default)
 *       class    via classesByCode (line.costCenter || line.project, else default)
 *       taxCode  = config.defaults.taxCodeId (per-line; SuiteTax only — see TODO)
 *
 * Reconciliation: if round2(sum(line net) + taxAmount) != round2(totalAmount),
 * a warning is pushed (totalAmount is GROSS; line amounts are NET).
 */
export function transformToNetSuite(
  extracted: any,
  config: NetSuiteConfig
): { bill: NetSuiteRecordPayload; request: NetSuitePushRequest; warnings: string[] } {
  const warnings: string[] = [];
  const cw = config.crosswalks;

  const vendor = extracted?.vendor ?? {};
  const buyer = extracted?.buyer ?? {};
  const invoice = extracted?.invoice ?? {};
  const lineItems: any[] = Array.isArray(extracted?.lineItems) ? extracted.lineItems : [];

  const externalId = buildExternalId(extracted);
  const document = classifyDocument(invoice);
  const businessUnitRouting = resolveBusinessUnitRouting(buyer, config, warnings);

  if (document.isProforma) {
    warnings.push(
      "Proforma invoice classified as a NetSuite vendor prepayment request, not a vendor bill."
    );
  }

  // --- Vendor (entity) resolution: prefer taxId, then name ----------------
  let entity: NetSuiteRef | undefined;
  const taxId: string = vendor?.taxId ?? "";
  const vendorName: string = vendor?.name ?? "";
  if (taxId && cw.vendorsByTaxId[taxId]) {
    entity = { id: cw.vendorsByTaxId[taxId] };
  } else if (vendorName && cw.vendorsByName[vendorName]) {
    entity = { id: cw.vendorsByName[vendorName] };
  } else {
    warnings.push(
      `Vendor not resolved (taxId="${taxId}", name="${vendorName}"); entity left unset - resolve via crosswalk or SuiteQL before push.`
    );
  }

  // --- Currency -----------------------------------------------------------
  let currency: NetSuiteRef | undefined;
  const currencyCode: string = invoice?.currency ?? "";
  if (currencyCode && cw.currenciesByCode[currencyCode]) {
    currency = { id: cw.currenciesByCode[currencyCode] };
  } else if (currencyCode) {
    warnings.push(`Currency "${currencyCode}" not in crosswalk; currency ref left unset.`);
  }

  // --- Terms --------------------------------------------------------------
  let terms: NetSuiteRef | undefined;
  const paymentTerms: string = invoice?.paymentTerms ?? "";
  if (paymentTerms && cw.termsByName[paymentTerms]) {
    terms = { id: cw.termsByName[paymentTerms] };
  } else if (paymentTerms) {
    warnings.push(`Payment terms "${paymentTerms}" not in crosswalk; terms ref left unset.`);
  }

  // --- Header AP account --------------------------------------------------
  let account: NetSuiteRef | undefined;
  if (config.apAccountId) {
    account = { id: config.apAccountId };
  }

  // --- Subsidiary/entity routing -----------------------------------------
  let subsidiary: NetSuiteRef | undefined;
  const buyerTaxId: string = buyer?.taxId ?? "";
  const buyerName: string = buyer?.name ?? "";
  if (businessUnitRouting?.subsidiaryId) {
    subsidiary = { id: businessUnitRouting.subsidiaryId };
  } else if (buyerTaxId && cw.subsidiariesByTaxId?.[buyerTaxId]) {
    subsidiary = { id: cw.subsidiariesByTaxId[buyerTaxId] };
  } else if (buyerName && cw.subsidiariesByName?.[buyerName]) {
    subsidiary = { id: cw.subsidiariesByName[buyerName] };
  } else if (config.subsidiaryId) {
    subsidiary = { id: config.subsidiaryId };
  } else if (buyerTaxId || buyerName) {
    warnings.push(
      `Buyer entity not resolved (taxId="${buyerTaxId}", name="${buyerName}"); subsidiary left unset.`
    );
  }

  // --- PO reference -------------------------------------------------------
  const poNumber: string = invoice?.purchaseOrderNumber ?? "";
  if (poNumber) {
    const poId = cw.purchaseOrdersByNumber?.[poNumber];
    if (poId) {
      warnings.push(
        `PO "${poNumber}" maps to NetSuite purchase order ${poId}; use the PO-backed bill/three-way-match flow instead of a direct expense bill if this invoice should close the PO.`
      );
    } else {
      warnings.push(
        `PO "${poNumber}" extracted but not in purchaseOrdersByNumber; resolve/match the PO in NetSuite before push.`
      );
    }
  }

  // --- Lines (NET amounts) -> expense sublist -----------------------------
  const isVendorPrepayment = document.transactionIntent === "vendor_prepayment";
  const sourceLines = isVendorPrepayment ? [] : buildExpenseSourceLines(lineItems, invoice, warnings);
  const items: ExpenseLine[] = sourceLines.map((line, index) => {
    const lineNo = toNumber(line?.lineNumber) || index + 1;
    const amount = round2(toNumber(line?.amount));

    // GL account resolution
    let lineAccount: NetSuiteRef | undefined;
    const glCode: string = line?.account ?? "";
    if (glCode && cw.accountsByCode[glCode]) {
      lineAccount = { id: cw.accountsByCode[glCode] };
    } else if (config.defaults?.expenseAccountId || config.apAccountId) {
      // Fall back to a configured default/suspense account so the bill still
      // balances, but flag it for review.
      const fallbackAccountId = config.defaults?.expenseAccountId ?? config.apAccountId ?? "";
      lineAccount = { id: fallbackAccountId };
      warnings.push(
        `Line ${lineNo}: GL account "${glCode}" not in crosswalk; fell back to default account ${fallbackAccountId}.`
      );
    } else {
      lineAccount = { id: UNRESOLVED_PLACEHOLDER };
      warnings.push(
        `Line ${lineNo}: GL account "${glCode}" unresolved and no default configured; placeholder "${UNRESOLVED_PLACEHOLDER}" inserted.`
      );
    }

    // Department
    let department: NetSuiteRef | undefined;
    const deptCode: string = line?.department ?? "";
    if (deptCode && cw.departmentsByCode[deptCode]) {
      department = { id: cw.departmentsByCode[deptCode] };
    } else if (businessUnitRouting?.departmentId || config.defaults?.departmentId) {
      department = { id: businessUnitRouting?.departmentId ?? config.defaults?.departmentId ?? "" };
    } else if (deptCode) {
      warnings.push(`Line ${lineNo}: department "${deptCode}" not in crosswalk; left unset.`);
    }

    // Class — derived from costCenter, falling back to project.
    // TODO(sandbox): confirm the extractor's costCenter/project should map to
    // NetSuite "class" vs a custom segment. Field name on the line may be
    // `class` or a `cseg_*` custom column depending on the account.
    let cls: NetSuiteRef | undefined;
    const costCenterCode: string = line?.costCenter ?? "";
    const projectCode: string = line?.project ?? "";
    const classCode: string =
      costCenterCode || (projectCode && cw.classesByCode[projectCode] ? projectCode : "");
    if (classCode && cw.classesByCode[classCode]) {
      cls = { id: cw.classesByCode[classCode] };
    } else if (businessUnitRouting?.classId || config.defaults?.classId) {
      cls = { id: businessUnitRouting?.classId ?? config.defaults?.classId ?? "" };
    } else if (costCenterCode) {
      warnings.push(`Line ${lineNo}: class "${costCenterCode}" not in crosswalk; left unset.`);
    }

    // Location default (extractor has no location concept today)
    let location: NetSuiteRef | undefined;
    if (businessUnitRouting?.locationId || config.defaults?.locationId) {
      location = { id: businessUnitRouting?.locationId ?? config.defaults?.locationId ?? "" };
    }

    // Per-line tax code (SuiteTax only — see ExpenseLine TODO)
    let taxCode: NetSuiteRef | undefined;
    if (config.defaults?.taxCodeId) {
      taxCode = { id: config.defaults.taxCodeId };
    }

    const expenseLine: ExpenseLine = { amount };
    if (lineAccount) expenseLine.account = lineAccount;
    const memo: string = line?.description ?? "";
    if (memo) expenseLine.memo = memo;
    if (department) expenseLine.department = department;
    if (cls) expenseLine.class = cls;
    if (location) expenseLine.location = location;
    if (taxCode) expenseLine.taxCode = taxCode;
    applyBusinessUnitSegment(expenseLine as unknown as Record<string, unknown>, config, businessUnitRouting);
    applyCustomFields(expenseLine as unknown as Record<string, unknown>, businessUnitRouting?.customLineFields);
    return expenseLine;
  });

  if (!isVendorPrepayment && items.length === 0) {
    warnings.push("No line items found; vendor bill has an empty expense sublist.");
  }

  // --- Reconciliation: sum(net) + tax should equal gross total ------------
  const netSum = round2(items.reduce((acc, l) => acc + l.amount, 0));
  const taxAmount = round2(toNumber(invoice?.taxAmount));
  const totalAmount = round2(toNumber(invoice?.totalAmount));
  if (!isVendorPrepayment && totalAmount > 0 && round2(netSum + taxAmount) !== totalAmount) {
    warnings.push(
      `Reconciliation mismatch: sum(line net)=${netSum} + tax=${taxAmount} = ${round2(
        netSum + taxAmount
      )} != totalAmount(gross)=${totalAmount}.`
    );
  }

  const invoiceNumber: string = invoice?.invoiceNumber ?? "";
  const tranDate: string = invoice?.invoiceDate ?? "";
  const memo = buildMemo(invoice);

  if (isVendorPrepayment) {
    const prepayment: VendorPrepayment = {
      externalId,
      payment: totalAmount,
    };

    if (invoiceNumber) prepayment.tranId = invoiceNumber;
    if (tranDate) prepayment.tranDate = tranDate;
    if (memo) prepayment.memo = memo;
    if (entity) prepayment.entity = entity;
    if (subsidiary) prepayment.subsidiary = subsidiary;
    if (currency) prepayment.currency = currency;
    if (config.prepaymentPaymentAccountId) {
      prepayment.account = { id: config.prepaymentPaymentAccountId };
    }
    if (config.prepaymentAccountId) {
      prepayment.prepaymentAccount = { id: config.prepaymentAccountId };
    }
    if (businessUnitRouting?.departmentId || config.defaults?.departmentId) {
      prepayment.department = asRef(businessUnitRouting?.departmentId ?? config.defaults?.departmentId);
    }
    if (businessUnitRouting?.classId || config.defaults?.classId) {
      prepayment.class = asRef(businessUnitRouting?.classId ?? config.defaults?.classId);
    }
    if (businessUnitRouting?.locationId || config.defaults?.locationId) {
      prepayment.location = asRef(businessUnitRouting?.locationId ?? config.defaults?.locationId);
    }
    const poId = poNumber ? cw.purchaseOrdersByNumber?.[poNumber] : undefined;
    if (poId) prepayment.purchaseOrder = { id: poId };
    applyBusinessUnitSegment(prepayment as unknown as Record<string, unknown>, config, businessUnitRouting);
    applyCustomFields(
      prepayment as unknown as Record<string, unknown>,
      businessUnitRouting?.customBodyFields
    );

    const request: NetSuitePushRequest = {
      schemaVersion: "netsuite-ap-v1",
      recordType: "vendorPrepayment",
      restRecordId: "vendorPrepayment",
      operation: "upsertByExternalId",
      externalId,
      document,
      businessUnitRouting,
      payload: prepayment,
    };

    return { bill: prepayment, request, warnings };
  }

  const bill: VendorBill = { externalId };

  // TODO(sandbox): tranId may be read-only/auto-numbered — drop if rejected.
  if (invoiceNumber) bill.tranId = invoiceNumber;

  if (tranDate) bill.tranDate = tranDate;

  const dueDate: string = invoice?.dueDate ?? "";
  if (dueDate) bill.dueDate = dueDate;

  if (memo) bill.memo = memo;

  if (entity) bill.entity = entity;
  if (subsidiary) bill.subsidiary = subsidiary;
  if (currency) bill.currency = currency;
  if (terms) bill.terms = terms;
  if (account) bill.account = account;
  applyBusinessUnitSegment(bill as unknown as Record<string, unknown>, config, businessUnitRouting);
  applyCustomFields(bill as unknown as Record<string, unknown>, businessUnitRouting?.customBodyFields);

  bill.expense = { items };

  const request: NetSuitePushRequest = {
    schemaVersion: "netsuite-ap-v1",
    recordType: "vendorBill",
    restRecordId: "vendorBill",
    operation: "upsertByExternalId",
    externalId,
    document,
    businessUnitRouting,
    payload: bill,
  };

  return { bill, request, warnings };
}

// ===========================================================================
// Validation
// ===========================================================================

/**
 * Pre-flight validation of a built vendor bill.
 *
 * Requires: entity (vendor), tranDate, and at least one expense line. Subsidiary
 * is required ONLY when config.subsidiaryId is set (single-subsidiary scaffold;
 * non-OneWorld accounts have no subsidiary field). Also rejects any unresolved
 * placeholder refs that slipped through.
 */
export function validateNetSuiteVendorBill(
  bill: VendorBill,
  config?: NetSuiteConfig
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!bill.entity?.id) {
    errors.push("entity (vendor) is required");
  }
  if (!bill.tranDate) {
    errors.push("tranDate is required");
  }

  const lines = bill.expense?.items ?? [];
  if (lines.length === 0) {
    errors.push("at least one expense line is required");
  }

  if (config?.subsidiaryId && !bill.subsidiary?.id) {
    errors.push("subsidiary is required when config.subsidiaryId is set");
  }

  // Reject placeholders that would fail (or worse, silently mis-post) live.
  if (bill.entity?.id === UNRESOLVED_PLACEHOLDER) {
    errors.push("entity ref is an unresolved placeholder");
  }
  lines.forEach((line, i) => {
    if (line.account?.id === UNRESOLVED_PLACEHOLDER) {
      errors.push(`expense line ${i + 1} has an unresolved account placeholder`);
    }
  });

  return { valid: errors.length === 0, errors };
}

export function validateNetSuiteVendorPrepayment(
  prepayment: VendorPrepayment,
  config?: NetSuiteConfig
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!prepayment.entity?.id) {
    errors.push("entity (vendor/payee) is required");
  }
  if (!prepayment.tranDate) {
    errors.push("tranDate is required");
  }
  if (!(typeof prepayment.payment === "number" && prepayment.payment > 0)) {
    errors.push("payment amount is required for vendor prepayment");
  }
  if (!prepayment.account?.id) {
    errors.push("account (prepayment funding bank/credit-card account) is required");
  }
  if (config?.subsidiaryId && !prepayment.subsidiary?.id) {
    errors.push("subsidiary is required when config.subsidiaryId is set");
  }
  if (prepayment.entity?.id === UNRESOLVED_PLACEHOLDER) {
    errors.push("entity ref is an unresolved placeholder");
  }

  return { valid: errors.length === 0, errors };
}

export function validateNetSuiteRequest(
  request: NetSuitePushRequest,
  config?: NetSuiteConfig
): { valid: boolean; errors: string[] } {
  if (request.recordType === "vendorPrepayment") {
    return validateNetSuiteVendorPrepayment(request.payload as VendorPrepayment, config);
  }
  return validateNetSuiteVendorBill(request.payload as VendorBill, config);
}

// ===========================================================================
// OAuth 2.0 M2M client (client-credentials + JWT client-assertion)
// ===========================================================================

const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function tokenEndpoint(accountId: string): string {
  return `https://${accountId}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;
}

function restBase(accountId: string): string {
  return `https://${accountId}.suitetalk.api.netsuite.com/services/rest`;
}

/** Map our alg union to the node:crypto sign algorithm + optional RSA-PSS opts. */
function signerFor(alg: NetSuiteSecret["alg"]): {
  nodeAlg: string;
  padding?: number;
  saltLength?: number;
} {
  switch (alg) {
    case "RS256":
      return { nodeAlg: "RSA-SHA256" };
    case "ES256":
      return { nodeAlg: "SHA256" }; // EC key inferred from the PEM
    case "PS256":
    default:
      // RSA-PSS. constants resolved lazily so we avoid a top-level import cost.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const c = require("node:crypto") as typeof import("node:crypto");
      return {
        nodeAlg: "RSA-SHA256",
        padding: c.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: c.constants.RSA_PSS_SALTLEN_DIGEST,
      };
  }
}

/** Build and sign the JWT client assertion. */
function buildClientAssertion(secret: NetSuiteSecret): string {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: secret.alg,
    typ: "JWT",
    kid: secret.certificateId,
  };
  const aud = tokenEndpoint(secret.accountId);
  const claims = {
    iss: secret.clientId,
    scope: ["rest_webservices"],
    aud,
    iat: now,
    exp: now + 180, // a few minutes; NetSuite caps assertion lifetime
    jti: randomUUID(),
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claims)
  )}`;

  const { nodeAlg, padding, saltLength } = signerFor(secret.alg);
  const signer = createSign(nodeAlg);
  signer.update(signingInput);
  signer.end();

  const keyInput =
    padding !== undefined
      ? { key: secret.privateKeyPem, padding, saltLength }
      : secret.privateKeyPem;

  let signature: Buffer;
  if (secret.alg === "ES256") {
    // node:crypto emits DER for EC by default; JOSE requires the raw R||S
    // (IEEE P1363) form. Request it directly.
    signature = signer.sign({ key: secret.privateKeyPem, dsaEncoding: "ieee-p1363" });
  } else {
    signature = signer.sign(keyInput as any);
  }

  return `${signingInput}.${base64url(signature)}`;
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

// Module-scope bearer cache, keyed by accountId+clientId so multiple configs
// don't collide. Lives for the warm lifetime of the Lambda container.
const tokenCache = new Map<string, CachedToken>();

/**
 * Obtain (and cache) an OAuth 2.0 bearer token via the client-credentials grant
 * with a signed JWT client assertion.
 *
 * Cached in module scope until ~30s before expiry. NetSuite tokens are typically
 * valid ~1h; we honor the returned expires_in.
 */
export async function getAccessToken(secret: NetSuiteSecret): Promise<string> {
  const cacheKey = `${secret.accountId}:${secret.clientId}`;
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt - 30_000 > now) {
    return cached.token;
  }

  const assertion = buildClientAssertion(secret);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: assertion,
  });

  const res = await fetch(tokenEndpoint(secret.accountId), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`NetSuite token request failed: ${res.status} ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("NetSuite token response missing access_token");
  }

  const expiresInMs = (typeof json.expires_in === "number" ? json.expires_in : 3600) * 1000;
  tokenCache.set(cacheKey, { token: json.access_token, expiresAt: now + expiresInMs });
  return json.access_token;
}

/** Clear the cached bearer token (test/rotation helper). */
export function clearTokenCache(): void {
  tokenCache.clear();
}

// ===========================================================================
// SuiteQL resolver helper
// ===========================================================================

export interface SuiteQLResult {
  items: Array<Record<string, unknown>>;
  hasMore: boolean;
}

/**
 * Run a SuiteQL query. Requires the "Prefer: transient" header. Useful as a
 * resolver to look up vendor/account/etc internal ids when a crosswalk entry is
 * missing (e.g. `SELECT id FROM vendor WHERE entityid = '...'`).
 */
export async function suiteql(
  secret: NetSuiteSecret,
  token: string,
  q: string
): Promise<SuiteQLResult> {
  const res = await fetch(`${restBase(secret.accountId)}/query/v1/suiteql`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      prefer: "transient",
    },
    body: JSON.stringify({ q }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SuiteQL query failed: ${res.status} ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as { items?: Array<Record<string, unknown>>; hasMore?: boolean };
  return { items: json.items ?? [], hasMore: Boolean(json.hasMore) };
}

// ===========================================================================
// Idempotent upsert
// ===========================================================================

export interface UpsertResult {
  status: number;
  /** NetSuite returns the record location in the response headers on success. */
  location: string | null;
  /** Parsed body when present (NetSuite often returns 204 with no body). */
  body: unknown;
}

export function asNetSuitePushRequest(
  payload: unknown,
  externalId: string
): NetSuitePushRequest {
  const maybe = payload as Partial<NetSuitePushRequest> | undefined;
  if (
    maybe &&
    typeof maybe === "object" &&
    maybe.schemaVersion === "netsuite-ap-v1" &&
    (maybe.recordType === "vendorBill" || maybe.recordType === "vendorPrepayment") &&
    maybe.payload
  ) {
    return maybe as NetSuitePushRequest;
  }

  return {
    schemaVersion: "netsuite-ap-v1",
    recordType: "vendorBill",
    restRecordId: "vendorBill",
    operation: "upsertByExternalId",
    externalId,
    document: {
      transactionIntent: "vendor_bill",
      isProforma: false,
    },
    payload: payload as VendorBill,
  };
}

/**
 * Idempotently create-or-update a vendor bill by external id.
 *
 * PUT .../record/v1/vendorBill/eid:{externalId} — NetSuite upserts on the
 * external id, so retries with the same externalId are safe (no duplicate bill).
 *
 * NOTE: the source PDF is NOT uploaded here. The REST Record API cannot upload
 * file bytes.
 * TODO(sandbox): attaching the original PDF requires a COMPANION SuiteScript
 * RESTlet (File Cabinet create + attach to the bill). Build that separately and
 * call it after a successful upsert; REST alone cannot do it.
 */
export async function upsertVendorBill(
  secret: NetSuiteSecret,
  token: string,
  bill: VendorBill,
  externalId: string
): Promise<UpsertResult> {
  return upsertNetSuiteRecord(
    secret,
    token,
    {
      schemaVersion: "netsuite-ap-v1",
      recordType: "vendorBill",
      restRecordId: "vendorBill",
      operation: "upsertByExternalId",
      externalId,
      document: {
        transactionIntent: "vendor_bill",
        isProforma: false,
      },
      payload: bill,
    },
    externalId
  );
}

export async function upsertNetSuiteRecord(
  secret: NetSuiteSecret,
  token: string,
  request: NetSuitePushRequest,
  externalId: string = request.externalId
): Promise<UpsertResult> {
  const safeEid = sanitizeIdPart(externalId).slice(0, EXTERNAL_ID_MAX);
  const url = `${restBase(secret.accountId)}/record/v1/${request.restRecordId}/eid:${encodeURIComponent(
    safeEid
  )}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request.payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `${request.recordType} upsert failed: ${res.status} ${text.slice(0, 500)}`
    );
  }

  let body: unknown = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return {
    status: res.status,
    location: res.headers.get("location"),
    body,
  };
}

// ===========================================================================
// Example config
// ===========================================================================

/**
 * Example/placeholder config. The API handler loads this for the EXPORT-ONLY
 * preview today. Real values come from netsuite-config.json + a secrets store
 * once creds are wired in.
 *
 * TODO(sandbox): populate every crosswalk and the subsidiary/account ids from
 * the target NetSuite account before enabling live push. Empty crosswalks mean
 * every ref falls back to a warning/placeholder.
 */
export const exampleNetSuiteConfig: NetSuiteConfig = {
  subsidiaryId: undefined,
  apAccountId: undefined,
  prepaymentPaymentAccountId: undefined,
  prepaymentAccountId: undefined,
  businessUnitSegmentFieldId: undefined,
  defaults: {
    expenseAccountId: undefined,
    departmentId: undefined,
    classId: undefined,
    locationId: undefined,
    taxCodeId: undefined,
  },
  crosswalks: {
    vendorsByTaxId: {},
    vendorsByName: {},
    accountsByCode: {},
    currenciesByCode: {},
    departmentsByCode: {},
    classesByCode: {},
    termsByName: {},
    subsidiariesByTaxId: {},
    subsidiariesByName: {},
    purchaseOrdersByNumber: {},
    businessUnitsByTaxId: {},
    businessUnitsByName: {},
    businessUnitsByEntityCode: {},
    businessUnitsByEmailDomain: {},
    businessUnitsByAddressContains: {},
  },
  businessUnits: {},
};
