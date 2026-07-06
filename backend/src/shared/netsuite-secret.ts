import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { NetSuiteSecret } from "./netsuite";

const secrets = new SecretsManagerClient({});
const cache = new Map<string, NetSuiteSecret>();

export async function loadNetSuiteSecret(secretArn: string): Promise<NetSuiteSecret> {
  if (!secretArn) {
    throw new Error("NETSUITE_SECRET_ARN is not configured");
  }
  const cached = cache.get(secretArn);
  if (cached) return cached;

  const res = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const raw = res.SecretString;
  if (!raw) {
    throw new Error("NetSuite secret has no SecretString");
  }

  const parsed = JSON.parse(raw);
  for (const key of ["accountId", "clientId", "certificateId", "privateKeyPem", "alg"]) {
    if (!parsed[key]) {
      throw new Error(`NetSuite secret is missing ${key}`);
    }
  }

  const secret: NetSuiteSecret = {
    accountId: String(parsed.accountId),
    clientId: String(parsed.clientId),
    certificateId: String(parsed.certificateId),
    privateKeyPem: String(parsed.privateKeyPem),
    alg: parsed.alg,
  };
  cache.set(secretArn, secret);
  return secret;
}
