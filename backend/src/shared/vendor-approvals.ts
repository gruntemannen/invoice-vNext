import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { docClient } from "./dynamo";
import type {
  NetSuiteEnvironmentName,
  NetSuiteVendorComparisonChange,
  NetSuiteVendorSyncPlan,
} from "./netsuite";

export type VendorApprovalStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "APPLYING"
  | "APPLIED"
  | "FAILED_RETRYABLE"
  | "FAILED_PERMANENT";

export interface VendorApprovalEvent {
  at: string;
  type: string;
  status: VendorApprovalStatus;
  actor?: string;
  message?: string;
}

export interface VendorMasterApproval {
  messageId: string;
  attachmentKey: "APPROVAL";
  approvalId: string;
  approvalType: "VENDOR_MASTER";
  entityType: "VENDOR_MASTER_APPROVAL";
  status: VendorApprovalStatus;
  environment: NetSuiteEnvironmentName;
  vendorId: string;
  vendorName?: string;
  vendorTaxId?: string;
  recordId: string;
  patch: Record<string, string>;
  changes: NetSuiteVendorComparisonChange[];
  sourceTransactionId: string;
  sourceInvoiceMessageId: string;
  sourceInvoiceAttachmentId?: string;
  sourceInvoiceNumber?: string;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNote?: string;
  appliedAt?: string;
  lastError?: string;
  gsi1pk: "APPROVAL_QUEUE";
  gsi1sk: string;
  transactionStatusPk: string;
  transactionStatusSk: string;
  events: VendorApprovalEvent[];
}

export interface DuplicateInvoiceApproval {
  messageId: string;
  attachmentKey: "APPROVAL";
  approvalId: string;
  approvalType: "DUPLICATE_INVOICE";
  entityType: "DUPLICATE_INVOICE_APPROVAL";
  status: "PENDING" | "APPROVED" | "REJECTED";
  invoiceMessageId: string;
  invoiceAttachmentKey: string;
  invoiceAttachmentId?: string;
  vendorName?: string;
  vendorTaxId?: string;
  invoiceNumber?: string;
  currency?: string;
  totalAmount?: number;
  duplicateMatches: unknown[];
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNote?: string;
  gsi1pk: "APPROVAL_QUEUE";
  gsi1sk: string;
  transactionStatusPk: string;
  transactionStatusSk: string;
  events: VendorApprovalEvent[];
}

export type ApprovalQueueItem = VendorMasterApproval | DuplicateInvoiceApproval;

export interface CreateVendorApprovalInput {
  environment: NetSuiteEnvironmentName;
  plan: NetSuiteVendorSyncPlan;
  changes: NetSuiteVendorComparisonChange[];
  patch: Record<string, string>;
  sourceTransactionId: string;
  sourceInvoiceMessageId: string;
  sourceInvoiceAttachmentId?: string;
  sourceInvoiceNumber?: string;
  vendorName?: string;
  vendorTaxId?: string;
}

const APPROVAL_SORT_KEY = "APPROVAL";

export async function createVendorMasterApproval(
  tableName: string,
  input: CreateVendorApprovalInput
): Promise<{ approval: VendorMasterApproval; created: boolean }> {
  const now = new Date().toISOString();
  const approvalId = buildVendorApprovalId(input);
  const item: VendorMasterApproval = {
    messageId: `APPROVAL#${approvalId}`,
    attachmentKey: APPROVAL_SORT_KEY,
    approvalId,
    approvalType: "VENDOR_MASTER",
    entityType: "VENDOR_MASTER_APPROVAL",
    status: "PENDING",
    environment: input.environment,
    vendorId: input.plan.vendorId,
    vendorName: input.vendorName,
    vendorTaxId: input.vendorTaxId,
    recordId: input.plan.recordId || "vendor",
    patch: input.patch,
    changes: input.changes,
    sourceTransactionId: input.sourceTransactionId,
    sourceInvoiceMessageId: input.sourceInvoiceMessageId,
    sourceInvoiceAttachmentId: input.sourceInvoiceAttachmentId,
    sourceInvoiceNumber: input.sourceInvoiceNumber,
    createdAt: now,
    updatedAt: now,
    gsi1pk: "APPROVAL_QUEUE",
    gsi1sk: `${now}#${approvalId}`,
    transactionStatusPk: statusPk("PENDING"),
    transactionStatusSk: `${now}#${approvalId}`,
    events: [
      {
        at: now,
        type: "PROPOSED",
        status: "PENDING",
        message: "Vendor master changes proposed from validated invoice data.",
      },
    ],
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: stripUndefined(item),
        ConditionExpression: "attribute_not_exists(messageId)",
      })
    );
    return { approval: item, created: true };
  } catch (error: any) {
    if (error?.name !== "ConditionalCheckFailedException") throw error;
    const existing = await getVendorMasterApproval(tableName, approvalId);
    if (!existing) throw error;
    return { approval: existing, created: false };
  }
}

