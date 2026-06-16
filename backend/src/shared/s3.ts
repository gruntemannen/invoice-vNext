import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const client = new S3Client({});

export async function getObjectBuffer(bucket: string, key: string): Promise<Buffer> {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as any) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Like getObjectBuffer, but also returns the stored content-type. */
export async function getObject(
  bucket: string,
  key: string
): Promise<{ body: Buffer; contentType?: string }> {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as any) {
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks), contentType: res.ContentType };
}

export async function putObject(
  bucket: string,
  key: string,
  body: Buffer,
  contentType?: string
) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}
