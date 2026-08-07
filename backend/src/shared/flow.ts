import { createHash } from "node:crypto";

export type ControlSeverity = "info" | "warning" | "blocker";
export type ReviewStatus = "READY_FOR_NETSUITE" | "NEEDS_REVIEW";
export type DuplicateReviewAction = "HOLD_FOR_REVIEW" | "ALLOW_NETSUITE";
export type DocumentKind = "INVOICE" | "SUPPORTING_DOCUMENT";

export interface ControlFlag {
  code: string;
  severity: ControlSeverity;
  message: string;
}

export interface DuplicateMatch {
  messageId: string;
  attachmentId?: string;
  attachmentKey?: string;
  receivedAt?: string;
  vendorName?: string;
  invoiceNumber?: string;
  currency?: string;
  totalAmount?: number;
  status?: string;
}

export interface FlowAssessment {
  /**
   * Whether this attachment is an invoice at all. Invoice emails routinely carry
   * supporting material — cost-allocation schedules, customs exchange-rate
   * notifications, remittance summaries — and each one used to land in the AP
   * queue as a separate "invoice" failing one completeness check at a time.
   * A SUPPORTING_DOCUMENT is kept and viewable, but is never pushed to NetSuite
   * and doesn't carry the invoice-completeness flags.
   */
  documentKind: DocumentKind;
  /**
   * "Any flag at all" signal (blocker or warning) — drives what AP sees as needing
   * a look. Independent of `autoBookEligible`: a warning-only invoice can still be
   * auto-booked while showing NEEDS_REVIEW so AP retains visibility.
   */
  reviewStatus: ReviewStatus;
  /**
   * True whenever there's no blocker-severity flag and confidence clears the
   * threshold — this is what actually gates the automatic NetSuite push.
   * Warning-severity flags (unmapped GL account defaulted, PO not matched,
   * first-time vendor, VAT not yet validated, etc.) do NOT block this; only
   * `hasBlockingFlags` does.
   */
  autoBookEligible: boolean;
  /**
   * True only when a blocker-severity flag is present (missing vendor, unresolved
   * duplicate, unresolved NetSuite placeholder, etc.) — data that genuinely can't
   * go to NetSuite. This is the actual auto-book gate (see `autoBookEligible`) and
   * also what stops a human from manually overriding past it — a blocker has to be
   * resolved (fix the crosswalk, allow the duplicate) rather than approved past.
   */
  hasBlockingFlags: boolean;
  duplicateKey: string | null;
  duplicateCount: number;
  duplicateReview: DuplicateReviewDecision | null;
  flags: ControlFlag[];
}

export interface FlowAssessmentOptions {
  confidence?: number;
  warnings?: string[];
  duplicateCount?: number;
  duplicateReview?: DuplicateReviewDecision | null;
  netSuiteWarnings?: string[];
  netSuiteValidationErrors?: string[];
  minimumAutoBookConfidence?: number;
  /**
   * True when this is the first NetSuite transaction ever seen for this resolved
   * vendor. Surfaced as an informational warning flag only — does not block
   * auto-booking (only blocker-severity flags do; see `autoBookEligible`).
   */
  firstTimeVendorHold?: boolean;
}

export interface DuplicateReviewDecision {
  action: DuplicateReviewAction;
  reviewedAt?: string;
  reviewedBy?: string;
  note?: string;
}

const DEFAULT_AUTO_BOOK_CONFIDENCE = 0.95;

export function buildDuplicateKey(extracted: any): string | null {
  const vendor = extracted?.vendor ?? {};
  const invoice = extracted?.invoice ?? {};
  const vendorId = canonical(vendor.taxId) || canonical(vendor.name);
  const invoiceNumber = canonical(invoice.invoiceNumber);

  if (!vendorId || !invoiceNumber) {
    return null;
  }

  const amount =
    typeof invoice.totalAmount === "number" && Number.isFinite(invoice.totalAmount)
      ? invoice.totalAmount.toFixed(2)
      : "";
  const currency = canonical(invoice.currency);
  const raw = [vendorId, invoiceNumber, currency, amount].join("|");
  return `DUP#${createHash("sha256").update(raw).digest("hex").slice(0, 40)}`;
}

