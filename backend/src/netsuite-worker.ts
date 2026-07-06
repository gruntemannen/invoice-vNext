import { SQSEvent } from "aws-lambda";
import { asNetSuitePushRequest, getAccessToken, upsertNetSuiteRecord } from "./shared/netsuite";
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

const TABLE_NAME = process.env.TABLE_NAME ?? "";
const NETSUITE_SECRET_ARN = process.env.NETSUITE_SECRET_ARN ?? "";
const LIVE_PUSH_ENABLED = process.env.NETSUITE_LIVE_PUSH_ENABLED === "true";

export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    const payload = JSON.parse(record.body);
    const transactionId = String(payload.transactionId ?? "");
    if (!transactionId) {
      log.warn("Skipping NetSuite queue message without transactionId", { body: record.body });
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

      await markTransactionSucceeded(TABLE_NAME, transactionId, result);
      emitMetric("NetSuitePushSuccess", 1, "Count");
      log.info("NetSuite transaction succeeded", { transactionId, externalId: transaction.externalId });
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