export async function createDuplicateInvoiceApproval(
  tableName: string,
  input: {
    invoiceMessageId: string;
    invoiceAttachmentKey: string;
    invoiceAttachmentId?: string;
    vendorName?: string;
    vendorTaxId?: string;
    invoiceNumber?: string;
    currency?: string;
    totalAmount?: number;
    duplicateMatches: unknown[];
  }
): Promise<{ approval: DuplicateInvoiceApproval; created: boolean }> {
  const now = new Date().toISOString();
  const approvalId = buildDuplicateApprovalId(input.invoiceMessageId, input.invoiceAttachmentKey);
  const item: DuplicateInvoiceApproval = {
    messageId: `APPROVAL#${approvalId}`,
    attachmentKey: APPROVAL_SORT_KEY,
    approvalId,
    approvalType: "DUPLICATE_INVOICE",
    entityType: "DUPLICATE_INVOICE_APPROVAL",
    status: "PENDING",
    invoiceMessageId: input.invoiceMessageId,
    invoiceAttachmentKey: input.invoiceAttachmentKey,
    invoiceAttachmentId: input.invoiceAttachmentId,
    vendorName: input.vendorName,
    vendorTaxId: input.vendorTaxId,
    invoiceNumber: input.invoiceNumber,
    currency: input.currency,
    totalAmount: input.totalAmount,
    duplicateMatches: input.duplicateMatches,
    createdAt: now,
    updatedAt: now,
    gsi1pk: "APPROVAL_QUEUE",
    gsi1sk: `${now}#${approvalId}`,
    transactionStatusPk: statusPk("PENDING"),
    transactionStatusSk: `${now}#${approvalId}`,
    events: [
      {
        at: now,
        type: "PROPOSED",
        status: "PENDING",
        message: "Possible duplicate invoice requires an admin decision before NetSuite.",
      },
    ],
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: stripUndefined(item),
        ConditionExpression: "attribute_not_exists(messageId)",
      })
    );
    return { approval: item, created: true };
  } catch (error: any) {
    if (error?.name !== "ConditionalCheckFailedException") throw error;
    const existing = await getApprovalQueueItem(tableName, approvalId);
    if (!existing || existing.approvalType !== "DUPLICATE_INVOICE") throw error;
    return { approval: existing, created: false };
  }
}

export async function getVendorMasterApproval(
  tableName: string,
  approvalId: string
): Promise<VendorMasterApproval | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { messageId: `APPROVAL#${approvalId}`, attachmentKey: APPROVAL_SORT_KEY },
    })
  );
  return (result.Item as VendorMasterApproval | undefined) ?? null;
}

export async function getApprovalQueueItem(
  tableName: string,
  approvalId: string
): Promise<ApprovalQueueItem | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { messageId: `APPROVAL#${approvalId}`, attachmentKey: APPROVAL_SORT_KEY },
    })
  );
  return (result.Item as ApprovalQueueItem | undefined) ?? null;
}

export async function listApprovalQueue(
  tableName: string,
  limit: number,
  nextToken?: string,
  status?: VendorApprovalStatus
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
        ExpressionAttributeValues: { ":pk": "APPROVAL_QUEUE" },
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

  const result = await docClient.send(new QueryCommand(params));
  return {
    items: (result.Items ?? []) as ApprovalQueueItem[],
    nextToken: result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64")
      : undefined,
  };
}

export async function decideDuplicateInvoiceApproval(
  tableName: string,
  approvalId: string,
  decision: "APPROVE" | "REJECT",
  actor?: string,
  note?: string
): Promise<DuplicateInvoiceApproval> {
  const status = decision === "APPROVE" ? "APPROVED" : "REJECTED";
  const now = new Date().toISOString();
  await updateApproval(tableName, approvalId, {
    status,
    now,
    expectedStatuses: ["PENDING"],
    fields: { reviewedAt: now, reviewedBy: actor, reviewNote: note },
    event: {
      at: now,
      type: status,
      status,
      actor,
      message: note,
    },
  });
  const updated = await getApprovalQueueItem(tableName, approvalId);
  if (!updated || updated.approvalType !== "DUPLICATE_INVOICE") {
    throw new Error("Duplicate approval disappeared after decision");
  }
  return updated;
}

export async function decideVendorMasterApproval(
  tableName: string,
  approvalId: string,
  decision: "APPROVE" | "REJECT",
  actor?: string,
  note?: string
): Promise<VendorMasterApproval> {
  const status: VendorApprovalStatus = decision === "APPROVE" ? "APPROVED" : "REJECTED";
  const now = new Date().toISOString();
  await updateApproval(tableName, approvalId, {
    status,
    now,
    expectedStatuses: ["PENDING"],
    fields: {
      reviewedAt: now,
      reviewedBy: actor,
      reviewNote: note,
    },
    event: {
      at: now,
      type: decision === "APPROVE" ? "APPROVED" : "REJECTED",
      status,
      actor,
      message: note,
    },
  });
  const updated = await getVendorMasterApproval(tableName, approvalId);
  if (!updated) throw new Error("Vendor approval disappeared after decision");
  return updated;
}

