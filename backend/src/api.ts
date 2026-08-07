import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { queryInvoices, updateItem, docClient } from "./shared/dynamo";
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import {
  buildNetSuiteConfigurationHints,
  createNetSuiteVendor,
  deriveNetSuiteVendorCreationInput,
  getAccessToken,
  suiteql,
  transformToNetSuite,
  validateNetSuiteRequest,
  type NetSuiteConfig,
} from "./shared/netsuite";
import { loadNetSuiteConfig } from "./shared/netsuite-config";
import { loadNetSuiteSecret } from "./shared/netsuite-secret";
import {
  activeNetSuiteEnvironment,
  getNetSuiteRuntimeSettings,
  saveNetSuiteRuntimeSettings,
  type NetSuiteRuntimeSettings,
} from "./shared/netsuite-settings";
import {
  assessInvoiceFlow,
  normalizeDuplicateReview,
  type DocumentKind,
  type DuplicateReviewAction,
} from "./shared/flow";
import {
  canReplay,
  createNetSuiteTransactionIfNeeded,
  getNetSuiteTransaction,
  listNetSuiteTransactions,
  markTransactionFailed,
  markTransactionQueued,
  summarizeTransaction,
  type NetSuiteTransactionStatus,
} from "./shared/transactions";
import { computeStats } from "./shared/stats";
import { log } from "./shared/logger";

const TABLE_NAME = process.env.TABLE_NAME ?? "";
const ATTACHMENT_BUCKET = process.env.ATTACHMENT_BUCKET ?? "";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? "0");
const NETSUITE_QUEUE_URL = process.env.NETSUITE_QUEUE_URL ?? "";
const NETSUITE_LIVE_PUSH_ENABLED = process.env.NETSUITE_LIVE_PUSH_ENABLED === "true";
const NETSUITE_SECRET_ARN = process.env.NETSUITE_SECRET_ARN ?? "";
const REQUIRED_GROUPS = new Set(["invoice", "invoice-admin"]);
const s3 = new S3Client({});
const sqs = new SQSClient({});

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  if (!hasAppAccess(event)) {
    return jsonResponse({ message: "Invoice Ingestion access is required." }, 403);
  }

  const path = event.rawPath ?? "";
  if (path === "/stats" && event.requestContext.http.method === "GET") {
    return getStats();
  }
  if (path === "/invoices") {
    return listInvoices(event);
  }
  if (path === "/upload" && event.requestContext.http.method === "POST") {
    return createUpload(event);
  }
  if (path === "/config/netsuite" && event.requestContext.http.method === "GET") {
    return getNetSuiteSettings();
  }
  if (path === "/config/netsuite" && event.requestContext.http.method === "POST") {
    return updateNetSuiteSettings(event);
  }
  if (path === "/netsuite/transactions" && event.requestContext.http.method === "GET") {
    return listNetSuiteTransactionLog(event);
  }
  if (path === "/netsuite/transactions/replay" && event.requestContext.http.method === "POST") {
    return replayNetSuiteTransactions(event);
  }
  if (
    path.startsWith("/netsuite/transactions/") &&
    path.endsWith("/replay") &&
    event.requestContext.http.method === "POST"
  ) {
    return replayNetSuiteTransaction(event);
  }
  if (
    path.startsWith("/invoices/") &&
    path.endsWith("/netsuite/transactions") &&
    event.requestContext.http.method === "POST"
  ) {
    return createNetSuiteTransactionForInvoice(event);
  }
  if (
    path.startsWith("/invoices/") &&
    path.endsWith("/netsuite/vendor") &&
    event.requestContext.http.method === "POST"
  ) {
    return createNetSuiteVendorForInvoice(event);
  }
  if (path === "/netsuite/departments" && event.requestContext.http.method === "GET") {
    return listNetSuiteDepartments();
  }
  if (
    path.startsWith("/invoices/") &&
    path.endsWith("/netsuite/department") &&
    event.requestContext.http.method === "POST"
  ) {
    return setNetSuiteDepartmentOverride(event);
  }
  if (
    path.startsWith("/invoices/") &&
    path.endsWith("/duplicate-review") &&
    event.requestContext.http.method === "POST"
  ) {
    return updateDuplicateReview(event);
  }
  if (path.startsWith("/invoices/") && path.endsWith("/netsuite")) {
    return getNetSuiteFormat(event);
  }
  if (path.startsWith("/invoices/") && event.requestContext.http.method === "DELETE") {
    return deleteInvoice(event);
  }
  if (path.endsWith("/download")) {
    return downloadAttachment(event);
  }
  return getInvoiceDetail(event);
};