export function summarizeDuplicateMatch(item: any): DuplicateMatch {
  return {
    messageId: String(item?.messageId ?? ""),
    attachmentId: item?.attachmentId,
    attachmentKey: item?.attachmentKey,
    receivedAt: item?.receivedAt,
    vendorName: item?.vendorName,
    invoiceNumber: item?.invoiceNumber,
    currency: item?.currency,
    totalAmount: item?.totalAmount,
    status: item?.status,
  };
}

/**
 * Distinguishes a real invoice from supporting material that arrived in the
 * same email.
 *
 * Primary signal is the extraction model's own judgement
 * (`document.isPayableInvoice`) — it has the whole document in front of it and
 * can tell a customs rate notification from an invoice far more reliably than
 * field-shape rules can. "Is this the document asking to be paid?" is exactly
 * the kind of call it should be making, not one to reverse-engineer downstream.
 *
 * The field-shape heuristic below is only the fallback, for records extracted
 * before the model was asked to classify. It requires BOTH signals — an
 * unrecognised invoice type AND no stated amount — so a genuine invoice whose
 * total briefly failed to parse still counts as an invoice (and stops for
 * review on the missing total) rather than being filed away as reference.
 */
function classifyDocumentKind(extracted: any): DocumentKind {
  const isPayableInvoice = extracted?.document?.isPayableInvoice;
  if (typeof isPayableInvoice === "boolean") {
    return isPayableInvoice ? "INVOICE" : "SUPPORTING_DOCUMENT";
  }

  const invoice = extracted?.invoice ?? {};
  const invoiceType = String(invoice?.invoiceType ?? "").trim().toLowerCase();
  const total = invoice?.totalAmount;
  const statesAnAmount = typeof total === "number" && Number.isFinite(total) && total !== 0;
  return invoiceType === "other" && !statesAnAmount ? "SUPPORTING_DOCUMENT" : "INVOICE";
}

