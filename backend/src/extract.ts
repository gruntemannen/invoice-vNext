import { SQSEvent } from "aws-lambda";
import { getObject } from "./shared/s3";
import { queryDuplicateInvoices, updateItem } from "./shared/dynamo";
import { invokeBedrock, DocumentInput } from "./shared/bedrock";
import { buildExtractionPrompt, buildRepairPrompt } from "./shared/prompts";
import { calculateConfidence } from "./shared/confidence";
import { assessInvoiceFlow, buildDuplicateKey, summarizeDuplicateMatch } from "./shared/flow";
import { log } from "./shared/logger";
import { emitMetric } from "./shared/metrics";

const ATTACHMENT_BUCKET = process.env.ATTACHMENT_BUCKET ?? "";
const TABLE_NAME = process.env.TABLE_NAME ?? "";
// Region-agnostic default so a misconfigured/test env doesn't silently pick an EU profile;
// the CDK always sets BEDROCK_MODEL_ID from config.ts.
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "global.anthropic.claude-sonnet-4-6";

export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    const startTime = Date.now();
    let messageId = "";
    let attachmentKey = "";
    let receivedAt = "";
    let from = "";
    let subject = "";

    try {
      const payload = JSON.parse(record.body);
      ({ messageId, attachmentKey, receivedAt, from, subject } = payload);
      const { attachmentId } = payload;
      const warnings: string[] = [];

      // 1. Get the file from S3 (with its stored content-type)
      const { body: attachment, contentType } = await getObject(ATTACHMENT_BUCKET, attachmentKey);

      // 2. Prepare document for AI (PDF sent directly to Claude)
      const doc = prepareDocument(attachmentKey, attachment, contentType);
      log.info("Document prepared", {
        attachmentKey,
        mediaType: doc.mediaType,
        sizeBytes: attachment.length,
      });

      // 3. Call AI to extract structured data (Claude sees the PDF directly)
      const prompt = buildExtractionPrompt("", true); // Empty text - Claude reads the PDF visually
      const response = await invokeBedrock(BEDROCK_MODEL_ID, prompt, [doc]);
      let modelUsed = response.modelId;

      // 4. Parse the JSON response
      let extracted = parseJsonResponse(response.text);

      // If parsing failed, try once with repair prompt
      if (!extracted) {
        log.warn("First parse failed, trying repair", { responseLength: response.text?.length ?? 0 });
        const repairResponse = await invokeBedrock(BEDROCK_MODEL_ID, buildRepairPrompt(response.text ?? ""), []);
        extracted = parseJsonResponse(repairResponse.text);
        modelUsed = repairResponse.modelId;
      }

      if (!extracted) {
        throw new Error("Failed to parse AI response as JSON");
      }

      // 5. Normalize structure (ensure required fields exist)
      const normalized = normalizeExtraction(extracted);

      // 5b. Light reconciliation (proforma tagging, PO cleanup)
      reconcileExtraction(normalized, warnings);

      // 6. Add metadata
      normalized.meta = {
        messageId,
        receivedAt,
        from,
        subject,
        attachmentKey,
        extractionModel: modelUsed,
        confidenceScore: 0,
        warnings,
        extractedTextSnippet: "(PDF processed visually by AI)",
      };

      // 7. Calculate confidence
      const confidence = calculateConfidence(normalized);
      normalized.meta.confidenceScore = confidence;

      // 8. Find likely duplicates before marking this invoice ready for review/export.
      const duplicateKey = buildDuplicateKey(normalized);
      let duplicateMatches: ReturnType<typeof summarizeDuplicateMatch>[] = [];
      if (duplicateKey) {
        try {
          duplicateMatches = (
            await queryDuplicateInvoices(TABLE_NAME, duplicateKey, {
              messageId,
              attachmentKey,
            })
          ).map(summarizeDuplicateMatch);
        } catch (err: any) {
          warnings.push(`duplicate_lookup_failed: ${err?.message ?? String(err)}`);
          log.warn("Duplicate lookup failed", { messageId, duplicateKey, error: err?.message ?? String(err) });
        }
      }

      const flow = assessInvoiceFlow(normalized, {
        confidence,
        warnings,
        duplicateCount: duplicateMatches.length,
      });
      normalized.meta.reviewStatus = flow.reviewStatus;
      normalized.meta.autoBookEligible = flow.autoBookEligible;
      normalized.meta.controlFlags = flow.flags;
      normalized.meta.duplicateKey = duplicateKey;
      normalized.meta.duplicateCount = duplicateMatches.length;
      normalized.meta.duplicateMatches = duplicateMatches;

      // 9. Save to database
      const updates: Record<string, any> = {
        status: "COMPLETED",
        reviewStatus: flow.reviewStatus,
        autoBookEligible: flow.autoBookEligible,
        controlFlags: flow.flags,
        warnings,
        updatedAt: new Date().toISOString(),
        extractedJson: normalized,
        confidence,
        vendorName: normalized.vendor?.name ?? null,
        buyerName: normalized.buyer?.name ?? null,
        invoiceNumber: normalized.invoice?.invoiceNumber ?? null,
        purchaseOrderNumber: normalized.invoice?.purchaseOrderNumber ?? null,
        invoiceType: normalized.invoice?.invoiceType ?? null,
        netSuiteTransactionIntent: normalized.invoice?.transactionIntent ?? null,
        currency: normalized.invoice?.currency ?? null,
        totalAmount: normalized.invoice?.totalAmount ?? null,
        duplicateCount: duplicateMatches.length,
        duplicateMatches,
        modelUsed,
      };

      if (duplicateKey) {
        updates.duplicatePk = duplicateKey;
        updates.duplicateSk = `${normalized.invoice?.invoiceDate ?? receivedAt}#${messageId}#${attachmentId}`;
      }

      await updateItem(
        TABLE_NAME,
        { messageId, attachmentKey },
        updates
      );

      emitMetric("ExtractionSuccess", 1, "Count", { Model: modelUsed });
      emitMetric("ExtractionDurationMs", Date.now() - startTime, "Milliseconds");
      log.info("Extraction complete", { messageId, confidence, modelUsed });
    } catch (err: any) {
      log.error("Extraction failed", { messageId, attachmentKey, error: err?.message ?? String(err) });
      if (messageId && attachmentKey) {
        await updateItem(
          TABLE_NAME,
          { messageId, attachmentKey },
          {
            status: "FAILED",
            updatedAt: new Date().toISOString(),
            errors: [err?.message ?? String(err)],
          }
        );
      }
      emitMetric("ExtractionFailure", 1, "Count");
    }
  }
};

