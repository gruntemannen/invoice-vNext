import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./dynamo";
import {
  deriveNetSuiteConnectionDefaults,
  type NetSuiteConnectionOptions,
  type NetSuiteEnvironmentName,
} from "./netsuite";

export interface NetSuiteEnvironmentSettings extends NetSuiteConnectionOptions {
  label: string;
  secretArn?: string;
}

export interface NetSuiteRuntimeSettings {
  activeEnvironment: NetSuiteEnvironmentName;
  environments: Record<NetSuiteEnvironmentName, NetSuiteEnvironmentSettings>;
  updatedAt?: string;
  updatedBy?: string;
}

const SETTINGS_PK = "CONFIG#NETSUITE";
const SETTINGS_SK = "SETTINGS";

export function defaultNetSuiteRuntimeSettings(): NetSuiteRuntimeSettings {
  return {
    activeEnvironment: "test",
    environments: {
      test: defaultEnvironment("Test"),
      prod: defaultEnvironment("Prod"),
    },
  };
}

export async function getNetSuiteRuntimeSettings(tableName: string): Promise<NetSuiteRuntimeSettings> {
  if (!tableName) return defaultNetSuiteRuntimeSettings();

  const res = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { messageId: SETTINGS_PK, attachmentKey: SETTINGS_SK },
    })
  );

  return normalizeSettings(res.Item?.settings);
}

export async function saveNetSuiteRuntimeSettings(
  tableName: string,
  input: unknown,
  updatedBy?: string
): Promise<NetSuiteRuntimeSettings> {
  const now = new Date().toISOString();
  const settings = normalizeSettings(input, { updatedAt: now, updatedBy });

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        messageId: SETTINGS_PK,
        attachmentKey: SETTINGS_SK,
        entityType: "NETSUITE_SETTINGS",
        settings,
        updatedAt: now,
        updatedBy,
      },
    })
  );

  return settings;
}

export function activeNetSuiteEnvironment(
  settings: NetSuiteRuntimeSettings
): NetSuiteEnvironmentSettings {
  return settings.environments[settings.activeEnvironment] ?? settings.environments.test;
}

export function environmentByName(
  settings: NetSuiteRuntimeSettings,
  environment?: NetSuiteEnvironmentName
): NetSuiteEnvironmentSettings {
  return settings.environments[environment ?? settings.activeEnvironment] ?? activeNetSuiteEnvironment(settings);
}

function defaultEnvironment(label: string): NetSuiteEnvironmentSettings {
  return {
    label,
    accountId: "",
    restApiBaseUrl: "",
    tokenEndpointUrl: "",
    recordApiPath: "/record/v1",
    suiteqlPath: "/query/v1/suiteql",
    oauthScope: "rest_webservices",
    requestTimeoutMs: 30000,
    vendorBillRecordId: "vendorBill",
    vendorPrepaymentRecordId: "vendorPrepayment",
    suiteTaxEnabled: false,
    allowTranId: true,
    secretArn: "",
  };
}

function normalizeSettings(input: any, audit?: { updatedAt?: string; updatedBy?: string }): NetSuiteRuntimeSettings {
  const defaults = defaultNetSuiteRuntimeSettings();
  const activeEnvironment = input?.activeEnvironment === "prod" ? "prod" : "test";

  return {
    activeEnvironment,
    environments: {
      test: normalizeEnvironment(input?.environments?.test, defaults.environments.test),
      prod: normalizeEnvironment(input?.environments?.prod, defaults.environments.prod),
    },
    updatedAt: audit?.updatedAt ?? stringOrUndefined(input?.updatedAt),
    updatedBy: audit?.updatedBy ?? stringOrUndefined(input?.updatedBy),
  };
}

function normalizeEnvironment(input: any, fallback: NetSuiteEnvironmentSettings): NetSuiteEnvironmentSettings {
  const accountId = stringOrEmpty(input?.accountId);
  const derived = deriveNetSuiteConnectionDefaults(accountId);
  return {
    label: stringOrEmpty(input?.label) || fallback.label,
    accountId,
    restApiBaseUrl: stringOrEmpty(input?.restApiBaseUrl) || derived.restApiBaseUrl,
    tokenEndpointUrl: stringOrEmpty(input?.tokenEndpointUrl) || derived.tokenEndpointUrl,
    recordApiPath: normalizePath(input?.recordApiPath, fallback.recordApiPath),
    suiteqlPath: normalizePath(input?.suiteqlPath, fallback.suiteqlPath),
    oauthScope: stringOrEmpty(input?.oauthScope) || fallback.oauthScope,
    requestTimeoutMs: positiveNumber(input?.requestTimeoutMs, fallback.requestTimeoutMs),
    vendorBillRecordId: stringOrEmpty(input?.vendorBillRecordId) || fallback.vendorBillRecordId,
    vendorPrepaymentRecordId:
      stringOrEmpty(input?.vendorPrepaymentRecordId) || fallback.vendorPrepaymentRecordId,
    suiteTaxEnabled: Boolean(input?.suiteTaxEnabled),
    allowTranId: input?.allowTranId === false ? false : true,
    secretArn: stringOrEmpty(input?.secretArn),
  };
}

function normalizePath(value: unknown, fallback?: string): string {
  const raw = stringOrEmpty(value) || fallback || "";
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function positiveNumber(value: unknown, fallback?: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback ?? 30000;
}

function stringOrEmpty(value: unknown): string {
  return String(value ?? "").trim();
}

function stringOrUndefined(value: unknown): string | undefined {
  const s = stringOrEmpty(value);
  return s || undefined;
}