async function listInvoices(event: APIGatewayProxyEventV2) {
  const limit = Math.min(Number(event.queryStringParameters?.limit ?? 25), 100);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 25;
  const nextToken = event.queryStringParameters?.nextToken;
  let result: Awaited<ReturnType<typeof queryInvoices>>;
  try {
    result = await queryInvoices(TABLE_NAME, safeLimit, nextToken);
  } catch (err: any) {
    if (err?.statusCode === 400) {
      return jsonResponse({ message: err.message }, 400);
    }
    throw err;
  }
  const items = await Promise.all(result.items.map(async (rawItem: any) => {
    const item = withDerivedFlow(rawItem);
    // The mirrored netSuiteTransactionStatus only reflects the status at creation
    // time — the worker updates the transaction record as it progresses but never
    // writes back to the invoice row. Read the transaction live so the list can't
    // show a stale "queued" for something that has since succeeded or failed.
    let netSuiteTransactionStatus = item.netSuiteTransactionStatus;
    if (item.netSuiteTransactionId) {
      const transaction = await getNetSuiteTransaction(TABLE_NAME, item.netSuiteTransactionId);
      if (transaction) netSuiteTransactionStatus = transaction.status;
    }
    return {
      messageId: item.messageId,
      attachmentId: item.attachmentId,
      attachmentKey: item.attachmentKey,
      receivedAt: item.receivedAt,
      from: item.from,
      subject: item.subject,
      status: item.status,
      displayStatus: computeDisplayStatus(item, netSuiteTransactionStatus, item.documentKind),
      documentKind: item.documentKind,
      reviewStatus: item.reviewStatus ?? item.extractedJson?.meta?.reviewStatus,
      autoBookEligible: item.autoBookEligible ?? item.extractedJson?.meta?.autoBookEligible,
      controlFlags: item.controlFlags ?? item.extractedJson?.meta?.controlFlags ?? [],
      netSuiteTransactionStatus,
      netSuiteBookingMode: item.netSuiteBookingMode,
      confidence: item.confidence,
      warnings: item.warnings ?? [],
      vendorName: item.vendorName,
      vendorTaxId: item.vendorTaxId ?? item.extractedJson?.vendor?.taxId,
      vendorVatStatus: item.vendorVatStatus ?? item.extractedJson?.vendor?.vatValidation?.status,
      vendorVatValid: item.vendorVatValid ?? item.extractedJson?.vendor?.vatValidation?.valid,
      buyerName: item.buyerName,
      invoiceNumber: item.invoiceNumber,
      purchaseOrderNumber: item.purchaseOrderNumber,
      purchaseOrderLookupKey: item.purchaseOrderLookupKey ?? item.extractedJson?.invoice?.purchaseOrderLookupKey,
      invoiceType: item.invoiceType,
      netSuiteTransactionIntent: item.netSuiteTransactionIntent ?? item.extractedJson?.invoice?.transactionIntent,
      currency: item.currency,
      totalAmount: item.totalAmount,
      duplicateCount: item.duplicateCount ?? item.extractedJson?.meta?.duplicateCount ?? 0,
    };
  }));

  return jsonResponse({ items, nextToken: result.nextToken });
}

async function getStats() {
  return jsonResponse(await computeStats(TABLE_NAME));
}

async function getInvoiceDetail(event: APIGatewayProxyEventV2) {
  const messageId = event.pathParameters?.messageId ?? "";
  const attachmentId = event.pathParameters?.attachmentId ?? "";

  const item = await findByAttachmentId(messageId, attachmentId);
  if (!item) {
    return jsonResponse({ message: "Not found" }, 404);
  }

  const derived = withDerivedFlow(item);
  const referenceDocuments =
    derived.documentKind === "SUPPORTING_DOCUMENT" ? [] : await listReferenceDocuments(item);

  if (item.netSuiteTransactionId) {
    const transaction = await getNetSuiteTransaction(TABLE_NAME, item.netSuiteTransactionId);
    if (transaction) {
      return jsonResponse({
        ...derived,
        referenceDocuments,
        netSuiteTransaction: summarizeTransaction(transaction),
        // Prefer the live transaction status over the (possibly lagging) mirrored one.
        displayStatus: computeDisplayStatus(item, transaction.status, derived.documentKind),
      });
    }
  }
  return jsonResponse({ ...derived, referenceDocuments });
}

async function getNetSuiteFormat(event: APIGatewayProxyEventV2) {
  const messageId = event.pathParameters?.messageId ?? "";
  const attachmentId = event.pathParameters?.attachmentId ?? "";

  const item = await findByAttachmentId(messageId, attachmentId);
  if (!item) {
    return jsonResponse({ message: "Not found" }, 404);
  }

  try {
    const preview = await buildNetSuitePreview(item);

    return jsonResponse({
      netsuiteFormat: preview.bill,
      netSuiteRequest: preview.request,
      netSuiteEnvironment: {
        activeEnvironment: preview.runtimeSettings.activeEnvironment,
        endpoint: preview.activeEnvironment,
      },
      warnings: preview.warnings,
      configurationHints: preview.configurationHints,
      validation: preview.validation,
      flow: preview.flow,
      originalExtraction: item.extractedJson,
    });
  } catch (error: any) {
    log.error("NetSuite transform failed", {
      messageId,
      attachmentId,
      error: error?.message ?? String(error),
    });
    return jsonResponse({ message: "Failed to transform invoice" }, 500);
  }
}

