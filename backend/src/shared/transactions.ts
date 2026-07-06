import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { docClient } from "./dynamo";

export type NetSuiteTransactionStatus =
  | "HELD_FOR_REVIEW"
  | "HELD_FOR_CONFIGURATION"
  | "QUEUED"
  | "IN_FLIGHT"
  | "SUCCEEDED"
  | "FAILED_RETRYABLE"
  | "FAILED_PERMANENT";

export interface TransactionEvent {
  at: string;
  type: string;
  message?: string;
  status?: NetSuiteTransactionStatus;
  details?: Record<string, unknown>;
}

export interface NetSuiteTransaction {
  messageId: string;
  attachmentKey: string;
  transactionId: string;
  entityType: "NETSUITE_TRANSACTION";
  integration: "NETSUITE";
  operation: "UPSERT_NETSUITE_RECORD";
  status: NetSuiteTransactionStatus;
  invoiceMessageId: string;
  invoiceAttachmentKey: string;
  invoiceAttachmentId?: string;
  externalId: string;
  idempotencyKey: string;
  requestPayload: unknown;
  validation?: unknown;
  flow?: unknown;
  warnings?: string[];
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  replayCount: number;
  lastAttemptAt?: string;
  lastError?: string;
  netSuiteLocation?: string | null;
  netSuiteStatus?: number;
  gsi1pk: "NETSUITE_TRANSACTION";
  gsi1sk: string;
  transactionStatusPk: string;
  transactionStatusSk: string;
  events: TransactionEvent[];
}

export interface CreateNetSuiteTransactionInput {
  invoiceMessageId: string;
  invoiceAttachmentKey: string;
  invoiceAttachmentId?: string;
  externalId: string;
  requestPayload: unknown;
  validation?: unknown;
  flow?: unknown;
  warnings?: string[];
  status: NetSuiteTransactionStatus;
  eventMessage: string;
}

const TX_SORT_KEY = "TRANSACTION";

export function canReplay(status?: string): boolean {
  return (
    status === "FAILED_RETRYABLE" ||
    status === "HELD_FOR_CONFIGURATION" ||
    status === "HELD_FOR_REVIEW" ||
    status === "FAILED_PERMANENT"
  );
}

export async function createNetSuiteTransaction(
  tableName: string,
  input: CreateNetSuiteTransactionInput
): Promise<NetSuiteTransaction> {
  const now = new Date().toISOString();
  const transactionId = `ns-${randomUUID()}`;
  const item: NetSuiteTransaction = {
    messageId: `TX#${transactionId}`,
    attachmentKey: TX_SORT_KEY,
    transactionId,
    entityType: "NETSUITE_TRANSACTION",
    integration: "NETSUITE",
    operation: "UPSERT_NETSUITE_RECORD",
    status: input.status,
    invoiceMessageId: input.invoiceMessageId,
    invoiceAttachmentKey: input.invoiceAttachmentKey,
    invoiceAttachmentId: input.invoiceAttachmentId,
    externalId: input.externalId,
    idempotencyKey: input.externalId,
    requestPayload: input.requestPayload,
    validation: input.validation,
    flow: input.flow,
    warnings: input.warnings ?? [],
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    replayCount: 0,
    gsi1pk: "NETSUITE_TRANSACTION",
    gsi1sk: `${now}#${transactionId}`,
    transactionStatusPk: statusPk(input.status),
    transactionStatusSk: `${now}#${transactionId}`,
    events: [
      {
        at: now,
        type: "CREATED",
        status: input.status,
        message: input.eventMessage,
      },
    ],
  };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: stripUndefined(item) as Record<string, any>,
      ConditionExpression: "attribute_not_exists(messageId)",
    })
  );

  return item;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, stripUndefined(v)])
    );
  }
  return value;
}

export async function getNetSuiteTransaction(
  tableName: string,
  transactionId: string
): Promise<NetSuiteTransaction | null> {
  const res = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { messageId: `TX#${transactionId}`, attachmentKey: TX_SORT_KEY },
    })
  );
  return (res.Item as NetSuiteTransaction | undefined) ?? null;
}

export async function listNetSuiteTransactions(
  tableName: string,
  limit: number,
  nextToken?: string,
  status?: NetSuiteTransactionStatus
) {
  const params: any = status
    ? {
        TableName: tableName,
        IndexName: "transaction-status",
        KeyConditionExpression: "transactionStatusPk = :pk",
        ExpressionAttributeValues: { ":pk": statusPk(status) },
        Limit: limit,
        ScanIndexForward: false,
      }
    : {
        TableName: tableName,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": "NETSUITE_TRANSACTION" },
        Limit: limit,
        ScanIndexForward: false,
      };

  if (nextToken) {
    try {
      params.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, "base64").toString("utf-8"));
    } catch {
      throw Object.assign(new Error("Invalid nextToken"), { statusCode: 400 });
    }
  }

  const res = await docClient.send(new QueryCommand(params));
  const token = res.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString("base64")
    : undefined;

  return { items: (res.Items ?? []) as NetSuiteTransaction[], nextToken: token };
}

export async function markTransactionQueued(
  tableName: string,
  transactionId: string,
  replay = false
) {
  const now = new Date().toISOString();
  const event: TransactionEvent = {
    at: now,
    type: replay ? "REPLAY_QUEUED" : "QUEUED",
    status: "QUEUED",
    message: replay ? "Transaction was queued for replay." : "Transaction was queued for NetSuite push.",
  };
  await updateTransaction(tableName, transactionId, {
    status: "QUEUED",
    updatedAt: now,
    transactionStatusPk: statusPk("QUEUED"),
    transactionStatusSk: `${now}#${transactionId}`,
    ...(replay ? { replayCountIncrement: 1 } : {}),
    event,
  });
}