/**
 * Prepare document for AI processing.
 * PDFs are sent directly to Claude which can read them natively.
 */
function prepareDocument(attachmentKey: string, attachment: Buffer, contentType?: string): DocumentInput {
  const lower = attachmentKey.toLowerCase();
  const ct = (contentType ?? "").toLowerCase();
  const data = attachment.toString("base64");

  // Prefer the stored content-type over the key extension: emailed attachments may be
  // stored with a sanitized, extension-less filename, so the suffix can be missing.
  if (ct === "application/pdf" || lower.endsWith(".pdf")) {
    return { mediaType: "application/pdf", data };
  }
  if (ct === "image/png" || lower.endsWith(".png")) {
    return { mediaType: "image/png", data };
  }
  if (ct === "image/jpeg" || ct === "image/jpg" || lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return { mediaType: "image/jpeg", data };
  }

  // Default to PDF for unknown types.
  return { mediaType: "application/pdf", data };
}

/**
 * Parse JSON from AI response, handling common issues
 */
function parseJsonResponse(text: string | undefined): any {
  if (!text) return null;

  // Clean up common issues
  let cleaned = text.trim();

  // Extract content from markdown code fence if present (handles prose-prefixed responses)
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1];
  }

  // Find the JSON object
  const startIdx = cleaned.indexOf("{");
  const endIdx = cleaned.lastIndexOf("}");

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  const jsonStr = cleaned.slice(startIdx, endIdx + 1);

  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * Normalize extraction to ensure consistent structure
 */