export function assessInvoiceFlow(
  extracted: any,
  options: FlowAssessmentOptions = {}
): FlowAssessment {
  const flags: ControlFlag[] = [];
  const invoice = extracted?.invoice ?? {};
  const vendor = extracted?.vendor ?? {};
  const buyer = extracted?.buyer ?? {};
  const lineItems = Array.isArray(extracted?.lineItems) ? extracted.lineItems : [];
  const confidence =
    typeof options.confidence === "number"
      ? options.confidence
      : extracted?.meta?.confidenceScore;
  const duplicateKey = buildDuplicateKey(extracted);
  const duplicateCount = options.duplicateCount ?? extracted?.meta?.duplicateCount ?? 0;
  const duplicateReview = normalizeDuplicateReview(
    options.duplicateReview ?? extracted?.meta?.duplicateReview
  );

  // Non-invoice attachments short-circuit everything below: the completeness
  // checks (vendor, invoice number, total, ...) only make sense for a document
  // that's trying to be an invoice, and running them produces a wall of
  // blockers for something that was never going to NetSuite anyway.
  if (classifyDocumentKind(extracted) === "SUPPORTING_DOCUMENT") {
    const documentType = String(extracted?.document?.documentType ?? "").trim();
    return {
      documentKind: "SUPPORTING_DOCUMENT",
      reviewStatus: "NEEDS_REVIEW",
      autoBookEligible: false,
      hasBlockingFlags: false,
      // Deliberately excluded from duplicate detection — two copies of the same
      // rate notification aren't a duplicate-payment risk, which is what that
      // check exists to catch.
      duplicateKey: null,
      duplicateCount: 0,
      duplicateReview: null,
      flags: [
        {
          code: "supporting_document",
          severity: "info",
          message: documentType
            ? `Not an invoice (${documentType}) — kept as a reference document. Never sent to NetSuite.`
            : "Not an invoice — kept as a reference document. Never sent to NetSuite.",
        },
      ],
    };
  }

  if (!hasValue(vendor.name)) {
    flags.push({
      code: "missing_vendor",
      severity: "blocker",
      message: "Vendor/supplier could not be identified.",
    });
  }

  const vatStatus = vendor.vatValidation?.status;
  if (hasValue(vendor.taxId) && vatStatus !== "VALID") {
    flags.push({
      code: "vat_not_validated",
      severity: "warning",
      message: `Vendor VAT status is ${vatStatus ?? "unknown"}; NetSuite push requires a validated VAT number.`,
    });
  }

  if (options.firstTimeVendorHold) {
    flags.push({
      code: "first_time_vendor_auto_book_hold",
      severity: "warning",
      message:
        "This is the first NetSuite transaction seen for this vendor. Booked automatically; flagged here for AP awareness.",
    });
  }

  if (!hasValue(invoice.invoiceNumber)) {
    flags.push({
      code: "missing_invoice_number",
      severity: "blocker",
      message: "Invoice number is missing.",
    });
  }

  if (!hasValue(invoice.invoiceDate)) {
    flags.push({
      code: "missing_invoice_date",
      severity: "blocker",
      message: "Invoice date is missing.",
    });
  }

  if (!hasValue(invoice.currency)) {
    flags.push({
      code: "missing_currency",
      severity: "blocker",
      message: "Invoice currency is missing.",
    });
  }

  if (!(typeof invoice.totalAmount === "number" && invoice.totalAmount > 0)) {
    flags.push({
      code: "missing_total",
      severity: "blocker",
      message: "Gross invoice total is missing or zero.",
    });
  }

  if (lineItems.length === 0) {
    flags.push({
      code: "missing_lines",
      severity: "warning",
      message: "No invoice line items were extracted.",
    });
  }

  if (!hasValue(buyer.name)) {
    flags.push({
      code: "missing_buyer_entity",
      severity: "warning",
      message: "Buyer/legal entity was not identified, so entity routing needs review.",
    });
  }

  if (typeof confidence === "number" && confidence < 0.85) {
    flags.push({
      code: "low_confidence",
      severity: "warning",
      message: `Extraction confidence is ${Math.round(confidence * 100)}%.`,
    });
  }

  const invoiceType = String(invoice.invoiceType ?? "").toLowerCase();
  const transactionIntent = String(invoice.transactionIntent ?? "").toLowerCase();
  if (/proforma|pro\s*forma/.test(invoiceType) || /prepayment/.test(transactionIntent)) {
    flags.push({
      code: "proforma_prepayment",
      severity: "warning",
      message:
        "Proforma invoice is treated as a NetSuite vendor prepayment request, not a vendor bill.",
    });
  } else if (/credit|reminder|dunning|mahnung|statement/.test(invoiceType)) {
    flags.push({
      code: "non_standard_document",
      severity: "warning",
      message: `Document type is "${invoice.invoiceType}", so AP should confirm it should become a vendor bill.`,
    });
  }

  if (hasValue(invoice.purchaseOrderNumber)) {
    flags.push({
      code: "po_match_required",
      severity: "warning",
      message: `PO ${invoice.purchaseOrderNumber} was extracted; match it to the NetSuite PO before booking.`,
    });
  }

  const bank = vendor.bankDetails ?? {};
  if (hasBankDetails(bank)) {
    flags.push({
      code: "bank_details_captured",
      severity: "info",
      message: "Vendor bank details were captured for NetSuite vendor-master verification.",
    });
  } else {
    flags.push({
      code: "bank_details_not_found",
      severity: "info",
      message: "No vendor bank details were found on the invoice.",
    });
  }

  if (duplicateCount > 0) {
    if (duplicateReview?.action === "ALLOW_NETSUITE") {
      flags.push({
        code: "duplicate_allowed",
        severity: "info",
        message: duplicateReview.reviewedBy
          ? `Duplicate invoice allowed for NetSuite by ${duplicateReview.reviewedBy}.`
          : "Duplicate invoice allowed for NetSuite by AP review.",
      });
    } else {
      flags.push({
        code: "potential_duplicate",
        severity: "blocker",
        message: `${duplicateCount} possible duplicate invoice record${duplicateCount === 1 ? "" : "s"} found.`,
      });
    }
  }

  for (const warning of options.warnings ?? []) {
    if (String(warning).trim() === "sanitized_purchase_order_number") {
      continue;
    }
    flags.push({
      code: "extraction_warning",
      severity: "warning",
      message: warning,
    });
  }

  for (const warning of options.netSuiteWarnings ?? []) {
    flags.push({
      code: "netsuite_warning",
      severity: "warning",
      message: warning,
    });
  }

  for (const error of options.netSuiteValidationErrors ?? []) {
    flags.push({
      code: "netsuite_validation_error",
      severity: "blocker",
      message: error,
    });
  }

  const blocking = flags.some((flag) => flag.severity === "blocker");
  const warnings = flags.some((flag) => flag.severity === "warning");
  const reviewStatus: ReviewStatus = blocking || warnings ? "NEEDS_REVIEW" : "READY_FOR_NETSUITE";
  const minConfidence = options.minimumAutoBookConfidence ?? DEFAULT_AUTO_BOOK_CONFIDENCE;
  // Auto-book gates only on blocker-severity flags — data that genuinely can't go to
  // NetSuite (an unresolved duplicate, a missing required field like vendor entity).
  // Warning-severity flags (unmapped GL account defaulted, PO not matched, first-time
  // vendor, VAT not yet validated, etc.) still surface via reviewStatus/flags for AP
  // to see, but no longer block the automatic push — only `blocking` does. This is
  // intentionally looser than `reviewStatus === READY_FOR_NETSUITE`, which required
  // zero flags of any kind.
  const autoBookEligible =
    !blocking &&
    typeof confidence === "number" &&
    confidence >= minConfidence;

  return {
    documentKind: "INVOICE",
    reviewStatus,
    autoBookEligible,
    hasBlockingFlags: blocking,
    duplicateKey,
    duplicateCount,
    duplicateReview,
    flags: dedupeFlags(flags),
  };
}

