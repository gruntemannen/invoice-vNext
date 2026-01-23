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
