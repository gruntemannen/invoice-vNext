/**
 * Model A/B evaluation harness (DEV TOOL — does NOT deploy anything).
 *
 * Runs every sample invoice in ./samples through each model in MODELS below,
 * using the SAME extraction prompt and parsing/confidence logic as the
 * production extractor (backend/src/extract.ts), then prints a side-by-side
 * comparison plus a per-model summary.
 *
 * REQUIREMENTS:
 *   - AWS credentials on the default chain (env, profile, or SSO) with
 *     bedrock:InvokeModel permission.
 *   - Bedrock MODEL ACCESS granted in the target region for every model in
 *     MODELS (Sonnet 4.6, Haiku 4.5, Nova 2 Lite). Missing access surfaces as a
 *     per-cell error, not a crash.
 *   - The region comes from the standard AWS env (AWS_REGION / AWS_DEFAULT_REGION).
 *     Make sure it matches the geo prefix below (default "eu." => an eu-* region).
 *
 * HOW TO RUN (from the backend/ directory):
 *   - ts-node lives in infra/, not backend/, so prefer:
 *       npx ts-node scripts/ab-eval.ts [samplesDir]
 *   - Or, after `npm i` adds ts-node somewhere on PATH:
 *       npm run ab-eval -- [samplesDir]
 *   - samplesDir defaults to ../samples (repo-root/samples), overridable as argv[2].
 *
 * ENV KNOBS:
 *   - AB_GEO_PREFIX   geo/cross-region inference prefix for model ids (default "eu.").
 *                     Set to "" to use bare model ids, or "us."/"apac." etc.
 *
 * This tool only READS files and CALLS Bedrock. It writes nothing and deploys nothing.
 */

import * as fs from "fs";
import * as path from "path";
import { performance } from "perf_hooks";

import { invokeBedrock, DocumentInput } from "../src/shared/bedrock";
import { buildExtractionPrompt } from "../src/shared/prompts";
import { calculateConfidence } from "../src/shared/confidence";

// ---------------------------------------------------------------------------
// Models to compare. EDIT THIS LIST to add/remove models.
// The geo prefix (default "eu.") is prepended to ids that need a cross-region
// inference profile. Override the prefix via AB_GEO_PREFIX (e.g. "us.", "").
// ---------------------------------------------------------------------------
const GEO = process.env.AB_GEO_PREFIX ?? "eu.";

type ModelSpec = { label: string; modelId: string; pricing: PricingNote };
type PricingNote = { inPerM: number; outPerM: number }; // USD per 1M tokens, rough guidance only

const MODELS: ModelSpec[] = [
  {
    label: "Sonnet 4.6",
    modelId: `${GEO}anthropic.claude-sonnet-4-6`,
    pricing: { inPerM: 3, outPerM: 15 },
  },
  {
    label: "Haiku 4.5",
    modelId: `${GEO}anthropic.claude-haiku-4-5-20251001-v1:0`,
    pricing: { inPerM: 1, outPerM: 5 },
  },
  {
    label: "Nova 2 Lite",
    modelId: `${GEO}amazon.nova-2-lite-v1:0`,
    pricing: { inPerM: 0.06, outPerM: 0.24 },
  },
];

// ---------------------------------------------------------------------------
// File discovery + document prep (media-type logic mirrors extract.ts).
// ---------------------------------------------------------------------------
const SUPPORTED_EXT = new Set([".pdf", ".png", ".jpg", ".jpeg"]);

function mediaTypeFor(file: string): DocumentInput["mediaType"] | null {
  const lower = file.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return null;
}

function buildDocument(file: string, bytes: Buffer): DocumentInput | null {
  const mediaType = mediaTypeFor(file);
  if (!mediaType) return null;
  return { mediaType, data: bytes.toString("base64") };
}

// Nova models cannot read PDFs (see buildRequestBody in bedrock.ts — PDFs are
// filtered out for Nova). Flag this so an empty result is explained, not silent.
function modelCannotReadDoc(modelId: string, doc: DocumentInput): boolean {
  const isNova = modelId.includes("nova");
  return isNova && doc.mediaType === "application/pdf";
}

// ---------------------------------------------------------------------------
// JSON parsing — local copy of extract.ts#parseJsonResponse (not exported there).
// Kept identical so confidence scores are comparable to production.
// ---------------------------------------------------------------------------
function parseJsonResponse(text: string | undefined): any {
  if (!text) return null;
  let cleaned = text.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1];
  }

  const startIdx = cleaned.indexOf("{");
  const endIdx = cleaned.lastIndexOf("}");
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  const jsonStr = cleaned.slice(startIdx, endIdx + 1);
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-cell result type.
// ---------------------------------------------------------------------------
type CellResult = {
  label: string;
  modelId: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
  confidence?: number;
  vendorName?: string | null;
  invoiceNumber?: string | null;
  currency?: string | null;
  totalAmount?: number | null;
};