async function createNetSuiteTransactionForInvoice(event: APIGatewayProxyEventV2) {
  const messageId = event.pathParameters?.messageId ?? "";
  const attachmentId = event.pathParameters?.attachmentId ?? "";

  const item = await findByAttachmentId(messageId, attachmentId);
  if (!item) {
    return jsonResponse({ message: "Not found" }, 404);
  }
  if (item.status !== "COMPLETED" || !item.extractedJson) {
    return jsonResponse({ message: "Invoice extraction is not complete." }, 409);
  }

  try {
    const preview = await buildNetSuitePreview(item);

    // Only invoices go to NetSuite. Supporting material (cost-allocation
    // schedules, rate notifications, remittance summaries) stays here for
    // reference. Enforced server-side, not just hidden in the UI, so a stale
    // browser tab or a direct API call can't post a non-invoice as a bill.
    if (preview.flow.documentKind === "SUPPORTING_DOCUMENT") {
      return jsonResponse(
        {
          message:
            "This attachment is a supporting document, not an invoice. It's kept for reference and isn't sent to NetSuite.",
          documentKind: preview.flow.documentKind,
        },
        409
      );
    }

    let status: NetSuiteTransactionStatus = "QUEUED";
    let eventMessage = "Transaction logged and queued for NetSuite push.";

    // A human clicking this IS the review — only a real blocker (missing vendor,
    // unresolved duplicate, unresolved NetSuite placeholder, etc.) should refuse
    // the push. Advisory warnings the auto-book path holds on are fine to send
    // once someone has looked at them.
    if (preview.flow.hasBlockingFlags) {
      status = "HELD_FOR_REVIEW";
      eventMessage = "Transaction logged but held for AP review.";
    } else if (!NETSUITE_LIVE_PUSH_ENABLED) {
      status = "HELD_FOR_CONFIGURATION";
      eventMessage = "Transaction logged but live NetSuite push is disabled.";
    }

    const { transaction, created } = await createNetSuiteTransactionIfNeeded(
      TABLE_NAME,
      { messageId: item.messageId, attachmentKey: item.attachmentKey, attachmentId: item.attachmentId, netSuiteTransactionId: item.netSuiteTransactionId },
      {
        externalId: preview.request.externalId,
        requestPayload: preview.request,
        validation: preview.validation,
        flow: preview.flow,
        warnings: preview.warnings,
        status,
        eventMessage,
        bookingMode: "MANUAL",
        bookedBy: actorFromEvent(event),
      }
    );

    if (!created) {
      return jsonResponse({
        message: "This invoice already has a logged NetSuite transaction.",
        transaction: summarizeTransaction(transaction),
        flow: preview.flow,
        validation: preview.validation,
        configurationHints: preview.configurationHints,
        queued: false,
      });
    }

    if (status === "QUEUED") {
      try {
        await enqueueNetSuiteTransaction(transaction.transactionId);
      } catch (err: any) {
        await markTransactionFailed(
          TABLE_NAME,
          transaction.transactionId,
          true,
          `Failed to enqueue transaction: ${err?.message ?? String(err)}`
        );
        return jsonResponse(
          {
            message: "Transaction was logged but could not be queued. It can be replayed.",
            transaction: summarizeTransaction({ ...transaction, status: "FAILED_RETRYABLE" }),
          },
          202
        );
      }
    }

    return jsonResponse(
      {
        transaction: summarizeTransaction(transaction),
        flow: preview.flow,
        validation: preview.validation,
        configurationHints: preview.configurationHints,
        queued: status === "QUEUED",
      },
      status === "QUEUED" ? 202 : 200
    );
  } catch (error: any) {
    log.error("NetSuite transaction logging failed", {
      messageId,
      attachmentId,
      error: error?.message ?? String(error),
    });
    return jsonResponse({ message: "Failed to log NetSuite transaction" }, 500);
  }
}

/**
 * Explicit, AP-triggered action: create a new NetSuite vendor from this
 * invoice's VAT-registry lookup data (officially registered name where VIES/
 * Swiss UID returned one, falling back to the extracted name), then stamp the
 * new vendor id onto the invoice so the next preview/push uses it instead of
 * the static crosswalk. Never runs automatically - only this button calls it.
 */
