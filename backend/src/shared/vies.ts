export type ViesMatch = "VALID" | "INVALID" | "NOT_PROCESSED";
export type ViesVatLookupStatus = "VALID" | "INVALID" | "SKIPPED" | "ERROR";

export interface ViesVatLookupRequest {
  countryCode: string;
  vatNumber: string;
  traderName?: string;
  traderStreet?: string;
  traderPostalCode?: string;
  traderCity?: string;
  traderCompanyType?: string;
}

export interface ViesVatValidation {
  provider: "EU_VIES";
  status: ViesVatLookupStatus;
  checkedAt: string;
  normalizedVat?: string;
  input?: ViesVatLookupRequest;
  valid?: boolean;
  countryCode?: string;
  vatNumber?: string;
  requestDate?: string;
  requestIdentifier?: string;
  name?: string;
  address?: string;
  traderName?: string;
  traderStreet?: string;
  traderPostalCode?: string;
  traderCity?: string;
  traderCompanyType?: string;
  matches?: {
    traderName?: ViesMatch;
    traderStreet?: ViesMatch;
    traderPostalCode?: ViesMatch;
    traderCity?: ViesMatch;
    traderCompanyType?: ViesMatch;
  };
  message?: string;
}

export interface ViesLookupOptions {
  enabled?: boolean;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_VIES_BASE_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api";
const DEFAULT_TIMEOUT_MS = 6000;

const VIES_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "EL",
  "ES",
  "FI",
  "FR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
  "XI",
]);

const COUNTRY_ALIASES: Record<string, string> = {
  GR: "EL",
};

const COUNTRY_NAMES: Array<[RegExp, string]> = [
  [/\bAUSTRIA\b|\bOSTERREICH\b/, "AT"],
  [/\bBELGIUM\b|\bBELGIQUE\b|\bBELGIE\b/, "BE"],
  [/\bBULGARIA\b/, "BG"],
  [/\bCYPRUS\b/, "CY"],
  [/\bCZECH\b|\bCZECHIA\b/, "CZ"],
  [/\bGERMANY\b|\bDEUTSCHLAND\b/, "DE"],
  [/\bDENMARK\b|\bDANMARK\b/, "DK"],
  [/\bESTONIA\b/, "EE"],
  [/\bGREECE\b|\bHELLAS\b/, "EL"],
  [/\bSPAIN\b|\bESPANA\b/, "ES"],
  [/\bFINLAND\b/, "FI"],
  [/\bFRANCE\b/, "FR"],
  [/\bCROATIA\b/, "HR"],
  [/\bHUNGARY\b/, "HU"],
  [/\bIRELAND\b/, "IE"],
  [/\bITALY\b|\bITALIA\b/, "IT"],
  [/\bLITHUANIA\b/, "LT"],
  [/\bLUXEMBOURG\b/, "LU"],
  [/\bLATVIA\b/, "LV"],
  [/\bMALTA\b/, "MT"],
  [/\bNETHERLANDS\b|\bHOLLAND\b/, "NL"],
  [/\bPOLAND\b|\bPOLSKA\b/, "PL"],
  [/\bPORTUGAL\b/, "PT"],
  [/\bROMANIA\b/, "RO"],
  [/\bSWEDEN\b|\bSVERIGE\b/, "SE"],
  [/\bSLOVENIA\b/, "SI"],
  [/\bSLOVAKIA\b/, "SK"],
  [/\bNORTHERN\s+IRELAND\b/, "XI"],
];

const VAT_LABEL_PREFIX_RE =
  /^(?:VATID|VATNO|VATNUMBER|VAT|ID|NO|NUMBER|NR|USTIDNR|USTID|UID|TVA|IVA|BTW|NIP|MOMS|CVR|ORGNR|TAXID|TAXNO)+/;

