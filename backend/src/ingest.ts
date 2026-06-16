import { S3Event } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { v4 as uuidv4 } from "uuid";
import { getObjectBuffer, putObject } from "./shared/s3";
import { parseEmail } from "./shared/email";
import { putItem } from "./shared/dynamo";
import { log } from "./shared/logger";
import { emitMetric } from "./shared/metrics";

const sqs = new SQSClient({});

const RAW_BUCKET = process.env.RAW_BUCKET ?? "";
const ATTACHMENT_BUCKET = process.env.ATTACHMENT_BUCKET ?? "";
const QUEUE_URL = process.env.QUEUE_URL ?? "";
const TABLE_NAME = process.env.TABLE_NAME ?? "";

// Reject oversized or non-invoice attachments before storing/enqueuing (cost + abuse control).
const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? String(10 * 1024 * 1024));
const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg"];
// Days before a record + its attachment are auto-deleted (DynamoDB TTL).
const RETENTION_DAYS = Number(process.env.DATA_RETENTION_DAYS ?? "90");

export const handler = async (event: S3Event) => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    if (!key.startsWith("raw/")) {
      log.info("Skipping non-raw object", { key });
      continue;
    }

    const raw = await getObjectBuffer(bucket, key);
    const parsed = await parseEmail(raw);

    const safeMessageId = parsed.messageId.replace(/[^\w.\-@]+/g, "_");
    log.info("Parsed email", { messageId: safeMessageId, attachments: parsed.attachments.length });
    emitMetric("AttachmentsDetected", parsed.attachments.length, "Count");

    for (const attachment of parsed.attachments) {
      const contentType = (attachment.contentType ?? "").toLowerCase();
      const size = attachment.size ?? attachment.content?.length ?? 0;
      const typeOk =
        ALLOWED_TYPES.includes(contentType) || /\.(pdf|png|jpe?g)$/i.test(attachment.filename ?? "");
      if (!typeOk || size > MAX_ATTACHMENT_BYTES) {
        log.warn("Skipping attachment (unsupported type or too large)", {
          messageId: safeMessageId,
          contentType,
          size,
          filename: attachment.filename,
        });
        emitMetric("AttachmentsRejected", 1, "Count");
        continue;
      }

      const attachmentId = uuidv4();
      const safeName = attachment.filename ? attachment.filename.replace(/[^\w.\-]+/g, "_") : "attachment";
      const attachmentKey = `attachments/${safeMessageId}/${attachmentId}_${safeName}`;
      await putObject(ATTACHMENT_BUCKET, attachmentKey, attachment.content, attachment.contentType);

      const ttl = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * RETENTION_DAYS;
      const item = {
        messageId: safeMessageId,
        attachmentKey,
        attachmentId,
        status: "PENDING",
        receivedAt: parsed.date,
        from: parsed.from,
        subject: parsed.subject,
        rawEmailS3Key: key,
        attachmentS3Key: attachmentKey,
        gsi1pk: "INVOICE",
        gsi1sk: `${parsed.date}#${safeMessageId}#${attachmentId}`,
        ttl,
      };

      await putItem(TABLE_NAME, item);

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: QUEUE_URL,
          MessageBody: JSON.stringify({
            messageId: safeMessageId,
            attachmentId,
            attachmentKey,
            receivedAt: parsed.date,
            from: parsed.from,
            subject: parsed.subject,
            rawEmailS3Key: key,
          }),
        })
      );
      emitMetric("AttachmentsEnqueued", 1, "Count");
    }
  }
};
