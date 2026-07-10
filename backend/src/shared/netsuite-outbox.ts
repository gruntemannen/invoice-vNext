import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { updateItem } from "./dynamo";
import { assessInvoiceFlow } from "./flow";
import {
  buildNetSuiteConfigurationHints,
  transformToNetSuite,
  validateNetSuiteRequest,
} from "./netsuite";
import { loadNetSuiteConfig } from "./netsuite-config";
import {
  activeNetSuiteEnvironment,
  getNetSuiteRuntimeSettings,
} from "./netsuite-settings";
import {
  createNetSuiteTransaction,
  markTransactionFailed,
  refreshHeldNetSuiteTransaction,
  summarizeTransaction,
  type NetSuiteTransactionStatus,
} from "./transactions";

const sqs = new SQSClient({});

export async function buildNetSuitePreviewForInvoice(tableName: string, item: any) {
  const config = loadNetSuiteConfig();
  const runtimeSettings = await getNetSuiteRuntimeSettings(tableName);
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

  return {
    config,
    runtimeSettings,
    activeEnvironment,
    bill,
    request,
    warnings,
    configurationHints,
    validation,
    flow,
  };
}

export async function ensureInvoiceNetSuiteTransaction(options: {
  tableName: string;
  queueUrl: string;
  livePushEnabled: boolean;
  item: any;
}) {
  const preview = await buildNetSuitePreviewForInvoice(options.tableName, options.item);
  let status: NetSuiteTransactionStatus = "QUEUED";
  let eventMessage = "Transaction logged and queued for NetSuite push.";

  if (!preview.validation.valid || preview.flow.reviewStatus !== "READY_FOR_NETSUITE") {
    status = "HELD_FOR_REVIEW";
    eventMessage = "Transaction logged but held for AP review.";
  } else if (!options.livePushEnabled) {
    status = "HELD_FOR_CONFIGURATION";
    eventMessage = "Transaction logged but live NetSuite push is disabled.";
  }

  const created = await createNetSuiteTransaction(options.tableName, {
    invoiceMessageId: options.item.messageId,
    invoiceAttachmentKey: options.item.attachmentKey,
    invoiceAttachmentId: options.item.attachmentId,
    externalId: preview.request.externalId,
    requestPayload: preview.request,
    validation: preview.validation,
    flow: preview.flow,
    warnings: preview.warnings,
    status,
    eventMessage,
  });
  const transaction = created.transaction;
  let shouldQueue = created.created && status === "QUEUED";
  let vendorComparisonQueued = false;

  if (
    !created.created &&
    ["HELD_FOR_REVIEW", "HELD_FOR_CONFIGURATION", "FAILED_PERMANENT"].includes(
      transaction.status
    )
  ) {
    try {
      await refreshHeldNetSuiteTransaction(options.tableName, transaction.transactionId, {
        status,
        requestPayload: preview.request,
        validation: preview.validation,
        flow: preview.flow,
        warnings: preview.warnings,
        message:
          status === "QUEUED"
            ? "Review was resolved; transaction refreshed and queued for NetSuite."
            : "Transaction was refreshed after an approval decision.",
      });
      transaction.status = status;
      transaction.requestPayload = preview.request;
      transaction.validation = preview.validation;
      transaction.flow = preview.flow;
      transaction.warnings = preview.warnings;
      shouldQueue = status === "QUEUED";
    } catch (error: any) {
      if (error?.name !== "ConditionalCheckFailedException") throw error;
    }
  }

  if (shouldQueue) {
    try {
      await enqueueNetSuiteTransaction(options.queueUrl, transaction.transactionId);
    } catch (error: any) {
      const message = `Failed to enqueue transaction: ${error?.message ?? String(error)}`;
      await markTransactionFailed(options.tableName, transaction.transactionId, true, message);
      transaction.status = "FAILED_RETRYABLE";
      transaction.lastError = message;
    }
  }

  if (
    options.livePushEnabled &&
    preview.request.vendorSync &&
    !options.item.vendorMasterComparisonQueuedAt
  ) {
    try {
      await enqueueNetSuiteVendorComparison(options.queueUrl, transaction.transactionId);
      vendorComparisonQueued = true;
      await updateItem(
        options.tableName,
        { messageId: options.item.messageId, attachmentKey: options.item.attachmentKey },
        { vendorMasterComparisonQueuedAt: new Date().toISOString() }
      );
    } catch (error: any) {
      await updateItem(
        options.tableName,
        { messageId: options.item.messageId, attachmentKey: options.item.attachmentKey },
        { vendorMasterComparisonError: error?.message ?? String(error) }
      );
    }
  }

  await updateItem(
    options.tableName,
    { messageId: options.item.messageId, attachmentKey: options.item.attachmentKey },
    {
      netSuiteTransactionId: transaction.transactionId,
      netSuiteTransactionStatus: transaction.status,
      netSuiteTransactionUpdatedAt: new Date().toISOString(),
    }
  );

  return {
    transaction: summarizeTransaction(transaction),
    created: created.created,
    queued: shouldQueue && transaction.status === "QUEUED",
    vendorComparisonQueued,
    preview,
  };
}

async function enqueueNetSuiteVendorComparison(queueUrl: string, transactionId: string) {
  if (!queueUrl) throw new Error("NETSUITE_QUEUE_URL is not configured");
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ transactionId, operation: "COMPARE_VENDOR" }),
    })
  );
}

export async function enqueueNetSuiteTransaction(queueUrl: string, transactionId: string) {
  if (!queueUrl) throw new Error("NETSUITE_QUEUE_URL is not configured");
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ transactionId }),
    })
  );
}
