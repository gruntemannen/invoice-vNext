import { createHash } from "node:crypto";

export type ControlSeverity = "info" | "warning" | "blocker";
export type ReviewStatus = "READY_FOR_NETSUITE" | "NEEDS_REVIEW";

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
  reviewStatus: ReviewStatus;
  autoBookEligible: boolean;
  duplicateKey: string | null;
  duplicateCount: number;
  flags: ControlFlag[];
}

export interface FlowAssessmentOptions {
  confidence?: number;
  warnings?: string[];
  duplicateCount?: number;
  netSuiteWarnings?: string[];
  netSuiteValidationErrors?: string[];
  minimumAutoBookConfidence?: number;
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

  if (!hasValue(vendor.name)) {
    flags.push({
      code: "missing_vendor",
      severity: "blocker",
      message: "Vendor/supplier could not be identified.",
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
    flags.push({
      code: "potential_duplicate",
      severity: "blocker",
      message: `${duplicateCount} possible duplicate invoice record${duplicateCount === 1 ? "" : "s"} found.`,
    });
  }

  for (const warning of options.warnings ?? []) {
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
  const autoBookEligible =
    reviewStatus === "READY_FOR_NETSUITE" &&
    typeof confidence === "number" &&
    confidence >= minConfidence;

  return {
    reviewStatus,
    autoBookEligible,
    duplicateKey,
    duplicateCount,
    flags: dedupeFlags(flags),
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