async function createNetSuiteVendorForInvoice(event: APIGatewayProxyEventV2) {
  const messageId = event.pathParameters?.messageId ?? "";
  const attachmentId = event.pathParameters?.attachmentId ?? "";

  const item = await findByAttachmentId(messageId, attachmentId);
  if (!item) {
    return jsonResponse({ message: "Not found" }, 404);
  }
  if (item.status !== "COMPLETED" || !item.extractedJson) {
    return jsonResponse({ message: "Invoice extraction is not complete." }, 409);
  }

  try {
    const preview = await buildNetSuitePreview(item);

    if (preview.bill.entity?.id) {
      return jsonResponse(
        { message: "This invoice's vendor is already resolved; not creating a duplicate." },
        409
      );
    }

    const vendorInput = deriveNetSuiteVendorCreationInput(
      item.extractedJson,
      preview.bill.subsidiary?.id,
      preview.bill.currency?.id
    );
    if (!vendorInput) {
      return jsonResponse(
        { message: "Not enough vendor data on this invoice (no name and no VAT-registry name) to create a NetSuite vendor." },
        400
      );
    }

    const secret = await loadNetSuiteSecret(preview.activeEnvironment.secretArn || NETSUITE_SECRET_ARN);
    const token = await getAccessToken(secret, preview.activeEnvironment);
    const created = await createNetSuiteVendor(secret, token, vendorInput, preview.activeEnvironment);

    const updatedExtractedJson = {
      ...item.extractedJson,
      vendor: { ...item.extractedJson.vendor, resolvedNetSuiteVendorId: created.vendorId },
    };
    await updateItem(
      TABLE_NAME,
      { messageId: item.messageId, attachmentKey: item.attachmentKey },
      { extractedJson: updatedExtractedJson, updatedAt: new Date().toISOString() }
    );

    const refreshedPreview = await buildNetSuitePreview({ ...item, extractedJson: updatedExtractedJson });

    log.info("NetSuite vendor created from invoice", {
      messageId,
      attachmentId,
      vendorId: created.vendorId,
      companyName: created.companyName,
      actor: actorFromEvent(event),
    });

    return jsonResponse({
      created: true,
      vendorId: created.vendorId,
      companyName: created.companyName,
      flow: refreshedPreview.flow,
      validation: refreshedPreview.validation,
    });
  } catch (error: any) {
    log.error("NetSuite vendor creation failed", {
      messageId,
      attachmentId,
      error: error?.message ?? String(error),
    });
    return jsonResponse({ message: `Failed to create NetSuite vendor: ${error?.message ?? String(error)}` }, 502);
  }
}

/**
 * Live list of active NetSuite departments, for the manual department
 * selector in the admin console. Not cached - this is an infrequent,
 * human-driven interaction, not a hot path, and a live list is always
 * correct rather than possibly stale.
 */
async function listNetSuiteDepartments() {
  try {
    const runtimeSettings = await getNetSuiteRuntimeSettings(TABLE_NAME);
    const activeEnvironment = activeNetSuiteEnvironment(runtimeSettings);
    const secret = await loadNetSuiteSecret(activeEnvironment.secretArn || NETSUITE_SECRET_ARN);
    const token = await getAccessToken(secret, activeEnvironment);
    const { items } = await suiteql(
      secret,
      token,
      "SELECT id, name FROM department WHERE isinactive = 'F' ORDER BY name",
      activeEnvironment
    );
    return jsonResponse({
      departments: items.map((i) => ({ id: String(i.id), name: String(i.name) })),
    });
  } catch (error: any) {
    log.error("Listing NetSuite departments failed", { error: error?.message ?? String(error) });
    return jsonResponse({ message: `Failed to list NetSuite departments: ${error?.message ?? String(error)}` }, 502);
  }
}

/**
 * Explicit, AP-triggered action: manually set the department for this
 * invoice's NetSuite push, for when business-unit routing can't resolve one
 * and there's no configured default (department is a hard NetSuite
 * requirement on this account's vendor bill form - see
 * validateNetSuiteVendorBill). Stamped onto extractedJson.netSuiteOverrides,
 * which transformToNetSuite checks ahead of business-unit routing/defaults.
 */