function normalizeExtraction(raw: any): any {
  const srcVendor = raw.vendor ?? raw.supplier ?? raw.seller ?? {};
  const srcBuyer = raw.buyer ?? raw.customer ?? raw.billTo ?? raw.recipient ?? {};
  const srcInvoice = raw.invoice ?? raw;

  return {
    vendor: {
      name: firstPresent(srcVendor.name, raw.vendorName, raw.vendor_name, raw.supplierName, raw.sellerName, raw.name),
      taxId: firstPresent(srcVendor.taxId, srcVendor.vatNumber, srcVendor.vatId, raw.taxId, raw.vatNumber, raw.vat),
      address: firstPresent(srcVendor.address, raw.vendorAddress),
      email: firstPresent(srcVendor.email, raw.vendorEmail),
      bankDetails: normalizeBankDetails(
        firstPresent(srcVendor.bankDetails, srcVendor.bank, raw.bankDetails, raw.vendorBankDetails, raw.paymentDetails),
        raw
      ),
    },
    buyer: {
      name: firstPresent(srcBuyer.name, raw.buyerName, raw.customerName, raw.billToName, raw.recipientName),
      taxId: firstPresent(srcBuyer.taxId, srcBuyer.vatNumber, srcBuyer.vatId, raw.buyerTaxId, raw.customerTaxId),
      address: firstPresent(srcBuyer.address, raw.buyerAddress, raw.customerAddress, raw.billToAddress),
      email: firstPresent(srcBuyer.email, raw.buyerEmail, raw.customerEmail),
      entityCode: firstPresent(srcBuyer.entityCode, raw.entityCode, raw.subsidiaryCode),
    },
    invoice: {
      invoiceNumber: firstPresent(srcInvoice.invoiceNumber, raw.invoiceNumber, raw.invoice_number, raw.number),
      purchaseOrderNumber:
        firstPresent(
          srcInvoice.purchaseOrderNumber,
          srcInvoice.poNumber,
          srcInvoice.po,
          srcInvoice.purchaseOrder,
          raw.purchaseOrderNumber,
          raw.poNumber,
          raw.po_number,
          raw.po,
          raw.purchaseOrder,
          raw.purchase_order
        ),
      invoiceType: normalizeInvoiceType(firstPresent(srcInvoice.invoiceType, srcInvoice.type, raw.invoiceType, raw.invoice_type, raw.type)),
      transactionIntent: normalizeTransactionIntent(
        firstPresent(srcInvoice.transactionIntent, srcInvoice.netSuiteTransactionIntent, raw.transactionIntent)
      ),
      invoiceDate: firstPresent(srcInvoice.invoiceDate, raw.invoiceDate, raw.invoice_date, raw.date),
      dueDate: firstPresent(srcInvoice.dueDate, raw.dueDate, raw.due_date),
      currency: normalizeCurrency(firstPresent(srcInvoice.currency, raw.currency)),
      paymentTerms: firstPresent(srcInvoice.paymentTerms, srcInvoice.terms, raw.paymentTerms, raw.terms),
      description: firstPresent(srcInvoice.description, srcInvoice.memo, raw.description, raw.memo),
      servicePeriod: normalizeServicePeriod(srcInvoice.servicePeriod ?? raw.servicePeriod ?? raw.period),
      servicePeriodStart: firstPresent(srcInvoice.servicePeriodStart, raw.servicePeriodStart, raw.periodStart),
      servicePeriodEnd: firstPresent(srcInvoice.servicePeriodEnd, raw.servicePeriodEnd, raw.periodEnd),
      remittanceReference: firstPresent(srcInvoice.remittanceReference, raw.remittanceReference, raw.paymentReference),
      totalAmount: parseNumber(firstPresent(srcInvoice.totalAmount, raw.totalAmount, raw.total, raw.amount)),
      taxAmount: parseNumber(firstPresent(srcInvoice.taxAmount, raw.taxAmount, raw.tax, raw.vat)),
      netAmount: parseNumber(firstPresent(srcInvoice.netAmount, raw.netAmount, raw.subtotal, raw.subTotal)),
    },
    lineItems: normalizeLineItems(raw.lineItems ?? raw.items ?? raw.lines ?? []),
  };
}

