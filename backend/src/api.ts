import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { queryInvoices, docClient } from "./shared/dynamo";
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import {
  buildNetSuiteConfigurationHints,
  transformToNetSuite,
  validateNetSuiteRequest,
  type NetSuiteConfig,
} from "./shared/netsuite";
import { loadNetSuiteConfig } from "./shared/netsuite-config";
import {
  activeNetSuiteEnvironment,
  getNetSuiteRuntimeSettings,
  saveNetSuiteRuntimeSettings,
  type NetSuiteRuntimeSettings,
} from "./shared/netsuite-settings";
import { assessInvoiceFlow } from "./shared/flow";
import {
  canReplay,
  createNetSuiteTransaction,
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
const s3 = new S3Client({});
const sqs = new SQSClient({});

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
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
  if (path.startsWith("/netsuite/transactions/") && path.endsWith("/replay") && event.requestContext.http.method === "POST") {
    return replayNetSuiteTransaction(event);
  }
  if (path.startsWith("/invoices/") && path.endsWith("/netsuite/transactions") && event.requestContext.http.method === "POST") {
    return createNetSuiteTransactionForInvoice(event);
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
  const items = result.items.map((rawItem: any) => {
    const item = withDerivedFlow(rawItem);
    return {
      messageId: item.messageId,
      attachmentId: item.attachmentId,
      attachmentKey: item.attachmentKey,
      receivedAt: item.receivedAt,
      from: item.from,
      subject: item.subject,
      status: item.status,
      reviewStatus: item.reviewStatus ?? item.extractedJson?.meta?.reviewStatus,
      autoBookEligible: item.autoBookEligible ?? item.extractedJson?.meta?.autoBookEligible,
      controlFlags: item.controlFlags ?? item.extractedJson?.meta?.controlFlags ?? [],
      confidence: item.confidence,
      warnings: item.warnings ?? [],
      vendorName: item.vendorName,
      vendorTaxId: item.vendorTaxId ?? item.extractedJson?.vendor?.taxId,
      vendorVatStatus: item.vendorVatStatus ?? item.extractedJson?.vendor?.vatValidation?.status,
      vendorVatValid: item.vendorVatValid ?? item.extractedJson?.vendor?.vatValidation?.valid,
      buyerName: item.buyerName,
      invoiceNumber: item.invoiceNumber,
      purchaseOrderNumber: item.purchaseOrderNumber,
      invoiceType: item.invoiceType,
      netSuiteTransactionIntent: item.netSuiteTransactionIntent ?? item.extractedJson?.invoice?.transactionIntent,
      currency: item.currency,
      totalAmount: item.totalAmount,
      duplicateCount: item.duplicateCount ?? item.extractedJson?.meta?.duplicateCount ?? 0,
    };
  });

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
  return jsonResponse(withDerivedFlow(item));
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
    let status: NetSuiteTransactionStatus = "QUEUED";
    let eventMessage = "Transaction logged and queued for NetSuite push.";

    if (!preview.validation.valid || preview.flow.reviewStatus !== "READY_FOR_NETSUITE") {
      status = "HELD_FOR_REVIEW";
      eventMessage = "Transaction logged but held for AP review.";
    } else if (!NETSUITE_LIVE_PUSH_ENABLED) {
      status = "HELD_FOR_CONFIGURATION";
      eventMessage = "Transaction logged but live NetSuite push is disabled.";
    }

    const transaction = await createNetSuiteTransaction(TABLE_NAME, {
      invoiceMessageId: item.messageId,
      invoiceAttachmentKey: item.attachmentKey,
      invoiceAttachmentId: item.attachmentId,
      externalId: preview.request.externalId,
      requestPayload: preview.request,
      validation: preview.validation,
      flow: preview.flow,
      warnings: preview.warnings,
      status,
      eventMessage,
    });

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

function withDerivedFlow(item: any) {
  if (!item || item.reviewStatus || item.status !== "COMPLETED" || !item.extractedJson) {
    return item;
  }

  const flow = assessInvoiceFlow(item.extractedJson, {
    confidence: item.confidence,
    warnings: item.warnings ?? item.extractedJson?.meta?.warnings ?? [],
    duplicateCount: item.duplicateCount ?? item.extractedJson?.meta?.duplicateCount ?? 0,
  });

  return {
    ...item,
    reviewStatus: flow.reviewStatus,
    autoBookEligible: flow.autoBookEligible,
    controlFlags: flow.flags,
    duplicateCount: flow.duplicateCount,
  };
}
