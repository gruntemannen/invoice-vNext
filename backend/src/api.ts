import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { queryInvoices, docClient } from "./shared/dynamo";
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import { transformToOracleFusion, validateOracleFusionInvoice, exampleConfig, type OracleFusionConfig } from "./shared/oracle-fusion";

const TABLE_NAME = process.env.TABLE_NAME ?? "";
const ATTACHMENT_BUCKET = process.env.ATTACHMENT_BUCKET ?? "";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? "0");
const s3 = new S3Client({});

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const path = event.rawPath ?? "";
  if (path === "/invoices") {
    return listInvoices(event);
  }
  if (path === "/upload" && event.requestContext.http.method === "POST") {
    return createUpload(event);
  }
  if (path.startsWith("/invoices/") && path.endsWith("/oracle-fusion")) {
    return getOracleFusionFormat(event);
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
  const result = await queryInvoices(TABLE_NAME, safeLimit, nextToken);
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

async function getInvoiceDetail(event: APIGatewayProxyEventV2) {
  const messageId = event.pathParameters?.messageId ?? "";
  const attachmentId = event.pathParameters?.attachmentId ?? "";

  const item = await findByAttachmentId(messageId, attachmentId);
  if (!item) {
    return jsonResponse({ message: "Not found" }, 404);
  }
  return jsonResponse(item);
}

async function getOracleFusionFormat(event: APIGatewayProxyEventV2) {
  const messageId = event.pathParameters?.messageId ?? "";
  const attachmentId = event.pathParameters?.attachmentId ?? "";

  const item = await findByAttachmentId(messageId, attachmentId);
  if (!item) {
    return jsonResponse({ message: "Not found" }, 404);
  }

  // Load config from environment or use example
  // In production, you'd load this from DynamoDB, S3, or environment variables
  const config: OracleFusionConfig = exampleConfig;

  try {
    const oracleInvoice = transformToOracleFusion(item.extractedJson, config);
    const validation = validateOracleFusionInvoice(oracleInvoice);

    return jsonResponse({
      oracleFormat: oracleInvoice,
      validation,
      originalExtraction: item.extractedJson,
    });
  } catch (error: any) {
    return jsonResponse({
      message: "Failed to transform to Oracle Fusion format",
      error: error?.message || String(error),
    }, 500);
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
  const body = event.body ? JSON.parse(event.body) : {};
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
  const safeName = filename.replace(/[^\w.\-]+/g, "_");
  const attachmentKey = `attachments/${messageId}/${attachmentId}_${safeName}`;

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