async function runCell(model: ModelSpec, doc: DocumentInput): Promise<CellResult> {
  const base: CellResult = { label: model.label, modelId: model.modelId, ok: false, latencyMs: 0 };

  if (modelCannotReadDoc(model.modelId, doc)) {
    return {
      ...base,
      error: "skipped: Nova cannot read PDFs (convert to PNG/JPG to compare on this file)",
    };
  }

  const prompt = buildExtractionPrompt("", true);
  const start = performance.now();
  try {
    const response = await invokeBedrock(model.modelId, prompt, [doc]);
    const latencyMs = performance.now() - start;

    const extracted = parseJsonResponse(response.text);
    if (!extracted) {
      return { ...base, latencyMs, error: "parse failed: response was not valid JSON" };
    }

    const confidence = calculateConfidence(extracted);
    return {
      ...base,
      ok: true,
      latencyMs,
      confidence,
      vendorName: extracted?.vendor?.name ?? null,
      invoiceNumber: extracted?.invoice?.invoiceNumber ?? null,
      currency: extracted?.invoice?.currency ?? null,
      totalAmount: typeof extracted?.invoice?.totalAmount === "number" ? extracted.invoice.totalAmount : null,
    };
  } catch (err: any) {
    const latencyMs = performance.now() - start;
    return { ...base, latencyMs, error: err?.message ? String(err.message) : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers.
// ---------------------------------------------------------------------------
function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtConf(c: number | undefined): string {
  return typeof c === "number" ? `${(c * 100).toFixed(0)}%` : "-";
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(0)}ms`;
}

function norm(v: string | null | undefined): string {
  return String(v ?? "").trim().toLowerCase();
}

// Disagreement: among the cells that succeeded, do they differ on this field?
function disagree(values: Array<string | number | null | undefined>): boolean {
  const seen = new Set<string>();
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    seen.add(typeof v === "number" ? String(v) : norm(String(v)));
  }
  return seen.size > 1;
}

function printInvoiceComparison(file: string, cells: CellResult[]): void {
  console.log("");
  console.log("=".repeat(110));
  console.log(`INVOICE: ${file}`);
  console.log("=".repeat(110));

  const colW = 22;
  const labelW = 16;

  const header = pad("field", labelW) + cells.map((c) => "| " + pad(c.label, colW)).join("");
  console.log(header);
  console.log("-".repeat(header.length));

  const rows: Array<{ name: string; get: (c: CellResult) => string }> = [
    { name: "vendor.name", get: (c) => (c.ok ? String(c.vendorName ?? "-") : "(no result)") },
    { name: "invoiceNumber", get: (c) => (c.ok ? String(c.invoiceNumber ?? "-") : "(no result)") },
    { name: "currency", get: (c) => (c.ok ? String(c.currency ?? "-") : "-") },
    { name: "totalAmount", get: (c) => (c.ok ? fmtNum(c.totalAmount) : "-") },
    { name: "confidence", get: (c) => (c.ok ? fmtConf(c.confidence) : "-") },
    { name: "latency", get: (c) => fmtMs(c.latencyMs) },
  ];

  for (const row of rows) {
    const line = pad(row.name, labelW) + cells.map((c) => "| " + pad(row.get(c), colW)).join("");
    console.log(line);
  }

  // Errors / skips, if any.
  const problems = cells.filter((c) => !c.ok);
  if (problems.length) {
    console.log("-".repeat(header.length));
    for (const c of problems) {
      console.log(`  ! ${pad(c.label, 12)} ${c.error ?? "unknown error"}`);
    }
  }

  // Disagreement flags (only meaningful when >=2 models produced a result).
  const okCells = cells.filter((c) => c.ok);
  if (okCells.length >= 2) {
    const vendorDisagree = disagree(okCells.map((c) => c.vendorName ?? null));
    const totalDisagree = disagree(okCells.map((c) => c.totalAmount ?? null));
    if (vendorDisagree || totalDisagree) {
      console.log("-".repeat(header.length));
      if (vendorDisagree) console.log("  ** DISAGREEMENT on vendor.name");
      if (totalDisagree) console.log("  ** DISAGREEMENT on invoice.totalAmount");
    } else {
      console.log("-".repeat(header.length));
      console.log("  (models agree on vendor + total)");
    }
  }
}

type ModelAgg = {
  label: string;
  modelId: string;
  pricing: PricingNote;
  attempts: number;
  successes: number;
  confSum: number;
  latencySum: number;
  latencyCount: number;
};

function printSummary(aggs: ModelAgg[]): void {
  console.log("");
  console.log("#".repeat(110));
  console.log("SUMMARY (per model)");
  console.log("#".repeat(110));

  const cols = [
    pad("model", 14),
    pad("success", 12),
    pad("avg conf", 10),
    pad("avg latency", 14),
    pad("cost (in/out $/M)", 18),
  ].join("| ");
  console.log(cols);
  console.log("-".repeat(cols.length));

  for (const a of aggs) {
    const avgConf = a.successes > 0 ? a.confSum / a.successes : 0;
    const avgLatency = a.latencyCount > 0 ? a.latencySum / a.latencyCount : 0;
    const row = [
      pad(a.label, 14),
      pad(`${a.successes}/${a.attempts}`, 12),
      pad(a.successes > 0 ? fmtConf(avgConf) : "-", 10),
      pad(a.latencyCount > 0 ? fmtMs(avgLatency) : "-", 14),
      pad(`$${a.pricing.inPerM}/$${a.pricing.outPerM}`, 18),
    ].join("| ");
    console.log(row);
  }

  console.log("-".repeat(cols.length));
  console.log("Cost is per 1M tokens (input/output), rough relative guidance only — this run");
  console.log("does not meter actual token usage. Latency is wall-clock per Bedrock call.");
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Default samples dir is <repo-root>/samples. This script lives at
  // backend/scripts/, so the repo root is two levels up.
  const repoRoot = path.resolve(__dirname, "..", "..");
  const defaultSamplesDir = path.join(repoRoot, "samples");
  const samplesDir = process.argv[2] ? path.resolve(process.argv[2]) : defaultSamplesDir;

  const instructions =
    `No samples found in: ${samplesDir}\n\n` +
    `Drop representative invoices — including scanned, Japanese/multilingual, and\n` +
    `dense multi-table ones — into ${samplesDir} (or pass a directory as argv[2]).\n` +
    `Supported file types: .pdf, .png, .jpg, .jpeg.\n\n` +
    `Then run:  npx ts-node scripts/ab-eval.ts [samplesDir]\n`;

  if (!fs.existsSync(samplesDir) || !fs.statSync(samplesDir).isDirectory()) {
    console.log(instructions);
    process.exit(0);
  }

  const files = fs
    .readdirSync(samplesDir)
    .filter((f) => SUPPORTED_EXT.has(path.extname(f).toLowerCase()))
    .sort();

  if (files.length === 0) {
    console.log(instructions);
    process.exit(0);
  }

  console.log(`Models under test (geo prefix "${GEO}"):`);
  for (const m of MODELS) console.log(`  - ${pad(m.label, 14)} ${m.modelId}`);
  console.log(`\nSamples dir: ${samplesDir}`);
  console.log(`Files: ${files.length}`);

  const aggs: ModelAgg[] = MODELS.map((m) => ({
    label: m.label,
    modelId: m.modelId,
    pricing: m.pricing,
    attempts: 0,
    successes: 0,
    confSum: 0,
    latencySum: 0,
    latencyCount: 0,
  }));
  const aggByLabel = new Map(aggs.map((a) => [a.label, a]));

  for (const file of files) {
    const fullPath = path.join(samplesDir, file);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(fullPath);
    } catch (err: any) {
      console.log(`\n! Could not read ${file}: ${err?.message ?? String(err)}`);
      continue;
    }

    const doc = buildDocument(file, bytes);
    if (!doc) {
      console.log(`\n! Skipping ${file}: unsupported file type`);
      continue;
    }

    // Run models sequentially to keep output readable and avoid throttling.
    const cells: CellResult[] = [];
    for (const model of MODELS) {
      const cell = await runCell(model, doc);
      cells.push(cell);

      const agg = aggByLabel.get(model.label)!;
      // Count latency for any cell that actually called Bedrock (ok or runtime error),
      // but not for the deterministic Nova-PDF skip (latencyMs stays 0).
      if (cell.latencyMs > 0) {
        agg.latencySum += cell.latencyMs;
        agg.latencyCount += 1;
      }
      // "skipped" cells don't count as an attempt against the model.
      const wasSkipped = !cell.ok && cell.latencyMs === 0;
      if (!wasSkipped) {
        agg.attempts += 1;
        if (cell.ok) {
          agg.successes += 1;
          if (typeof cell.confidence === "number") agg.confSum += cell.confidence;
        }
      }
    }

    printInvoiceComparison(file, cells);
  }

  printSummary(aggs);
}

main().catch((err) => {
  console.error("ab-eval failed:", err?.message ?? err);
  process.exit(1);
});
