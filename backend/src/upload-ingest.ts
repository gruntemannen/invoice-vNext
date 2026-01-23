import { S3Event } from "aws-lambda";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { putItem } from "./shared/dynamo";
import { log } from "./shared/logger";
import { emitMetric } from "./shared/metrics";

const sqs = new SQSClient({});

const ATTACHMENT_BUCKET = process.env.ATTACHMENT_BUCKET ?? "";
const QUEUE_URL = process.env.QUEUE_URL ?? "";
const TABLE_NAME = process.env.TABLE_NAME ?? "";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? "0");

export const handler = async (event: S3Event) => {
  for (const record of event.Records) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const sizeBytes = record.s3.object.size ?? 0;
    if (!key.startsWith("attachments/")) {
      continue;
    }

    const { messageId, attachmentId, safeName } = parseAttachmentKey(key);
    const receivedAt = new Date().toISOString();

    const ttl = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90;
    const item = {
      messageId,
      attachmentKey: key,
      attachmentId,
      status: "PENDING",
      receivedAt,
      from: "manual-upload",
      subject: safeName,
      rawEmailS3Key: null,
      attachmentS3Key: key,
      gsi1pk: "INVOICE",
      gsi1sk: `${receivedAt}#${messageId}#${attachmentId}`,
      ttl,
      sizeBytes,
    };

    if (MAX_UPLOAD_BYTES > 0 && sizeBytes > MAX_UPLOAD_BYTES) {
      await putItem(TABLE_NAME, {
        ...item,
        status: "FAILED",
        updatedAt: new Date().toISOString(),
        errors: ["file_too_large"],
      });
      log.warn("Upload rejected due to size", { key, sizeBytes, maxBytes: MAX_UPLOAD_BYTES });
      emitMetric("UploadsRejected", 1, "Count");
      continue;
    }

    await putItem(TABLE_NAME, item);

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify({
          messageId,
          attachmentId,
          attachmentKey: key,
          receivedAt,
          from: "manual-upload",
          subject: safeName,
          rawEmailS3Key: null,
        }),
      })
    );

    log.info("Enqueued upload for extraction", { messageId, attachmentId, key });
    emitMetric("UploadsEnqueued", 1, "Count");
  }
};

function parseAttachmentKey(key: string) {
  const parts = key.split("/");
  const messageId = parts[1] ?? "unknown";
  const file = parts[2] ?? "attachment";
  const [attachmentId, ...rest] = file.split("_");
  const safeName = rest.join("_") || file;
  return { messageId, attachmentId, safeName };
}
