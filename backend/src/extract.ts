import { SQSEvent } from "aws-lambda";
import { getObjectBuffer } from "./shared/s3";
import { updateItem } from "./shared/dynamo";
import { invokeBedrock, DocumentInput } from "./shared/bedrock";
import { buildExtractionPrompt, buildRepairPrompt } from "./shared/prompts";
import { calculateConfidence } from "./shared/confidence";
import { log } from "./shared/logger";
import { emitMetric } from "./shared/metrics";

const ATTACHMENT_BUCKET = process.env.ATTACHMENT_BUCKET ?? "";
const TABLE_NAME = process.env.TABLE_NAME ?? "";
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-5-sonnet-20240620-v1:0";

export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    const payload = JSON.parse(record.body);
    const { messageId, attachmentId, attachmentKey, receivedAt, from, subject } = payload;
    const startTime = Date.now();

    try {
      const warnings: string[] = [];

      // 1. Get the file from S3
      const attachment = await getObjectBuffer(ATTACHMENT_BUCKET, attachmentKey);

      // 2. Prepare document for AI (PDF sent directly to Claude)
      const doc = prepareDocument(attachmentKey, attachment);
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
        log.warn("First parse failed, trying repair", { responseSnippet: response.text?.slice(0, 200) });
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

      // 8. Save to database
      await updateItem(
        TABLE_NAME,
        { messageId, attachmentKey },
        {
          status: "COMPLETED",
          updatedAt: new Date().toISOString(),
          extractedJson: normalized,
          confidence,
          vendorName: normalized.vendor?.name ?? null,
          invoiceNumber: normalized.invoice?.invoiceNumber ?? null,
          currency: normalized.invoice?.currency ?? null,
          totalAmount: normalized.invoice?.totalAmount ?? null,
          modelUsed,
        }
      );

      emitMetric("ExtractionSuccess", 1, "Count", { Model: modelUsed });
      emitMetric("ExtractionDurationMs", Date.now() - startTime, "Milliseconds");
      log.info("Extraction complete", { messageId, confidence, modelUsed });
    } catch (err: any) {
      log.error("Extraction failed", { messageId, attachmentKey, error: err?.message ?? String(err) });
      await updateItem(
        TABLE_NAME,
        { messageId, attachmentKey },
        {
          status: "FAILED",
          updatedAt: new Date().toISOString(),
          errors: [err?.message ?? String(err)],
        }
      );
      emitMetric("ExtractionFailure", 1, "Count");
    }
  }
};

/**
 * Prepare document for AI processing.
 * PDFs are sent directly to Claude which can read them natively.
 */
function prepareDocument(attachmentKey: string, attachment: Buffer): DocumentInput {
  const lower = attachmentKey.toLowerCase();

  if (lower.endsWith(".pdf")) {
    return {
      mediaType: "application/pdf",
      data: attachment.toString("base64"),
    };
  }

  if (lower.endsWith(".png")) {
    return {
      mediaType: "image/png",
      data: attachment.toString("base64"),
    };
  }

  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return {
      mediaType: "image/jpeg",
      data: attachment.toString("base64"),
    };
  }

  // Default to PDF for unknown types
  return {
    mediaType: "application/pdf",
    data: attachment.toString("base64"),
  };
}

/**
 * Parse JSON from AI response, handling common issues
 */
function parseJsonResponse(text: string | undefined): any {
  if (!text) return null;

  // Clean up common issues
  let cleaned = text.trim();

  // Remove markdown code fences
  cleaned = cleaned.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "");

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
  // If already has proper structure, use it
  if (raw.vendor && raw.invoice) {
    return {
      vendor: {
        name: raw.vendor.name ?? null,
        taxId: raw.vendor.taxId ?? null,
        address: raw.vendor.address ?? null,
      },
      invoice: {
        invoiceNumber: raw.invoice.invoiceNumber ?? null,
        purchaseOrderNumber:
          raw.invoice.purchaseOrderNumber ?? raw.invoice.poNumber ?? raw.invoice.po ?? raw.invoice.purchaseOrder ?? null,
        invoiceType: raw.invoice.invoiceType ?? raw.invoice.type ?? null,
        invoiceDate: raw.invoice.invoiceDate ?? null,
        dueDate: raw.invoice.dueDate ?? null,
        currency: raw.invoice.currency ?? null,
        totalAmount: parseNumber(raw.invoice.totalAmount),
        taxAmount: parseNumber(raw.invoice.taxAmount),
      },
      lineItems: Array.isArray(raw.lineItems) ? raw.lineItems : [],
    };
  }

  // Handle flat structure - map common field names
  return {
    vendor: {
      name: raw.vendorName ?? raw.vendor_name ?? raw.supplierName ?? raw.name ?? null,
      taxId: raw.taxId ?? raw.vatNumber ?? raw.vat ?? null,
      address: raw.vendorAddress ?? raw.address ?? null,
    },
    invoice: {
      invoiceNumber: raw.invoiceNumber ?? raw.invoice_number ?? raw.number ?? null,
      purchaseOrderNumber:
        raw.purchaseOrderNumber ?? raw.poNumber ?? raw.po_number ?? raw.po ?? raw.purchaseOrder ?? raw.purchase_order ?? null,
      invoiceType: raw.invoiceType ?? raw.invoice_type ?? raw.type ?? null,
      invoiceDate: raw.invoiceDate ?? raw.invoice_date ?? raw.date ?? null,
      dueDate: raw.dueDate ?? raw.due_date ?? null,
      currency: raw.currency ?? null,
      totalAmount: parseNumber(raw.totalAmount ?? raw.total ?? raw.amount),
      taxAmount: parseNumber(raw.taxAmount ?? raw.tax ?? raw.vat),
    },
    lineItems: raw.lineItems ?? raw.items ?? raw.lines ?? [],
  };
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
    // assume dot is thousands separator
    s = s.replace(/\./g, "").replace(",", ".");
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

  // Proforma invoices should be tagged as "Prepayment" for Oracle Fusion purposes.
  const currentType = String(extracted?.invoice?.invoiceType ?? "").trim();
  const looksProforma = /pro\s*forma|proforma/i.test(currentType);
  if (looksProforma) {
    extracted.invoice = extracted.invoice ?? {};
    if (extracted.invoice.invoiceType !== "Prepayment") {
      extracted.invoice.invoiceType = "Prepayment";
      warnings.push("tagged_prepayment_from_proforma");
    }
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
