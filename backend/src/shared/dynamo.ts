import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(stripUndefined).filter((item) => item !== undefined) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, stripUndefined(v)])
    ) as T;
  }
  return value;
}

export async function putItem(tableName: string, item: Record<string, any>) {
  await docClient.send(new PutCommand({ TableName: tableName, Item: stripUndefined(item) }));
}

export async function updateItem(
  tableName: string,
  key: { messageId: string; attachmentKey: string },
  updates: Record<string, any>
) {
  const expressionParts: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, any> = {};

  Object.entries(updates).forEach(([k, v], index) => {
    if (v === undefined) return;
    const nameKey = `#k${index}`;
    const valueKey = `:v${index}`;
    names[nameKey] = k;
    values[valueKey] = stripUndefined(v);
    expressionParts.push(`${nameKey} = ${valueKey}`);
  });

  if (expressionParts.length === 0) {
    return;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: `SET ${expressionParts.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

export async function queryInvoices(
  tableName: string,
  limit: number,
  nextToken?: string
) {
  const params: any = {
    TableName: tableName,
    IndexName: "gsi1",
    KeyConditionExpression: "gsi1pk = :pk",
    ExpressionAttributeValues: { ":pk": "INVOICE" },
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

  return { items: res.Items ?? [], nextToken: token };
}

export async function queryDuplicateInvoices(
  tableName: string,
  duplicatePk: string,
  current?: { messageId?: string; attachmentKey?: string }
) {
  const res = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "duplicate",
      KeyConditionExpression: "duplicatePk = :pk",
      ExpressionAttributeValues: { ":pk": duplicatePk },
      ScanIndexForward: false,
      Limit: 10,
    })
  );

  return (res.Items ?? []).filter((item) => {
    if (item.status === "FAILED") return false;
    if (!current?.messageId || !current?.attachmentKey) return true;
    return !(item.messageId === current.messageId && item.attachmentKey === current.attachmentKey);
  });
}
