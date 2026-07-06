import { exampleNetSuiteConfig, type NetSuiteConfig } from "./netsuite";

function blankToUndefined<T>(value: T): T | undefined {
  return value === "" || value === null ? undefined : value;
}

function normalizeCrosswalk(input: any): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => typeof value === "string" && value.trim() !== "")
  ) as Record<string, string>;
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
    },
  };
}