async function setNetSuiteDepartmentOverride(event: APIGatewayProxyEventV2) {
  const messageId = event.pathParameters?.messageId ?? "";
  const attachmentId = event.pathParameters?.attachmentId ?? "";

  const item = await findByAttachmentId(messageId, attachmentId);
  if (!item) {
    return jsonResponse({ message: "Not found" }, 404);
  }
  if (item.status !== "COMPLETED" || !item.extractedJson) {
    return jsonResponse({ message: "Invoice extraction is not complete." }, 409);
  }

  let body: any;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return jsonResponse({ message: "Invalid JSON body." }, 400);
  }
  const departmentId = String(body?.departmentId ?? "").trim();
  if (!departmentId) {
    return jsonResponse({ message: "departmentId is required." }, 400);
  }

  const updatedExtractedJson = {
    ...item.extractedJson,
    netSuiteOverrides: { ...item.extractedJson.netSuiteOverrides, departmentId },
  };
  await updateItem(
    TABLE_NAME,
    { messageId: item.messageId, attachmentKey: item.attachmentKey },
    { extractedJson: updatedExtractedJson, updatedAt: new Date().toISOString() }
  );

  const refreshedPreview = await buildNetSuitePreview({ ...item, extractedJson: updatedExtractedJson });

  log.info("NetSuite department override set", {
    messageId,
    attachmentId,
    departmentId,
    actor: actorFromEvent(event),
  });

  return jsonResponse({
    departmentId,
    flow: refreshedPreview.flow,
    validation: refreshedPreview.validation,
  });
}

async function getNetSuiteSettings() {
  return jsonResponse(await getNetSuiteRuntimeSettings(TABLE_NAME));
}

async function updateNetSuiteSettings(event: APIGatewayProxyEventV2) {
  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return jsonResponse({ message: "Invalid request body" }, 400);
  }

  const settings = await saveNetSuiteRuntimeSettings(TABLE_NAME, body, actorFromEvent(event));
  return jsonResponse(settings);
}

async function updateDuplicateReview(event: APIGatewayProxyEventV2) {
  const messageId = event.pathParameters?.messageId ?? "";
  const attachmentId = event.pathParameters?.attachmentId ?? "";
  let body: any = {};

  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return jsonResponse({ message: "Invalid request body" }, 400);
  }

  const action = parseDuplicateReviewAction(body?.action);
  if (!action) {
    return jsonResponse({ message: "action must be HOLD_FOR_REVIEW or ALLOW_NETSUITE" }, 400);
  }

  const item = await findByAttachmentId(messageId, attachmentId);
  if (!item) {
    return jsonResponse({ message: "Not found" }, 404);
  }
  if (item.status !== "COMPLETED" || !item.extractedJson) {
    return jsonResponse({ message: "Invoice extraction is not complete." }, 409);
  }

  const duplicateCount = item.duplicateCount ?? item.extractedJson?.meta?.duplicateCount ?? 0;
  if (duplicateCount <= 0) {
    return jsonResponse({ message: "This invoice has no duplicate matches to review." }, 409);
  }

  const now = new Date().toISOString();
  const duplicateReview = normalizeDuplicateReview({
    action,
    reviewedAt: now,
    reviewedBy: actorFromEvent(event),
    note: trimNote(body?.note),
  });
  const extractedJson = {
    ...item.extractedJson,
    meta: {
      ...(item.extractedJson?.meta ?? {}),
      duplicateReview,
    },
  };
  const flow = assessInvoiceFlow(extractedJson, {
    confidence: item.confidence,
    warnings: item.warnings ?? extractedJson?.meta?.warnings ?? [],
    duplicateCount,
  });

  extractedJson.meta.reviewStatus = flow.reviewStatus;
  extractedJson.meta.autoBookEligible = flow.autoBookEligible;
  extractedJson.meta.controlFlags = flow.flags;
  extractedJson.meta.duplicateReview = duplicateReview;

  await updateItem(
    TABLE_NAME,
    { messageId: item.messageId, attachmentKey: item.attachmentKey },
    {
      duplicateReview,
      reviewStatus: flow.reviewStatus,
      autoBookEligible: flow.autoBookEligible,
      controlFlags: flow.flags,
      duplicateCount: flow.duplicateCount,
      updatedAt: now,
      extractedJson,
    }
  );

  return jsonResponse({
    duplicateReview,
    reviewStatus: flow.reviewStatus,
    autoBookEligible: flow.autoBookEligible,
    controlFlags: flow.flags,
    duplicateCount: flow.duplicateCount,
    flow,
  });
}

async function listNetSuiteTransactionLog(event: APIGatewayProxyEventV2) {
  const limit = Math.min(Number(event.queryStringParameters?.limit ?? 25), 100);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 25;
  const status = parseTransactionStatus(event.queryStringParameters?.status);
  try {
    const result = await listNetSuiteTransactions(
      TABLE_NAME,
      safeLimit,
      event.queryStringParameters?.nextToken,
      status
    );
    return jsonResponse({
      items: result.items.map(summarizeTransaction),
      nextToken: result.nextToken,
    });
  } catch (err: any) {
    if (err?.statusCode === 400) {
      return jsonResponse({ message: err.message }, 400);
    }
    throw err;
  }
}