export function normalizeDuplicateReview(value: any): DuplicateReviewDecision | null {
  const action =
    value?.action === "ALLOW_NETSUITE"
      ? "ALLOW_NETSUITE"
      : value?.action === "HOLD_FOR_REVIEW"
        ? "HOLD_FOR_REVIEW"
        : null;
  if (!action) return null;

  return {
    action,
    reviewedAt: stringOrUndefined(value?.reviewedAt),
    reviewedBy: stringOrUndefined(value?.reviewedBy),
    note: stringOrUndefined(value?.note),
  };
}

function canonical(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}._-]+/gu, "");
}

function hasValue(value: unknown): boolean {
  return String(value ?? "").trim().length > 0;
}

function stringOrUndefined(value: unknown): string | undefined {
  const s = String(value ?? "").trim();
  return s || undefined;
}

function hasBankDetails(bank: any): boolean {
  if (!bank || typeof bank !== "object") return false;
  const ibans = Array.isArray(bank.ibans) ? bank.ibans : bank.iban ? [bank.iban] : [];
  return ibans.some(hasValue) || hasValue(bank.bic) || hasValue(bank.bankName) || hasValue(bank.accountNumber);
}

function dedupeFlags(flags: ControlFlag[]): ControlFlag[] {
  const seen = new Set<string>();
  return flags.filter((flag) => {
    const key = `${flag.code}:${flag.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
