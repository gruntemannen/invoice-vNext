import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./dynamo";

export interface StatsResponse {
  totals: { all: number; pending: number; completed: number; failed: number };
  successRate: number;
  avgConfidence: number;
  byStatus: { PENDING: number; COMPLETED: number; FAILED: number };
  byDay: Array<{ date: string; ingested: number; completed: number; failed: number }>;
  recentFailures: Array<{
    messageId: string;
    attachmentId: string;
    subject: string;
    from: string;
    updatedAt: string;
    error: string;
  }>;
  generatedAt: string;
}

// Safety cap: we aggregate at most this many invoice rows in a single /stats call.
// For the current scale this is ample; if the dataset grows beyond this we should
// move aggregation to a precomputed/materialized counter instead of a full scan.
const MAX_ITEMS = 5000;

// Number of trailing calendar days (including today) reported in byDay.
const BY_DAY_WINDOW = 30;

type InvoiceItem = {
  messageId?: string;
  attachmentId?: string;
  status?: string;
  receivedAt?: string;
  updatedAt?: string;
  from?: string;
  subject?: string;
  confidence?: number;
  errors?: string[];
};

// Format a Date as a YYYY-MM-DD calendar day in UTC.
function toDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function computeStats(tableName: string): Promise<StatsResponse> {
  const items: InvoiceItem[] = [];
  let exclusiveStartKey: Record<string, any> | undefined = undefined;

  // Page through the "gsi1" GSI (gsi1pk = "INVOICE") until exhausted or the cap is hit.
  do {
    const res: any = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": "INVOICE" },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const it of (res.Items ?? []) as InvoiceItem[]) {
      items.push(it);
      if (items.length >= MAX_ITEMS) break;
    }
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey && items.length < MAX_ITEMS);

  const byStatus = { PENDING: 0, COMPLETED: 0, FAILED: 0 };
  let confidenceSum = 0;
  let confidenceCount = 0;

  // Build the byDay window: keys for the last BY_DAY_WINDOW days, ascending, seeded with zeros.
  const dayBuckets = new Map<
    string,
    { ingested: number; completed: number; failed: number }
  >();
  const orderedDays: string[] = [];
  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  for (let i = BY_DAY_WINDOW - 1; i >= 0; i--) {
    const d = new Date(todayUtc);
    d.setUTCDate(todayUtc.getUTCDate() - i);
    const key = toDayKey(d);
    orderedDays.push(key);
    dayBuckets.set(key, { ingested: 0, completed: 0, failed: 0 });
  }

  const failures: InvoiceItem[] = [];

  for (const item of items) {
    const status = item.status === "PENDING" || item.status === "COMPLETED" || item.status === "FAILED"
      ? item.status
      : undefined;

    if (status) {
      byStatus[status] += 1;
    }

    if (status === "COMPLETED" && typeof item.confidence === "number" && Number.isFinite(item.confidence)) {
      confidenceSum += item.confidence;
      confidenceCount += 1;
    }

    if (status === "FAILED") {
      failures.push(item);
    }

    // byDay keyed on receivedAt's calendar day; ignore items outside the window or with bad dates.
    if (item.receivedAt) {
      const parsed = new Date(item.receivedAt);
      if (!Number.isNaN(parsed.getTime())) {
        const key = toDayKey(parsed);
        const bucket = dayBuckets.get(key);
        if (bucket) {
          bucket.ingested += 1;
          if (status === "COMPLETED") bucket.completed += 1;
          else if (status === "FAILED") bucket.failed += 1;
        }
      }
    }
  }

  const pending = byStatus.PENDING;
  const completed = byStatus.COMPLETED;
  const failed = byStatus.FAILED;
  const all = items.length;

  const successDenominator = completed + failed;
  const successRate = successDenominator > 0 ? completed / successDenominator : 0;
  const avgConfidence = confidenceCount > 0 ? confidenceSum / confidenceCount : 0;

  const byDay = orderedDays.map((date) => {
    const b = dayBuckets.get(date)!;
    return { date, ingested: b.ingested, completed: b.completed, failed: b.failed };
  });

  // recentFailures: up to 20 FAILED items, newest first by updatedAt.
  const recentFailures = failures
    .slice()
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, 20)
    .map((item) => ({
      messageId: String(item.messageId ?? ""),
      attachmentId: String(item.attachmentId ?? ""),
      subject: String(item.subject ?? ""),
      from: String(item.from ?? ""),
      updatedAt: String(item.updatedAt ?? ""),
      error: (item.errors && item.errors[0]) || "unknown",
    }));

  return {
    totals: { all, pending, completed, failed },
    successRate,
    avgConfidence,
    byStatus,
    byDay,
    recentFailures,
    generatedAt: new Date().toISOString(),
  };
}