export async function enrichExtractionWithVatLookup(
  extracted: any,
  warnings: string[],
  options: ViesLookupOptions = {}
): Promise<ViesVatValidation | undefined> {
  if (options.enabled === false) return undefined;
  if (!extracted || typeof extracted !== "object") return undefined;

  extracted.vendor = extracted.vendor ?? {};
  extracted.meta = extracted.meta ?? {};

  const result = await lookupVendorVatFromInvoice(extracted, options);
  if (!result) return undefined;

  extracted.vendor.vatValidation = result;
  extracted.meta.vendorVatValidation = {
    provider: result.provider,
    status: result.status,
    normalizedVat: result.normalizedVat,
    checkedAt: result.checkedAt,
    requestIdentifier: result.requestIdentifier,
  };

  if (result.status === "VALID") {
    if (!hasText(extracted.vendor.name) && hasText(result.name)) {
      extracted.vendor.name = result.name;
    }
    if (!hasText(extracted.vendor.address) && hasText(result.address)) {
      extracted.vendor.address = result.address;
    }
    pushMatchWarnings(result, warnings);
  } else if (result.status === "INVALID") {
    warnings.push(`vies_vat_invalid:${result.normalizedVat ?? result.input?.vatNumber ?? "unknown"}`);
  }

  return result;
}

export async function lookupVendorVatFromInvoice(
  extracted: any,
  options: ViesLookupOptions = {}
): Promise<ViesVatValidation | undefined> {
  const vendor = extracted?.vendor ?? {};
  const parsed = parseEuropeanVatNumber(vendor?.taxId, inferVatCountryCode(vendor?.address, vendor?.name));
  if (!parsed) {
    if (!hasText(vendor?.taxId)) return undefined;
    return {
      provider: "EU_VIES",
      status: "SKIPPED",
      checkedAt: new Date().toISOString(),
      message: "No European VAT number with a supported VIES country code was found on the vendor.",
    };
  }

  const address = parseTraderAddress(vendor?.address);
  const input: ViesVatLookupRequest = {
    countryCode: parsed.countryCode,
    vatNumber: parsed.vatNumber,
  };
  if (hasText(vendor?.name)) input.traderName = String(vendor.name).trim();
  if (address.traderStreet) input.traderStreet = address.traderStreet;
  if (address.traderPostalCode) input.traderPostalCode = address.traderPostalCode;
  if (address.traderCity) input.traderCity = address.traderCity;

  return checkVatNumber(input, options);
}

export async function checkVatNumber(
  input: ViesVatLookupRequest,
  options: ViesLookupOptions = {}
): Promise<ViesVatValidation> {
  const checkedAt = new Date().toISOString();
  const baseUrl = trimTrailingSlash(options.baseUrl || DEFAULT_VIES_BASE_URL);
  const url = `${baseUrl}/check-vat-number`;

  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(input),
      },
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );

    const bodyText = await res.text().catch(() => "");
    const body = bodyText ? safeJson(bodyText) : {};

    if (!res.ok) {
      return {
        provider: "EU_VIES",
        status: "ERROR",
        checkedAt,
        input,
        normalizedVat: `${input.countryCode}${input.vatNumber}`,
        message: extractViesError(body) || `VIES request failed with HTTP ${res.status}`,
      };
    }

    return mapViesResponse(input, body, checkedAt);
  } catch (err: any) {
    return {
      provider: "EU_VIES",
      status: "ERROR",
      checkedAt,
      input,
      normalizedVat: `${input.countryCode}${input.vatNumber}`,
      message: err?.name === "AbortError" ? "VIES request timed out" : err?.message ?? String(err),
    };
  }
}

export function parseEuropeanVatNumber(
  value: unknown,
  fallbackCountryCode?: string
): { countryCode: string; vatNumber: string } | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;

  const compact = raw
    .toUpperCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/g, "")
    .replace(VAT_LABEL_PREFIX_RE, "");

  for (const cc of [...VIES_COUNTRIES, "GR"]) {
    if (compact.startsWith(cc) && compact.length > cc.length) {
      const countryCode = normalizeViesCountryCode(cc);
      const vatNumber = compact.slice(cc.length);
      if (countryCode && isPlausibleVatNumber(vatNumber)) {
        return { countryCode, vatNumber };
      }
    }
  }

  const fallback = normalizeViesCountryCode(fallbackCountryCode);
  if (!fallback) return undefined;

  const vatNumber = compact.replace(/^[A-Z]{2}/, "");
  if (!isPlausibleVatNumber(vatNumber)) return undefined;
  return { countryCode: fallback, vatNumber };
}