async function replayNetSuiteTransaction(event: APIGatewayProxyEventV2) {
  const transactionId = event.pathParameters?.transactionId ?? pathTransactionId(event.rawPath ?? "");
  if (!transactionId) {
    return jsonResponse({ message: "transactionId is required" }, 400);
  }
  if (!NETSUITE_LIVE_PUSH_ENABLED) {
    return jsonResponse({ message: "NetSuite live push is disabled; enable it before replay." }, 409);
  }

  const transaction = await getNetSuiteTransaction(TABLE_NAME, transactionId);
  if (!transaction) {
    return jsonResponse({ message: "Transaction not found" }, 404);
  }
  if (!canReplay(transaction.status)) {
    return jsonResponse({ message: `Transaction status ${transaction.status} cannot be replayed.` }, 409);
  }

  await markTransactionQueued(TABLE_NAME, transactionId, true);
  await enqueueNetSuiteTransaction(transactionId);
  return jsonResponse({ queued: true, transactionId }, 202);
}

async function replayNetSuiteTransactions(event: APIGatewayProxyEventV2) {
  if (!NETSUITE_LIVE_PUSH_ENABLED) {
    return jsonResponse({ message: "NetSuite live push is disabled; enable it before replay." }, 409);
  }
  const status = parseTransactionStatus(event.queryStringParameters?.status) ?? "FAILED_RETRYABLE";
  const limit = Math.min(Number(event.queryStringParameters?.limit ?? 25), 100);
  const result = await listNetSuiteTransactions(TABLE_NAME, limit, undefined, status);
  const queued: string[] = [];
  const skipped: Array<{ transactionId: string; status: string }> = [];

  for (const transaction of result.items) {
    if (!canReplay(transaction.status)) {
      skipped.push({ transactionId: transaction.transactionId, status: transaction.status });
      continue;
    }
    await markTransactionQueued(TABLE_NAME, transaction.transactionId, true);
    await enqueueNetSuiteTransaction(transaction.transactionId);
    queued.push(transaction.transactionId);
  }

  return jsonResponse({ queued, skipped, nextToken: result.nextToken }, 202);
}

async function downloadAttachment(event: APIGatewayProxyEventV2) {
  const messageId = event.pathParameters?.messageId ?? "";
  const attachmentId = event.pathParameters?.attachmentId ?? "";
  const item = await findByAttachmentId(messageId, attachmentId);
  if (!item) {
    return jsonResponse({ message: "Not found" }, 404);
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: ATTACHMENT_BUCKET,
      Key: item.attachmentKey,
    }),
    { expiresIn: 900 }
  );

  return jsonResponse({ url });
}

async function deleteInvoice(event: APIGatewayProxyEventV2) {
  const messageId = event.pathParameters?.messageId ?? "";
  const attachmentId = event.pathParameters?.attachmentId ?? "";
  const item = await findByAttachmentId(messageId, attachmentId);
  if (!item) {
    return jsonResponse({ message: "Not found" }, 404);
  }

  const attachmentKey = String(item.attachmentKey ?? "");
  if (attachmentKey) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: ATTACHMENT_BUCKET,
        Key: attachmentKey,
      })
    );
  }

  await docClient.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { messageId: item.messageId, attachmentKey: item.attachmentKey },
    })
  );

  return jsonResponse({ deleted: true });
}

async function createUpload(event: APIGatewayProxyEventV2) {
  let body: any = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return jsonResponse({ message: "Invalid request body" }, 400);
  }
  const filename = typeof body?.filename === "string" ? body.filename : "invoice.pdf";
  const contentType = "application/pdf";
  const fileSize = typeof body?.fileSize === "number" ? body.fileSize : undefined;

  if (!filename.toLowerCase().endsWith(".pdf")) {
    return jsonResponse({ message: "Only PDF uploads are allowed." }, 400);
  }
  if (MAX_UPLOAD_BYTES > 0 && typeof fileSize === "number" && fileSize > MAX_UPLOAD_BYTES) {
    return jsonResponse({ message: "File exceeds upload limit." }, 400);
  }

  const messageId = uuidv4();
  const attachmentId = uuidv4();
  const safeName = filename.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "invoice.pdf";
  // Web uploads go under "uploads/" so they are picked up by UploadIngestLambda;
  // emailed attachments live under "attachments/" and are handled by IngestLambda.
  const attachmentKey = `uploads/${messageId}/${attachmentId}_${safeName}`;

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: ATTACHMENT_BUCKET,
      Key: attachmentKey,
      ContentType: contentType,
    }),
    { expiresIn: 900 }
  );

  return jsonResponse({
    uploadUrl: url,
    attachmentKey,
    messageId,
    attachmentId,
  });
}

async function findByAttachmentId(messageId: string, attachmentId: string) {
  if (!messageId || !attachmentId) return null;

  const res = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "messageId = :pk",
      FilterExpression: "attachmentId = :att",
      ExpressionAttributeValues: { ":pk": messageId, ":att": attachmentId },
    })
  );

  return res.Items?.[0] ?? null;
}

