import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { NetSuiteSecret } from "./netsuite";

const secrets = new SecretsManagerClient({});
let cached: NetSuiteSecret | null = null;

export async function loadNetSuiteSecret(secretArn: string): Promise<NetSuiteSecret> {
  if (cached) return cached;
  if (!secretArn) {
    throw new Error("NETSUITE_SECRET_ARN is not configured");
  }

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

  cached = {
    accountId: String(parsed.accountId),
    clientId: String(parsed.clientId),
    certificateId: String(parsed.certificateId),
    privateKeyPem: String(parsed.privateKeyPem),
    alg: parsed.alg,
  };
  return cached;
}