export function inferVatCountryCode(...parts: unknown[]): string | undefined {
  const raw = parts.map((part) => String(part ?? "")).join(" ");
  const text = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

  for (const [pattern, code] of COUNTRY_NAMES) {
    if (pattern.test(text)) return code;
  }

  const countryCodeMatch = text.match(/\b(AT|BE|BG|CY|CZ|DE|DK|EE|EL|GR|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK|XI)\b/);
  return normalizeViesCountryCode(countryCodeMatch?.[1]);
}

function mapViesResponse(input: ViesVatLookupRequest, body: any, checkedAt: string): ViesVatValidation {
  const valid = Boolean(body?.valid);
  return {
    provider: "EU_VIES",
    status: valid ? "VALID" : "INVALID",
    checkedAt,
    input,
    normalizedVat: `${body?.countryCode ?? input.countryCode}${body?.vatNumber ?? input.vatNumber}`,
    valid,
    countryCode: stringOrUndefined(body?.countryCode),
    vatNumber: stringOrUndefined(body?.vatNumber),
    requestDate: stringOrUndefined(body?.requestDate),
    requestIdentifier: stringOrUndefined(body?.requestIdentifier),
    name: stringOrUndefined(body?.name),
    address: stringOrUndefined(body?.address),
    traderName: stringOrUndefined(body?.traderName),
    traderStreet: stringOrUndefined(body?.traderStreet),
    traderPostalCode: stringOrUndefined(body?.traderPostalCode),
    traderCity: stringOrUndefined(body?.traderCity),
    traderCompanyType: stringOrUndefined(body?.traderCompanyType),
    matches: {
      traderName: matchOrUndefined(body?.traderNameMatch),
      traderStreet: matchOrUndefined(body?.traderStreetMatch),
      traderPostalCode: matchOrUndefined(body?.traderPostalCodeMatch),
      traderCity: matchOrUndefined(body?.traderCityMatch),
      traderCompanyType: matchOrUndefined(body?.traderCompanyTypeMatch),
    },
  };
}

function pushMatchWarnings(result: ViesVatValidation, warnings: string[]) {
  const matches = result.matches ?? {};
  const mismatches = Object.entries(matches)
    .filter(([, value]) => value === "INVALID")
    .map(([key]) => key.replace(/^trader/, "").toLowerCase());
  if (mismatches.length === 0) return;
  warnings.push(`vies_vat_match_mismatch:${mismatches.join(",")}`);
}

function parseTraderAddress(value: unknown): Partial<ViesVatLookupRequest> {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return {};
  const parts = text.split(/[,|]/).map((part) => part.trim()).filter(Boolean);
  const street = parts[0];
  const postalCitySource = parts.find((part) => /\b[A-Z]{0,2}\s*\d{3,6}[A-Z]{0,3}\b/i.test(part)) ?? "";
  const postalCity = postalCitySource.match(/\b(?:[A-Z]{1,2}[-\s]?)?(\d{3,6}[A-Z]{0,3})\s+(.+?)\s*$/i);
  return {
    traderStreet: street,
    traderPostalCode: postalCity?.[1],
    traderCity: postalCity?.[2],
  };
}

function normalizeViesCountryCode(value: unknown): string | undefined {
  const cc = String(value ?? "").trim().toUpperCase();
  const normalized = COUNTRY_ALIASES[cc] ?? cc;
  return VIES_COUNTRIES.has(normalized) ? normalized : undefined;
}

function isPlausibleVatNumber(value: string): boolean {
  return /^[A-Z0-9]{2,14}$/.test(value);
}

function hasText(value: unknown): boolean {
  return String(value ?? "").trim().length > 0;
}

function stringOrUndefined(value: unknown): string | undefined {
  const s = String(value ?? "").trim();
  return s || undefined;
}

function matchOrUndefined(value: unknown): ViesMatch | undefined {
  return value === "VALID" || value === "INVALID" || value === "NOT_PROCESSED" ? value : undefined;
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function extractViesError(body: any): string | undefined {
  const wrappers = Array.isArray(body?.errorWrappers) ? body.errorWrappers : [];
  const message = wrappers.map((wrapper: any) => wrapper?.message || wrapper?.error).filter(Boolean).join("; ");
  return message || stringOrUndefined(body?.message);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