export async function markTransactionInFlight(tableName: string, transactionId: string) {
  const now = new Date().toISOString();
  await updateTransaction(tableName, transactionId, {
    status: "IN_FLIGHT",
    updatedAt: now,
    lastAttemptAt: now,
    transactionStatusPk: statusPk("IN_FLIGHT"),
    transactionStatusSk: `${now}#${transactionId}`,
    attemptCountIncrement: 1,
    event: {
      at: now,
      type: "ATTEMPT_STARTED",
      status: "IN_FLIGHT",
      message: "NetSuite push attempt started.",
    },
  });
}

export async function markTransactionSucceeded(
  tableName: string,
  transactionId: string,
  result: { status?: number; location?: string | null; body?: unknown }
) {
  const now = new Date().toISOString();
  await updateTransaction(tableName, transactionId, {
    status: "SUCCEEDED",
    updatedAt: now,
    transactionStatusPk: statusPk("SUCCEEDED"),
    transactionStatusSk: `${now}#${transactionId}`,
    netSuiteStatus: result.status,
    netSuiteLocation: result.location,
    lastError: null,
    event: {
      at: now,
      type: "ATTEMPT_SUCCEEDED",
      status: "SUCCEEDED",
      message: "NetSuite upsert succeeded.",
      details: { status: result.status, location: result.location },
    },
  });
}

export async function markTransactionFailed(
  tableName: string,
  transactionId: string,
  retryable: boolean,
  error: string
) {
  const now = new Date().toISOString();
  const status: NetSuiteTransactionStatus = retryable ? "FAILED_RETRYABLE" : "FAILED_PERMANENT";
  await updateTransaction(tableName, transactionId, {
    status,
    updatedAt: now,
    transactionStatusPk: statusPk(status),
    transactionStatusSk: `${now}#${transactionId}`,
    lastError: error,
    event: {
      at: now,
      type: "ATTEMPT_FAILED",
      status,
      message: error,
    },
  });
}

export function summarizeTransaction(item: NetSuiteTransaction) {
  return {
    transactionId: item.transactionId,
    status: item.status,
    invoiceMessageId: item.invoiceMessageId,
    invoiceAttachmentId: item.invoiceAttachmentId,
    externalId: item.externalId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    attemptCount: item.attemptCount,
    replayCount: item.replayCount,
    lastAttemptAt: item.lastAttemptAt,
    lastError: item.lastError,
    netSuiteLocation: item.netSuiteLocation,
    netSuiteStatus: item.netSuiteStatus,
  };
}

function statusPk(status: NetSuiteTransactionStatus): string {
  return `NETSUITE_TRANSACTION#${status}`;
}

async function updateTransaction(
  tableName: string,
  transactionId: string,
  update: {
    status: NetSuiteTransactionStatus;
    updatedAt: string;
    transactionStatusPk: string;
    transactionStatusSk: string;
    lastAttemptAt?: string;
    lastError?: string | null;
    netSuiteStatus?: number;
    netSuiteLocation?: string | null;
    attemptCountIncrement?: number;
    replayCountIncrement?: number;
    event: TransactionEvent;
  }
) {
  const names: Record<string, string> = {
    "#status": "status",
    "#updatedAt": "updatedAt",
    "#transactionStatusPk": "transactionStatusPk",
    "#transactionStatusSk": "transactionStatusSk",
    "#events": "events",
  };
  const values: Record<string, unknown> = {
    ":status": update.status,
    ":updatedAt": update.updatedAt,
    ":transactionStatusPk": update.transactionStatusPk,
    ":transactionStatusSk": update.transactionStatusSk,
    ":event": [update.event],
    ":emptyEvents": [],
  };
  const setParts = [
    "#status = :status",
    "#updatedAt = :updatedAt",
    "#transactionStatusPk = :transactionStatusPk",
    "#transactionStatusSk = :transactionStatusSk",
    "#events = list_append(if_not_exists(#events, :emptyEvents), :event)",
  ];
  const addParts: string[] = [];

  if (update.lastAttemptAt) {
    names["#lastAttemptAt"] = "lastAttemptAt";
    values[":lastAttemptAt"] = update.lastAttemptAt;
    setParts.push("#lastAttemptAt = :lastAttemptAt");
  }
  if (update.lastError !== undefined) {
    names["#lastError"] = "lastError";
    values[":lastError"] = update.lastError;
    setParts.push("#lastError = :lastError");
  }
  if (update.netSuiteStatus !== undefined) {
    names["#netSuiteStatus"] = "netSuiteStatus";
    values[":netSuiteStatus"] = update.netSuiteStatus;
    setParts.push("#netSuiteStatus = :netSuiteStatus");
  }
  if (update.netSuiteLocation !== undefined) {
    names["#netSuiteLocation"] = "netSuiteLocation";
    values[":netSuiteLocation"] = update.netSuiteLocation;
    setParts.push("#netSuiteLocation = :netSuiteLocation");
  }
  if (update.attemptCountIncrement) {
    names["#attemptCount"] = "attemptCount";
    values[":attemptInc"] = update.attemptCountIncrement;
    addParts.push("#attemptCount :attemptInc");
  }
  if (update.replayCountIncrement) {
    names["#replayCount"] = "replayCount";
    values[":replayInc"] = update.replayCountIncrement;
    addParts.push("#replayCount :replayInc");
  }

  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { messageId: `TX#${transactionId}`, attachmentKey: TX_SORT_KEY },
      UpdateExpression: `SET ${setParts.join(", ")}${addParts.length ? ` ADD ${addParts.join(", ")}` : ""}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(messageId)",
    })
  );
}
