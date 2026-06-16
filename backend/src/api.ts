import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { queryInvoices, docClient } from "./shared/dynamo";
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import {
  transformToNetSuite,
  validateNetSuiteVendorBill,
  exampleNetSuiteConfig,
  type NetSuiteConfig,
} from "./shared/netsuite";
import { computeStats } from "./shared/stats";
import { log } from "./shared/logger";

const TABLE_NAME = process.env.TABLE_NAME ?? "";
const ATTACHMENT_BUCKET = process.env.ATTACHMENT_BUCKET ?? "";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? "0");
const s3 = new S3Client({});

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
  const items = result.items.map((item: any) => ({
    messageId: item.messageId,
    attachmentId: item.attachmentId,
    attachmentKey: item.attachmentKey,
    receivedAt: item.receivedAt,
    from: item.from,
    subject: item.subject,
    status: item.status,
    confidence: item.confidence,
    warnings: item.warnings ?? [],
    vendorName: item.vendorName,
    invoiceNumber: item.invoiceNumber,
    currency: item.currency,
    totalAmount: item.totalAmount,
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
  return jsonResponse(item);
}

async function getNetSuiteFormat(event: APIGatewayProxyEventV2) {
  const messageId = event.pathParameters?.messageId ?? "";
  const attachmentId = event.pathParameters?.attachmentId ?? "";

  const item = await findByAttachmentId(messageId, attachmentId);
  if (!item) {
    return jsonResponse({ message: "Not found" }, 404);
  }

  // EXPORT-ONLY: build + validate the NetSuite vendor bill payload but do NOT
  // push it. No live call to getAccessToken/upsertVendorBill until creds are
  // wired in. Config comes from the placeholder example for now; in production
  // this loads from netsuite-config.json + a secrets store.
  const config: NetSuiteConfig = exampleNetSuiteConfig;

  try {
    const { bill, warnings } = transformToNetSuite(item.extractedJson, config);
    const validation = validateNetSuiteVendorBill(bill, config);

    return jsonResponse({
      netsuiteFormat: bill,
      warnings,
      validation,
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