function normalizeLineItems(items: any[]): any[] {
  if (!Array.isArray(items)) return [];
  return items.map((line, index) => ({
    lineNumber: parseNumber(firstPresent(line?.lineNumber, line?.line, line?.position)) ?? index + 1,
    description: firstPresent(line?.description, line?.memo, line?.name, line?.item) ?? null,
    quantity: parseNumber(firstPresent(line?.quantity, line?.qty)),
    unitPrice: parseNumber(firstPresent(line?.unitPrice, line?.rate, line?.price)),
    amount: parseNumber(firstPresent(line?.amount, line?.netAmount, line?.total)),
    taxRate: parseTaxRate(firstPresent(line?.taxRate, line?.vatRate, line?.taxPercent, line?.vatPercent)),
    account: firstPresent(line?.account, line?.glAccount, line?.glCode, line?.expenseAccount),
    department: firstPresent(line?.department, line?.departmentCode),
    costCenter: firstPresent(line?.costCenter, line?.costCentre, line?.class),
    project: firstPresent(line?.project, line?.projectCode, line?.job),
  }));
}

function firstPresent(...values: any[]): any {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    return value;
  }
  return null;
}

function normalizeCurrency(value: any): string | null {
  const s = String(value ?? "").trim().toUpperCase();
  if (!s) return null;
  const symbols: Record<string, string> = { "€": "EUR", "$": "USD", "£": "GBP" };
  return symbols[s] ?? s;
}

function normalizeInvoiceType(value: any): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (/mahnung|reminder|dunning/i.test(s)) return "Reminder";
  if (/credit|gutschrift|credit\s*note/i.test(s)) return "CreditNote";
  if (/pro\s*forma|proforma/i.test(s)) return "Proforma";
  if (/rechnung|invoice|vat\s*invoice|standard/i.test(s)) return "Standard";
  return s;
}

function normalizeTransactionIntent(value: any): "VendorBill" | "VendorPrepayment" | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (/prepayment|pre\s*payment|vendor\s*prepayment/i.test(s)) return "VendorPrepayment";
  if (/bill|invoice|vendor\s*bill/i.test(s)) return "VendorBill";
  return null;
}

function normalizeServicePeriod(value: any): any {
  if (!value || typeof value !== "object") return null;
  return {
    startDate: firstPresent(value.startDate, value.start, value.from),
    endDate: firstPresent(value.endDate, value.end, value.to),
  };
}

function normalizeBankDetails(bank: any, raw: any): any {
  const ibans = uniqueStrings([
    ...asArray(bank?.ibans),
    bank?.iban,
    bank?.accountIban,
    raw?.iban,
    raw?.vendorIban,
  ].flatMap(extractIbans));

  const bics = uniqueStrings([
    ...asArray(bank?.bics),
    bank?.bic,
    bank?.swift,
    raw?.bic,
    raw?.swift,
  ].flatMap(extractBics));

  return {
    ibans,
    bic: firstPresent(bics[0], bank?.bic, bank?.swift, raw?.bic, raw?.swift),
    bankName: firstPresent(bank?.bankName, bank?.name, raw?.bankName),
    accountName: firstPresent(bank?.accountName, raw?.accountName),
    accountNumber: firstPresent(bank?.accountNumber, raw?.accountNumber),
  };
}

function asArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