/**
 * The non-invoice attachments that arrived in the same email as this invoice.
 *
 * Supporting material (cost-allocation schedules, rate notifications, remittance
 * advices) is evidence FOR the invoices it was sent with, so it's surfaced on
 * each invoice from that email rather than standing alone. They're linked by
 * `messageId` — the email — rather than owned by one invoice, because a single
 * schedule commonly backs several invoices in the same message and picking one
 * to "own" it would be arbitrary.
 *
 * Returns [] for a supporting document itself; it doesn't need to list its peers.
 */
async function listReferenceDocuments(item: any): Promise<any[]> {
  if (!item?.messageId) return [];

  const res = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "messageId = :pk",
      ExpressionAttributeValues: { ":pk": item.messageId },
    })
  );

  return (res.Items ?? [])
    .filter((sibling: any) => sibling.attachmentId && sibling.attachmentId !== item.attachmentId)
    .map((sibling: any) => ({ sibling, derived: withDerivedFlow(sibling) }))
    .filter(({ derived }) => derived.documentKind === "SUPPORTING_DOCUMENT")
    .map(({ sibling, derived }) => ({
      attachmentId: sibling.attachmentId,
      filename: filenameFromAttachmentKey(sibling.attachmentKey, sibling.attachmentId),
      documentType: sibling.extractedJson?.document?.documentType ?? null,
      classificationReason: sibling.extractedJson?.document?.classificationReason ?? null,
      receivedAt: sibling.receivedAt,
      status: sibling.status,
      displayStatus: derived.displayStatus,
    }));
}

/** `attachments/{messageId}/{attachmentId}_{name}` -> `{name}`. */
function filenameFromAttachmentKey(attachmentKey?: string, attachmentId?: string): string {
  const last = String(attachmentKey ?? "").split("/").pop() ?? "";
  const prefix = `${attachmentId ?? ""}_`;
  return last.startsWith(prefix) ? last.slice(prefix.length) : last;
}

async function buildNetSuitePreview(item: any): Promise<{
  config: NetSuiteConfig;
  runtimeSettings: NetSuiteRuntimeSettings;
  activeEnvironment: ReturnType<typeof activeNetSuiteEnvironment>;
  bill: ReturnType<typeof transformToNetSuite>["bill"];
  request: ReturnType<typeof transformToNetSuite>["request"];
  warnings: string[];
  configurationHints: ReturnType<typeof buildNetSuiteConfigurationHints>;
  validation: ReturnType<typeof validateNetSuiteRequest>;
  flow: ReturnType<typeof assessInvoiceFlow>;
}> {
  const config = loadNetSuiteConfig();
  const runtimeSettings = await getNetSuiteRuntimeSettings(TABLE_NAME);
  const activeEnvironment = activeNetSuiteEnvironment(runtimeSettings);
  const { bill, request, warnings } = transformToNetSuite(item.extractedJson, config);
  request.environment = runtimeSettings.activeEnvironment;
  const configurationHints = buildNetSuiteConfigurationHints(item.extractedJson, config);
  const validation = validateNetSuiteRequest(request, config);
  const flow = assessInvoiceFlow(item.extractedJson, {
    confidence: item.confidence,
    warnings: item.warnings ?? item.extractedJson?.meta?.warnings ?? [],
    duplicateCount: item.duplicateCount ?? item.extractedJson?.meta?.duplicateCount ?? 0,
    netSuiteWarnings: warnings,
    netSuiteValidationErrors: validation.errors,
  });

  return { config, runtimeSettings, activeEnvironment, bill, request, warnings, configurationHints, validation, flow };
}

async function enqueueNetSuiteTransaction(transactionId: string) {
  if (!NETSUITE_QUEUE_URL) {
    throw new Error("NETSUITE_QUEUE_URL is not configured");
  }
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: NETSUITE_QUEUE_URL,
      MessageBody: JSON.stringify({ transactionId }),
    })
  );
}

function parseTransactionStatus(value?: string): NetSuiteTransactionStatus | undefined {
  if (!value) return undefined;
  const allowed: NetSuiteTransactionStatus[] = [
    "HELD_FOR_REVIEW",
    "HELD_FOR_CONFIGURATION",
    "QUEUED",
    "IN_FLIGHT",
    "SUCCEEDED",
    "FAILED_RETRYABLE",
    "FAILED_PERMANENT",
  ];
  return allowed.includes(value as NetSuiteTransactionStatus) ? (value as NetSuiteTransactionStatus) : undefined;
}

function parseDuplicateReviewAction(value: unknown): DuplicateReviewAction | undefined {
  return value === "HOLD_FOR_REVIEW" || value === "ALLOW_NETSUITE"
    ? value
    : undefined;
}

function trimNote(value: unknown): string | undefined {
  const note = String(value ?? "").trim();
  return note ? note.slice(0, 500) : undefined;
}

