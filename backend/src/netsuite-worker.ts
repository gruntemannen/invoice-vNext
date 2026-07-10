import { SQSEvent } from "aws-lambda";
import {
  applyNetSuiteVendorMasterPatch,
  asNetSuitePushRequest,
  compareNetSuiteVendorMaster,
  getAccessToken,
  upsertNetSuiteRecord,
} from "./shared/netsuite";
import { loadNetSuiteSecret } from "./shared/netsuite-secret";
import { environmentByName, getNetSuiteRuntimeSettings } from "./shared/netsuite-settings";
import {
  getNetSuiteTransaction,
  markTransactionFailed,
  markTransactionInFlight,
  markTransactionSucceeded,
} from "./shared/transactions";
import { log } from "./shared/logger";
import { emitMetric } from "./shared/metrics";
import {
  createVendorMasterApproval,
  getVendorMasterApproval,
  markVendorApprovalApplied,
  markVendorApprovalApplying,
  markVendorApprovalFailed,
} from "./shared/vendor-approvals";

const TABLE_NAME = process.env.TABLE_NAME ?? "";
const NETSUITE_SECRET_ARN = process.env.NETSUITE_SECRET_ARN ?? "";
const LIVE_PUSH_ENABLED = process.env.NETSUITE_LIVE_PUSH_ENABLED === "true";

export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    const payload = JSON.parse(record.body);
    const approvalId = String(payload.approvalId ?? "");
    if (approvalId) {
      await processVendorApproval(approvalId);
      continue;
    }
    const transactionId = String(payload.transactionId ?? "");
    if (!transactionId) {
      log.warn("Skipping NetSuite queue message without transactionId", { body: record.body });
      continue;
    }
    if (payload.operation === "COMPARE_VENDOR") {
      await processVendorComparison(transactionId);
      continue;
    }

    const transaction = await getNetSuiteTransaction(TABLE_NAME, transactionId);
    if (!transaction) {
      log.warn("Skipping missing NetSuite transaction", { transactionId });
      continue;
    }

    await markTransactionInFlight(TABLE_NAME, transactionId);

    try {
      if (!LIVE_PUSH_ENABLED) {
        throw new RetryableNetSuiteError("NetSuite live push is disabled; transaction remains replayable.");
      }

      const request = asNetSuitePushRequest(transaction.requestPayload, transaction.externalId);
      const runtimeSettings = await getNetSuiteRuntimeSettings(TABLE_NAME);
      const endpoint = environmentByName(runtimeSettings, request.environment);
      const secret = await loadNetSuiteSecret(endpoint.secretArn || NETSUITE_SECRET_ARN);
      const token = await getAccessToken(secret, endpoint);
      const result = await upsertNetSuiteRecord(
        secret,
        token,
        request,
        transaction.externalId,
        endpoint
      );

      await markTransactionSucceeded(TABLE_NAME, transactionId, {
        ...result,
        vendorSync: request.vendorSync
          ? { status: "SEPARATE_APPROVAL_WORKFLOW" }
          : { status: "SKIPPED" },
      });
      emitMetric("NetSuitePushSuccess", 1, "Count");
      log.info("NetSuite transaction succeeded", {
        transactionId,
        externalId: transaction.externalId,
        vendorSyncStatus: request.vendorSync ? "SEPARATE_APPROVAL_WORKFLOW" : "SKIPPED",
      });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      const retryable = isRetryableNetSuiteError(err);
      await markTransactionFailed(TABLE_NAME, transactionId, retryable, message);
      emitMetric("NetSuitePushFailure", 1, "Count", { Retryable: String(retryable) });
      log.error("NetSuite transaction failed", { transactionId, retryable, error: message });

      // Let SQS retry transient failures automatically. The transaction ledger already
      // recorded the failed attempt, so manual replay remains possible after DLQ.
      if (retryable) {
        throw err;
      }
    }
  }
};