function uniqueStrings(values: any[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const s = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!s) continue;
    const key = s.toUpperCase().replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function extractIbans(value: any): string[] {
  const s = String(value ?? "").toUpperCase();
  return s.match(/[A-Z]{2}\d{2}[A-Z0-9 ]{8,34}/g) ?? [];
}

function extractBics(value: any): string[] {
  const s = String(value ?? "").toUpperCase();
  return s.match(/[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?/g) ?? [];
}

function parseTaxRate(value: any): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = parseMoney(String(value).replace("%", ""));
  return parsed;
}

/**
 * Parse a number from various formats
 */
function parseNumber(val: any): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    return parseMoney(val);
  }
  return null;
}

function parseMoney(input: string): number | null {
  let s = input.trim();
  // remove currency symbols and non-number separators except . , -
  s = s.replace(/[^\d.,\-]/g, "");
  if (!s) return null;

  // Handle European formats like 1.234,56 (thousands '.' decimal ',')
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    // Determine format by which separator appears last: the last one is the decimal
    if (s.lastIndexOf(".") > s.lastIndexOf(",")) {
      // US format: 1,234.56 — comma is thousands, dot is decimal
      s = s.replace(/,/g, "");
    } else {
      // European format: 1.234,56 — dot is thousands, comma is decimal
      s = s.replace(/\./g, "").replace(",", ".");
    }
  } else if (hasComma && !hasDot) {
    s = s.replace(",", ".");
  }

  const num = parseFloat(s);
  return Number.isFinite(num) ? num : null;
}

/**
 * Light reconciliation for edge cases.
 * With Claude reading PDFs directly, most extraction should be accurate,
 * but we still handle proforma tagging and PO cleanup.
 */
function reconcileExtraction(extracted: any, warnings: string[]) {
  if (!extracted || typeof extracted !== "object") return;

  // Proforma invoices are tagged with the neutral type "Proforma"; the ERP transform
  // (e.g. NetSuite) decides how to handle it. (Was the Oracle-specific "Prepayment".)
  const currentType = String(extracted?.invoice?.invoiceType ?? "").trim();
  const looksProforma = /pro\s*forma|proforma/i.test(currentType);
  if (looksProforma) {
    extracted.invoice = extracted.invoice ?? {};
    if (extracted.invoice.invoiceType !== "Proforma") {
      extracted.invoice.invoiceType = "Proforma";
      warnings.push("tagged_proforma");
    }
    if (extracted.invoice.transactionIntent !== "VendorPrepayment") {
      extracted.invoice.transactionIntent = "VendorPrepayment";
      warnings.push("tagged_proforma_prepayment");
    }
  } else if (!extracted.invoice.transactionIntent) {
    extracted.invoice.transactionIntent = "VendorBill";
  }

  // Clean up PO number if it contains labels or garbage
  const poRaw = String(extracted?.invoice?.purchaseOrderNumber ?? "").trim();
  if (poRaw && poRaw !== "null") {
    const cleaned = sanitizePurchaseOrderNumber(poRaw);
    if (cleaned && cleaned !== poRaw) {
      extracted.invoice.purchaseOrderNumber = cleaned;
      warnings.push("sanitized_purchase_order_number");
    } else if (!cleaned) {
      extracted.invoice.purchaseOrderNumber = null;
    }
  } else {
    extracted.invoice.purchaseOrderNumber = null;
  }
}

function sanitizePurchaseOrderNumber(input: string): string | null {
  if (!input) return null;
  let s = input.trim();

  // Remove common labels if the model included them
  s = s.replace(
    /^\s*(?:po|p\.o\.|purchase\s*order|order\s*(?:no|number|nr|n[oº°])|n[úu]mero\s+de\s+orden\s+de\s+compra|orden\s+de\s+compra|n[úu]mero\s+de\s+pedido|bon\s+de\s+commande|bestellnummer|auftragsnummer|ordine\s+d['']?acquisto)\s*[:#]?\s*/i,
    ""
  );

  // Keep only plausible code characters
  s = s.replace(/[^A-Za-z0-9\-\/\.]/g, "");

  // Must contain at least one digit to be a plausible identifier
  if (!/\d/.test(s)) return null;

  // Avoid absurdly short values
  if (s.length < 3) return null;

  return s;
}
