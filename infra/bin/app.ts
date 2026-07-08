#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { OrgAccountStack } from "../lib/org-account-stack";
import { MemberBootstrapStack } from "../lib/member-bootstrap-stack";
import { InvoiceExtractorStack } from "../lib/workload-stack";
import { CognitoAuthConfig, config } from "../lib/config";

const app = new cdk.App();
const defaultAccount = process.env.CDK_DEFAULT_ACCOUNT ?? cdk.Aws.ACCOUNT_ID;
const stackFilter = String(app.node.tryGetContext("stacks") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const shouldDeploy = (name: string) => stackFilter.length === 0 || stackFilter.includes(name);

function nonEmptyContext(name: string): string | undefined {
  const value = app.node.tryGetContext(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function objectContext(name: string): Partial<CognitoAuthConfig> {
  const value = app.node.tryGetContext(name);
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Partial<CognitoAuthConfig>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed && !Array.isArray(parsed)
      ? (parsed as Partial<CognitoAuthConfig>)
      : {};
  } catch {
    return {};
  }
}

function readCognitoContext(): CognitoAuthConfig | undefined {
  const contextConfig: CognitoAuthConfig = {
    ...objectContext("cognito"),
  };
  const contextPairs: Array<[keyof CognitoAuthConfig, string]> = [
    ["issuer", "cognitoIssuer"],
    ["region", "cognitoRegion"],
    ["userPoolId", "cognitoUserPoolId"],
    ["clientId", "cognitoClientId"],
    ["domain", "cognitoDomain"],
    ["scope", "cognitoScope"],
    ["responseType", "cognitoResponseType"],
  ];

  for (const [key, contextName] of contextPairs) {
    const value = nonEmptyContext(contextName);
    if (value) (contextConfig as Record<string, string>)[key] = value;
  }

  const merged = { ...(config.cognito ?? {}), ...contextConfig };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

const cognitoConfig = readCognitoContext();

if (shouldDeploy("OrgAccountStack")) {
  new OrgAccountStack(app, "OrgAccountStack", {
    env: { account: config.managementAccountId, region: config.region },
  });
}

if (shouldDeploy("MemberBootstrapStack")) {
  new MemberBootstrapStack(app, "MemberBootstrapStack", {
    env: { account: defaultAccount, region: config.region },
    managementAccountId: config.managementAccountId,
    projectPrefix: config.projectPrefix,
  });
}

if (shouldDeploy("InvoiceExtractorStack")) {
  new InvoiceExtractorStack(app, "InvoiceExtractorStack", {
    env: { account: defaultAccount, region: config.region },
    projectPrefix: config.projectPrefix,
    bedrockModelId: config.bedrockModelId,
    maxUploadBytes: config.maxUploadBytes,
    dataRetentionDays: config.dataRetentionDays,
    extractReservedConcurrency: config.extractReservedConcurrency,
    viesLookupEnabled: config.viesLookupEnabled,
    viesRequestTimeoutMs: config.viesRequestTimeoutMs,
    netSuiteLivePushEnabled: config.netSuiteLivePushEnabled,
    cognito: cognitoConfig,
  });
}