async function processVendorComparison(transactionId: string) {
  const transaction = await getNetSuiteTransaction(TABLE_NAME, transactionId);
  if (!transaction) {
    log.warn("Skipping vendor comparison for missing transaction", { transactionId });
    return;
  }
  if (!LIVE_PUSH_ENABLED) {
    log.info("Skipping vendor comparison while NetSuite integration is disabled", { transactionId });
    return;
  }

  try {
    const request = asNetSuitePushRequest(transaction.requestPayload, transaction.externalId);
    if (!request.vendorSync) return;
    const runtimeSettings = await getNetSuiteRuntimeSettings(TABLE_NAME);
    const endpoint = environmentByName(runtimeSettings, request.environment);
    const secret = await loadNetSuiteSecret(endpoint.secretArn || NETSUITE_SECRET_ARN);
    const token = await getAccessToken(secret, endpoint);
    const comparison = await compareNetSuiteVendorMaster(
      secret,
      token,
      request.vendorSync,
      endpoint
    );
    if (comparison.status !== "CHANGES_PROPOSED" || !comparison.changes || !comparison.patch) {
      log.info("Vendor comparison completed without proposed changes", {
        transactionId,
        status: comparison.status,
      });
      return;
    }

    const proposed = await createVendorMasterApproval(TABLE_NAME, {
      environment: request.environment ?? runtimeSettings.activeEnvironment,
      plan: request.vendorSync,
      changes: comparison.changes,
      patch: comparison.patch,
      sourceTransactionId: transactionId,
      sourceInvoiceMessageId: transaction.invoiceMessageId,
      sourceInvoiceAttachmentId: transaction.invoiceAttachmentId,
      sourceInvoiceNumber: (request.payload as any)?.tranId,
      vendorName: request.vendorSync.source.name,
      vendorTaxId: request.vendorSync.source.taxId,
    });
    emitMetric("NetSuiteVendorApprovalProposed", proposed.created ? 1 : 0, "Count");
    log.info("Vendor changes placed in approval queue", {
      transactionId,
      approvalId: proposed.approval.approvalId,
      created: proposed.created,
    });
  } catch (error: any) {
    emitMetric("NetSuiteVendorComparisonFailure", 1, "Count");
    log.error("Vendor comparison failed", {
      transactionId,
      error: error?.message ?? String(error),
    });
    if (isRetryableNetSuiteError(error)) throw error;
  }
}

async function processVendorApproval(approvalId: string) {
  const approval = await getVendorMasterApproval(TABLE_NAME, approvalId);
  if (!approval) {
    log.warn("Skipping missing vendor approval", { approvalId });
    return;
  }
  if (approval.status === "APPLIED" || approval.status === "REJECTED") {
    log.info("Skipping completed vendor approval", { approvalId, status: approval.status });
    return;
  }
  if (
    approval.status !== "APPROVED" &&
    approval.status !== "FAILED_RETRYABLE" &&
    approval.status !== "APPLYING"
  ) {
    log.warn("Skipping vendor approval that is not approved", { approvalId, status: approval.status });
    return;
  }

  if (approval.status !== "APPLYING") {
    await markVendorApprovalApplying(TABLE_NAME, approvalId);
  }
  try {
    if (!LIVE_PUSH_ENABLED) {
      throw new RetryableNetSuiteError("NetSuite live push is disabled; approved vendor update remains replayable.");
    }
    const runtimeSettings = await getNetSuiteRuntimeSettings(TABLE_NAME);
    const endpoint = environmentByName(runtimeSettings, approval.environment);
    const secret = await loadNetSuiteSecret(endpoint.secretArn || NETSUITE_SECRET_ARN);
    const token = await getAccessToken(secret, endpoint);
    await applyNetSuiteVendorMasterPatch(
      secret,
      token,
      {
        vendorId: approval.vendorId,
        recordId: approval.recordId,
        patch: approval.patch,
        expectedChanges: approval.changes,
      },
      endpoint
    );
    await markVendorApprovalApplied(TABLE_NAME, approvalId);
    emitMetric("NetSuiteVendorApprovalApplied", 1, "Count");
    log.info("Approved vendor changes applied", { approvalId, vendorId: approval.vendorId });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    const retryable = isRetryableNetSuiteError(error);
    await markVendorApprovalFailed(TABLE_NAME, approvalId, retryable, message);
    emitMetric("NetSuiteVendorApprovalFailure", 1, "Count", { Retryable: String(retryable) });
    if (retryable) throw error;
  }
}

class RetryableNetSuiteError extends Error {}

function isRetryableNetSuiteError(err: any): boolean {
  if (err instanceof RetryableNetSuiteError) return true;
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  if (/(timeout|timed out|econnreset|etimedout|network|socket|fetch failed)/i.test(msg)) return true;
  const status = msg.match(/(?:failed|request failed):\s*(\d{3})/i)?.[1];
  if (!status) return false;
  const code = Number(status);
  return code === 408 || code === 409 || code === 425 || code === 429 || code >= 500;
}
