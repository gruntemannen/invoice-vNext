import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(client);

export async function putItem(tableName: string, item: Record<string, any>) {
  await docClient.send(new PutCommand({ TableName: tableName, Item: item }));
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
    const nameKey = `#k${index}`;
    const valueKey = `:v${index}`;
    names[nameKey] = k;
    values[valueKey] = v;
    expressionParts.push(`${nameKey} = ${valueKey}`);
  });

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

export async function getItem(tableName: string, key: { messageId: string; attachmentKey: string }) {
  const res = await docClient.send(new GetCommand({ TableName: tableName, Key: key }));
  return res.Item;
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
    params.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, "base64").toString("utf-8"));
  }

  const res = await docClient.send(new QueryCommand(params));
  const token = res.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString("base64")
    : undefined;

  return { items: res.Items ?? [], nextToken: token };
}