function pathTransactionId(path: string): string {
  const match = path.match(/^\/netsuite\/transactions\/([^/]+)\/replay$/);
  return match ? decodeURIComponent(match[1]) : "";
}

function jsonResponse(body: any, statusCode = 200): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
    body: JSON.stringify(body),
  };
}

function actorFromEvent(event: APIGatewayProxyEventV2): string | undefined {
  const claims = (event.requestContext as any)?.authorizer?.jwt?.claims ?? {};
  return claims.email || claims["cognito:username"] || claims.sub;
}

function hasAppAccess(event: APIGatewayProxyEventV2): boolean {
  const claims = (event.requestContext as any)?.authorizer?.jwt?.claims ?? {};
  return claimGroups(claims["cognito:groups"]).some((group) => REQUIRED_GROUPS.has(group));
}

function claimGroups(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Fall through to Cognito/API Gateway delimiter formats.
    }
    const normalized = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
    return normalized
      .split(/[,\s]+/)
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  return [];
}

/**
 * Overall lifecycle status shown to AP, distinct from the raw extraction
 * `status` and from `reviewStatus` (both still available underneath):
 *   IMPORTED  - still being extracted (not COMPLETED yet)
 *   FAILED    - extraction failed, or NetSuite rejected it permanently
 *   ON_HOLD   - extracted but not yet successfully in NetSuite: needs AP review,
 *               a config gap, an outage/retryable failure, or simply not sent yet
 *   PROCESSED - the NetSuite transaction succeeded
 *   REFERENCE - not an invoice at all (supporting material that arrived in the
 *               same email); kept and viewable, but never pushed to NetSuite
 */
export type DisplayStatus = "IMPORTED" | "FAILED" | "ON_HOLD" | "PROCESSED" | "REFERENCE";

function computeDisplayStatus(
  item: any,
  netSuiteStatus: string | null | undefined,
  documentKind?: DocumentKind
): DisplayStatus {
  if (item.status === "FAILED") return "FAILED";
  if (item.status !== "COMPLETED") return "IMPORTED";
  // Checked after extraction completes (the classification needs the extracted
  // fields) but before any NetSuite state, since a supporting document has no
  // NetSuite lifecycle to report.
  if (documentKind === "SUPPORTING_DOCUMENT") return "REFERENCE";
  if (netSuiteStatus === "FAILED_PERMANENT") return "FAILED";
  if (netSuiteStatus === "SUCCEEDED") return "PROCESSED";
  return "ON_HOLD";
}

/**
 * Recomputes reviewStatus/flags fresh every time, folding in current NetSuite
 * crosswalk resolution (transformToNetSuite/validateNetSuiteRequest are pure and
 * only need the already-loaded config, no extra NetSuite/DB calls). This is what
 * fixes reviewStatus going stale on older invoices extracted before a crosswalk
 * was filled in — the stored value never used to get NetSuite warnings folded in
 * at all, and only recomputed when nothing had been stored yet.
 */
function withDerivedFlow(item: any) {
  if (!item) return item;
  if (item.status !== "COMPLETED" || !item.extractedJson) {
    return { ...item, displayStatus: computeDisplayStatus(item, item.netSuiteTransactionStatus) };
  }

  let netSuiteWarnings: string[] | undefined;
  let netSuiteValidationErrors: string[] | undefined;
  // What the transform actually resolved. The drawer needs this to show the
  // department that will really be sent (which may come from an override, a
  // business-unit route, or a config default) rather than inferring it from
  // the absence of a blocker flag.
  let resolved: { departmentId?: string } = {};
  try {
    const config = loadNetSuiteConfig();
    const { bill, request, warnings } = transformToNetSuite(item.extractedJson, config);
    const validation = validateNetSuiteRequest(request, config);
    netSuiteWarnings = warnings;
    netSuiteValidationErrors = validation.errors;
    resolved = { departmentId: (bill as any)?.department?.id };
  } catch {
    // Leave NetSuite-specific signals out if the transform itself throws; the
    // extraction-only flags below still apply.
  }

  const flow = assessInvoiceFlow(item.extractedJson, {
    confidence: item.confidence,
    warnings: item.warnings ?? item.extractedJson?.meta?.warnings ?? [],
    duplicateCount: item.duplicateCount ?? item.extractedJson?.meta?.duplicateCount ?? 0,
    netSuiteWarnings,
    netSuiteValidationErrors,
  });

  return {
    ...item,
    reviewStatus: flow.reviewStatus,
    autoBookEligible: flow.autoBookEligible,
    controlFlags: flow.flags,
    duplicateCount: flow.duplicateCount,
    displayStatus: computeDisplayStatus(item, item.netSuiteTransactionStatus, flow.documentKind),
    documentKind: flow.documentKind,
    netSuiteResolved: resolved,
  };
}