export async function markVendorApprovalApplying(tableName: string, approvalId: string) {
  const now = new Date().toISOString();
  await updateApproval(tableName, approvalId, {
    status: "APPLYING",
    now,
    expectedStatuses: ["APPROVED", "FAILED_RETRYABLE"],
    event: {
      at: now,
      type: "APPLYING",
      status: "APPLYING",
      message: "Applying approved vendor changes to NetSuite.",
    },
  });
}

export async function markVendorApprovalApplied(tableName: string, approvalId: string) {
  const now = new Date().toISOString();
  await updateApproval(tableName, approvalId, {
    status: "APPLIED",
    now,
    expectedStatuses: ["APPLYING"],
    fields: { appliedAt: now, lastError: null },
    event: {
      at: now,
      type: "APPLIED",
      status: "APPLIED",
      message: "Approved vendor changes were applied to NetSuite.",
    },
  });
}

export async function markVendorApprovalFailed(
  tableName: string,
  approvalId: string,
  retryable: boolean,
  error: string
) {
  const status: VendorApprovalStatus = retryable ? "FAILED_RETRYABLE" : "FAILED_PERMANENT";
  const now = new Date().toISOString();
  await updateApproval(tableName, approvalId, {
    status,
    now,
    expectedStatuses: ["APPROVED", "APPLYING", "FAILED_RETRYABLE"],
    fields: { lastError: error },
    event: { at: now, type: "APPLY_FAILED", status, message: error },
  });
}

export function summarizeVendorApproval(item: VendorMasterApproval) {
  return {
    approvalId: item.approvalId,
    status: item.status,
    environment: item.environment,
    vendorId: item.vendorId,
    vendorName: item.vendorName,
    vendorTaxId: item.vendorTaxId,
    recordId: item.recordId,
    changes: item.changes,
    sourceTransactionId: item.sourceTransactionId,
    sourceInvoiceMessageId: item.sourceInvoiceMessageId,
    sourceInvoiceAttachmentId: item.sourceInvoiceAttachmentId,
    sourceInvoiceNumber: item.sourceInvoiceNumber,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    reviewedAt: item.reviewedAt,
    reviewedBy: item.reviewedBy,
    reviewNote: item.reviewNote,
    appliedAt: item.appliedAt,
    lastError: item.lastError,
  };
}

export function summarizeApprovalQueueItem(item: ApprovalQueueItem) {
  if (item.approvalType === "DUPLICATE_INVOICE") {
    return {
      approvalId: item.approvalId,
      approvalType: item.approvalType,
      status: item.status,
      vendorName: item.vendorName,
      vendorTaxId: item.vendorTaxId,
      invoiceNumber: item.invoiceNumber,
      currency: item.currency,
      totalAmount: item.totalAmount,
      duplicateMatches: item.duplicateMatches,
      invoiceMessageId: item.invoiceMessageId,
      invoiceAttachmentId: item.invoiceAttachmentId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      reviewedAt: item.reviewedAt,
      reviewedBy: item.reviewedBy,
      reviewNote: item.reviewNote,
    };
  }
  return { ...summarizeVendorApproval(item), approvalType: item.approvalType };
}

function buildVendorApprovalId(input: CreateVendorApprovalInput): string {
  const normalizedPatch = Object.fromEntries(
    Object.entries(input.patch).sort(([left], [right]) => left.localeCompare(right))
  );
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        environment: input.environment,
        recordId: input.plan.recordId,
        vendorId: input.plan.vendorId,
        patch: normalizedPatch,
      })
    )
    .digest("hex")
    .slice(0, 32);
  return `va-${digest}`;
}

function buildDuplicateApprovalId(invoiceMessageId: string, invoiceAttachmentKey: string): string {
  const digest = createHash("sha256")
    .update(`${invoiceMessageId}\n${invoiceAttachmentKey}`)
    .digest("hex")
    .slice(0, 32);
  return `dup-${digest}`;
}

function statusPk(status: VendorApprovalStatus) {
  return `APPROVAL_QUEUE#${status}`;
}

async function updateApproval(
  tableName: string,
  approvalId: string,
  update: {
    status: VendorApprovalStatus;
    now: string;
    expectedStatuses: VendorApprovalStatus[];
    fields?: Record<string, unknown>;
    event: VendorApprovalEvent;
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
    ":updatedAt": update.now,
    ":transactionStatusPk": statusPk(update.status),
    ":transactionStatusSk": `${update.now}#${approvalId}`,
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

  Object.entries(update.fields ?? {}).forEach(([key, value], index) => {
    if (value === undefined) return;
    names[`#field${index}`] = key;
    values[`:field${index}`] = value;
    setParts.push(`#field${index} = :field${index}`);
  });

  update.expectedStatuses.forEach((status, index) => {
    values[`:expected${index}`] = status;
  });

  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { messageId: `APPROVAL#${approvalId}`, attachmentKey: APPROVAL_SORT_KEY },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ConditionExpression: `attribute_exists(messageId) AND #status IN (${update.expectedStatuses
        .map((_, index) => `:expected${index}`)
        .join(", ")})`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

function stripUndefined(value: unknown): any {
  if (Array.isArray(value)) return value.map(stripUndefined).filter((entry) => entry !== undefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, stripUndefined(entry)])
    );
  }
  return value;
}
