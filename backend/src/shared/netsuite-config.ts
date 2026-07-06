import { exampleNetSuiteConfig, type NetSuiteBusinessUnitRoute, type NetSuiteConfig } from "./netsuite";

function blankToUndefined<T>(value: T): T | undefined {
  return value === "" || value === null ? undefined : value;
}

function normalizeCrosswalk(input: any): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => typeof value === "string" && value.trim() !== "")
  ) as Record<string, string>;
}

function normalizeBusinessUnits(input: any): Record<string, NetSuiteBusinessUnitRoute> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, NetSuiteBusinessUnitRoute> = {};
  for (const [key, rawRoute] of Object.entries(input)) {
    if (!key || !rawRoute || typeof rawRoute !== "object") continue;
    const route = rawRoute as any;
    out[key] = {
      businessUnitId: blankToUndefined(route.businessUnitId),
      businessUnitName: blankToUndefined(route.businessUnitName),
      subsidiaryId: blankToUndefined(route.subsidiaryId),
      departmentId: blankToUndefined(route.departmentId),
      classId: blankToUndefined(route.classId),
      locationId: blankToUndefined(route.locationId),
      customBodyFields: normalizeCustomFields(route.customBodyFields),
      customLineFields: normalizeCustomFields(route.customLineFields),
    };
  }
  return out;
}

function normalizeCustomFields(input: any): Record<string, any> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const entries = Object.entries(input).filter(([, value]) => value !== "" && value !== null && value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function loadNetSuiteConfig(): NetSuiteConfig {
  let raw: any;
  try {
    // Bundled by esbuild into the Lambda artifact. Keep credentials out of this JSON.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    raw = require("../../netsuite-config.json");
  } catch {
    return exampleNetSuiteConfig;
  }

  const defaults = raw.defaults ?? {};
  const crosswalks = raw.crosswalks ?? {};

  return {
    subsidiaryId: blankToUndefined(raw.subsidiaryId),
    apAccountId: blankToUndefined(raw.apAccountId),
    prepaymentPaymentAccountId: blankToUndefined(raw.prepaymentPaymentAccountId),
    prepaymentAccountId: blankToUndefined(raw.prepaymentAccountId),
    businessUnitSegmentFieldId: blankToUndefined(raw.businessUnitSegmentFieldId),
    defaults: {
      expenseAccountId: blankToUndefined(defaults.expenseAccountId),
      departmentId: blankToUndefined(defaults.departmentId),
      classId: blankToUndefined(defaults.classId),
      locationId: blankToUndefined(defaults.locationId),
      taxCodeId: blankToUndefined(defaults.taxCodeId),
    },
    crosswalks: {
      vendorsByTaxId: normalizeCrosswalk(crosswalks.vendorsByTaxId),
      vendorsByName: normalizeCrosswalk(crosswalks.vendorsByName),
      accountsByCode: normalizeCrosswalk(crosswalks.accountsByCode),
      currenciesByCode: normalizeCrosswalk(crosswalks.currenciesByCode),
      departmentsByCode: normalizeCrosswalk(crosswalks.departmentsByCode),
      classesByCode: normalizeCrosswalk(crosswalks.classesByCode),
      termsByName: normalizeCrosswalk(crosswalks.termsByName),
      subsidiariesByTaxId: normalizeCrosswalk(crosswalks.subsidiariesByTaxId),
      subsidiariesByName: normalizeCrosswalk(crosswalks.subsidiariesByName),
      purchaseOrdersByNumber: normalizeCrosswalk(crosswalks.purchaseOrdersByNumber),
      businessUnitsByTaxId: normalizeCrosswalk(crosswalks.businessUnitsByTaxId),
      businessUnitsByName: normalizeCrosswalk(crosswalks.businessUnitsByName),
      businessUnitsByEntityCode: normalizeCrosswalk(crosswalks.businessUnitsByEntityCode),
      businessUnitsByEmailDomain: normalizeCrosswalk(crosswalks.businessUnitsByEmailDomain),
      businessUnitsByAddressContains: normalizeCrosswalk(crosswalks.businessUnitsByAddressContains),
    },
    businessUnits: normalizeBusinessUnits(raw.businessUnits),
  };
}
