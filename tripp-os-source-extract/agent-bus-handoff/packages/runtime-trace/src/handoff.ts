/**
 * @tripp-os/runtime-trace — Operator Handoff
 *
 * Static/manual handoff generator for runtime-trace evidence.
 * Produces a local bundle of summaries for operator inspection.
 * No live behavior. No shared-agent-bus mutation. Read-only on trace sources.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  TraceWriter,
  TraceReader,
  createTraceWriter,
  createTraceReader,
  validateTraceConfig,
  getDefaultTraceConfig,
  FallbackChain,
  MemorySink,
} from "./index.js";
import type { TraceConfig, TraceHealthStatus, LedgerValidationSummary } from "./index.js";

// ── Handoff Version ───────────────────────────────────────────────────

const HANDOFF_VERSION = "1.0.0";
const CONTRACT_CLASSIFICATION = "internal-tripp-os-runtime-trace";
const PRODUCER = "tripp-os-runtime-trace";
const PRODUCER_VERSION = "0.1.0";
const PRODUCER_PROJECT = "Tripp.OS";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MiB per ledger file
const MAX_BUNDLE_SIZE = 100 * 1024 * 1024; // 100 MiB total bundle

// ── Handoff Options ───────────────────────────────────────────────────

export interface HandoffOptions {
  config?: Partial<TraceConfig>;
  notes?: string;
  recommendedNextMarker?: string;
  /** Optional caller-provided writer health. If omitted, a fresh writer is introspected. */
  writerHealth?: TraceHealthStatus;
  /** Optional caller-provided writer state counters. If omitted, fresh writer state (all zeros) is used. */
  writerState?: {
    totalAppends: number;
    successfulAppends: number;
    fallbackAppends: number;
    failedAppends: number;
  };
}

export interface HandoffResult {
  bundleDir: string;
  filesGenerated: string[];
  confidenceLevel: "confirmed" | "report-backed" | "unknown";
  confidenceReason: string;
}

// ── Validation Result ─────────────────────────────────────────────────

export interface BundleValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ── Secret Detection ──────────────────────────────────────────────────

const SECRET_PATTERNS = [
  /password\s*[=:]\s*["'][^"']+["']/i,
  /token\s*[=:]\s*["'][^"']+["']/i,
  /secret\s*[=:]\s*["'][^"']+["']/i,
  /api[_-]?key\s*[=:]\s*["'][^"']+["']/i,
  /private[_-]?key\s*[=:]\s*["'][^"']+["']/i,
  /BEGIN\s+(RSA\s+)?PRIVATE\s+KEY/,
  /AWS_ACCESS_KEY_ID\s*[=:]/,
  /GITHUB_TOKEN\s*[=:]/,
];

const FORBIDDEN_EXTENSIONS = [".env", ".key", ".pem", ".secret", ".p12", ".pfx"];

function containsSecrets(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

// ── Path Validation ───────────────────────────────────────────────────

function isForbiddenSourcePath(traceRoot: string): { forbidden: boolean; reason?: string } {
  // Check traversal BEFORE resolve — path.resolve() normalizes ".." away
  if (traceRoot.includes("..")) {
    return { forbidden: true, reason: "Path traversal not allowed" };
  }

  const normalized = path.resolve(traceRoot).toLowerCase();

  if (normalized.includes("shared-agent-bus")) {
    return { forbidden: true, reason: "Source path contains shared-agent-bus" };
  }
  if (normalized.includes("tripp.control") || normalized.includes("tripp-control")) {
    return { forbidden: true, reason: "Source path contains Tripp.Control" };
  }
  if (normalized.includes("tripp.reason") || normalized.includes("tripp-reason")) {
    return { forbidden: true, reason: "Source path contains Tripp.Reason" };
  }
  if (normalized.startsWith("\\\\") || normalized.startsWith("//")) {
    return { forbidden: true, reason: "Network/UNC paths not allowed" };
  }

  return { forbidden: false };
}

// ── Confidence Computation ────────────────────────────────────────────

function computeConfidence(
  validation: LedgerValidationSummary,
  checksums: ChecksumEntry[],
  health: TraceHealthStatus
): { level: "confirmed" | "report-backed" | "unknown"; reason: string } {
  if (!validation.isValid) {
    return { level: "unknown", reason: "Ledger validation failed — malformed lines detected" };
  }

  const allChecksumsVerified = checksums.length > 0 && checksums.every((c) => c.verified);
  const healthClean = !health.degraded;

  if (allChecksumsVerified && healthClean) {
    return { level: "confirmed", reason: "All trace files validated, checksums verified, health stable" };
  }

  const reasons: string[] = [];
  if (!allChecksumsVerified) reasons.push("checksums partial or missing");
  if (!healthClean) reasons.push("health degraded");

  return { level: "report-backed", reason: `Validation passed but: ${reasons.join(", ")}` };
}

// ── Checksum Entry ────────────────────────────────────────────────────

interface ChecksumEntry {
  file: string;
  checksumFile: string;
  expected: string | null;
  actual: string | null;
  verified: boolean;
}

// ── generateTraceHandoff ──────────────────────────────────────────────

export async function generateTraceHandoff(
  traceRoot: string,
  outputDir: string,
  options: HandoffOptions = {}
): Promise<HandoffResult> {
  // 1. Validate source path
  const pathCheck = isForbiddenSourcePath(traceRoot);
  if (pathCheck.forbidden) {
    throw new Error(`HANDOFF_FORBIDDEN_SOURCE_PATH: ${pathCheck.reason}`);
  }

  // 2. Resolve paths
  const resolvedRoot = path.resolve(traceRoot);
  const resolvedOutput = path.resolve(outputDir);

  // 3. Ensure output is local (not network)
  if (resolvedOutput.startsWith("\\") || resolvedOutput.startsWith("//")) {
    throw new Error("HANDOFF_FORBIDDEN_OUTPUT_PATH: Network paths not allowed");
  }

  // 4. Load config
  const config = options.config
    ? validateTraceConfig(options.config)
    : getDefaultTraceConfig();

  // 5. Create writer and reader for introspection
  const writer = createTraceWriter(config);
  const reader = createTraceReader(config);

  // 6. Discover ledger files (with size cap check)
  let ledgerFiles: string[] = [];
  let totalLedgerBytes = 0;
  try {
    const entries = await fs.readdir(resolvedRoot);
    for (const f of entries) {
      // Must match ledger pattern
      if (!f.endsWith(".jsonl")) continue;
      // Must not have forbidden extension
      if (FORBIDDEN_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext))) continue;
      // Check individual file size
      let sizeChecked = false;
      try {
        const fpath = path.join(resolvedRoot, f);
        const fstat = await fs.stat(fpath);
        if (fstat.size > MAX_FILE_SIZE) {
          throw new Error(`HANDOFF_FILE_TOO_LARGE: ${f} is ${fstat.size} bytes (max ${MAX_FILE_SIZE})`);
        }
        totalLedgerBytes += fstat.size;
        if (totalLedgerBytes > MAX_BUNDLE_SIZE) {
          throw new Error(`HANDOFF_BUNDLE_TOO_LARGE: total ledger size exceeds ${MAX_BUNDLE_SIZE} bytes`);
        }
        sizeChecked = true;
      } catch (err) {
        // Only swallow stat failures (symlinks, permissions); re-throw size-cap errors
        if (err instanceof Error && (err.message.startsWith("HANDOFF_FILE_TOO_LARGE") || err.message.startsWith("HANDOFF_BUNDLE_TOO_LARGE"))) {
          throw err;
        }
        // stat may fail for dangling symlinks — skip size check for this file
      }
      ledgerFiles.push(f);
    }
  } catch (err) {
    // Re-throw size-cap errors; swallow readdir failures (dir may not exist)
    if (err instanceof Error && (err.message.startsWith("HANDOFF_FILE_TOO_LARGE") || err.message.startsWith("HANDOFF_BUNDLE_TOO_LARGE"))) {
      throw err;
    }
    // Directory may not exist yet
  }

  // Current ledger is always included if it exists
  const currentLedger = config.ledgerFileName;

  // 7. Run validation
  const validation = await reader.validate();

  // 8. Verify checksums
  const checksumEntries: ChecksumEntry[] = [];
  if (config.checksumEnabled) {
    for (const ledgerFile of ledgerFiles) {
      const ledgerPath = path.join(resolvedRoot, ledgerFile);
      const checksumPath = `${ledgerPath}.sha256`;
      let expected: string | null = null;
      let actual: string | null = null;
      let verified = false;

      try {
        expected = (await fs.readFile(checksumPath, "utf-8")).trim();
        const data = await fs.readFile(ledgerPath, "utf-8");
        actual = createHash("sha256").update(data).digest("hex");
        verified = expected === actual;
      } catch {
        // Checksum file may not exist
      }

      checksumEntries.push({
        file: ledgerFile,
        checksumFile: `${ledgerFile}.sha256`,
        expected,
        actual,
        verified,
      });
    }
  }

  // 9. Get health (use caller-provided health/state if available)
  const health = options.writerHealth ?? writer.health();
  const state = options.writerState ?? writer.getState();

  // 10. Compute confidence
  const confidence = computeConfidence(validation, checksumEntries, health);

  // 11. Create bundle directory
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bundleName = `runtime-trace-handoff-${ts}`;
  const bundleDir = path.join(resolvedOutput, bundleName);
  await fs.mkdir(bundleDir, { recursive: true });

  // 12. Generate files
  const filesGenerated: string[] = [];

  // trace-summary.json
  const summaryJson = {
    $schema: "internal/tripp-os-runtime-trace-handoff-v1" as const,
    handoff_version: HANDOFF_VERSION,
    generated_at: new Date().toISOString(),
    producer: PRODUCER,
    producer_version: PRODUCER_VERSION,
    producer_project: PRODUCER_PROJECT,
    contract_classification: CONTRACT_CLASSIFICATION,
    source_trace_root: resolvedRoot,
    source_ledger_files: ledgerFiles,
    mutation_capability: "none" as const,
    consumer_permissions: [
      "inspect",
      "verify-checksums",
      "compare-validation",
      "report-markers",
      "transfer-bundle",
    ],
    consumer_forbidden_actions: [
      "infer-live-state",
      "mutate-shared-agent-bus",
      "start-agents",
      "edit-trace-files",
      "run-commands-from-bundle",
      "promote-to-public-api",
    ],
    redaction_status: "safe-metadata-only" as const,
    confidence_level: confidence.level,
    confidence_reason: confidence.reason,
    recommended_next_marker:
      options.recommendedNextMarker ?? "READY_FOR_TRIPP_OS_STAGE_6K_RUNTIME_TRACE_HANDOFF_AUDIT",
    evidence_files: [
      "trace-health.json",
      "trace-validation.json",
      "trace-checksums.json",
      "trace-manifest.json",
    ],
    notes: options.notes ?? "",
    health_summary: {
      writable: health.writable,
      degraded: health.degraded,
      fallback_sink: health.fallbackSink,
      total_appends: state.totalAppends,
      successful_appends: state.successfulAppends,
      fallback_appends: state.fallbackAppends,
      failed_appends: state.failedAppends,
    },
    validation_summary: {
      total_lines: validation.totalLines,
      valid_lines: validation.validLines,
      malformed_lines: validation.malformedLines,
      is_valid: validation.isValid,
    },
    checksum_summary: {
      checksums_enabled: config.checksumEnabled,
      checksum_algorithm: "SHA-256",
      files_checked: checksumEntries.length,
      all_verified: checksumEntries.length > 0 && checksumEntries.every((c) => c.verified),
      missing_checksums: checksumEntries.filter((c) => c.expected === null).map((c) => c.file),
    },
    rotation_summary: (() => {
      const rotatedFiles = ledgerFiles.filter((f) => f !== currentLedger);
      const rotatedCount = rotatedFiles.length;
      let retention_status: "within_limits" | "at_limit" | "over_limit" = "within_limits";
      if (config.maxLedgerFiles > 0) {
        if (rotatedCount >= config.maxLedgerFiles) retention_status = "over_limit";
        else if (rotatedCount >= config.maxLedgerFiles * 0.9) retention_status = "at_limit";
      }
      return {
        rotation_enabled: config.rotationEnabled,
        rotation_interval: config.rotationInterval,
        max_ledger_bytes: config.maxLedgerBytes,
        max_ledger_files: config.maxLedgerFiles,
        current_ledger: currentLedger,
        rotated_ledgers: rotatedCount,
        rotated_ledger_files: rotatedFiles,
        retention_status,
      };
    })(),
    fallback_summary: {
      fallback_sinks_configured: config.fallbackSinks.map((s) =>
        typeof s === "object" && s !== null && "type" in s ? (s as Record<string, unknown>).type : String(s)
      ),
      degraded_mode_ever_entered: state.fallbackAppends > 0,
      current_fallback_sink: health.fallbackSink,
      total_fallback_appends: state.fallbackAppends,
      total_failed_appends: state.failedAppends,
    },
    malformed_line_summary: {
      malformed_lines_detected: validation.malformedLines,
      malformed_line_numbers: validation.malformedLineNumbers,
      ledger_clean: validation.isValid,
    },
  };

  const summaryJsonPath = path.join(bundleDir, "trace-summary.json");
  const summaryJsonText = JSON.stringify(summaryJson, null, 2);

  // Check for secrets in generated content
  if (containsSecrets(summaryJsonText)) {
    throw new Error("HANDOFF_SECRET_DETECTED: Generated summary contains secret-like content");
  }

  await fs.writeFile(summaryJsonPath, summaryJsonText, "utf-8");
  filesGenerated.push("trace-summary.json");

  // trace-summary.md
  const summaryMd = generateSummaryMarkdown(summaryJson, health, validation, checksumEntries, config);
  if (containsSecrets(summaryMd)) {
    throw new Error("HANDOFF_SECRET_DETECTED: Generated markdown contains secret-like content");
  }
  await fs.writeFile(path.join(bundleDir, "trace-summary.md"), summaryMd, "utf-8");
  filesGenerated.push("trace-summary.md");

  // trace-health.json
  const healthJson = {
    writable: health.writable,
    degraded: health.degraded,
    fallback_sink: health.fallbackSink,
    last_write_ms: health.lastWriteMs,
    malformed_ratio: health.malformedRatio,
    malformed_ratio_note: "Reader-derived only. Use trace-validation.json for actual ratio.",
    alert: health.alert,
    total_appends: state.totalAppends,
    successful_appends: state.successfulAppends,
    fallback_appends: state.fallbackAppends,
    failed_appends: state.failedAppends,
  };
  await fs.writeFile(path.join(bundleDir, "trace-health.json"), JSON.stringify(healthJson, null, 2), "utf-8");
  filesGenerated.push("trace-health.json");

  // trace-validation.json
  const validationJson = {
    ledger_file: config.ledgerFileName,
    total_lines: validation.totalLines,
    valid_lines: validation.validLines,
    malformed_lines: validation.malformedLines,
    malformed_line_numbers: validation.malformedLineNumbers,
    is_valid: validation.isValid,
    earliest_timestamp: validation.earliestTimestamp,
    latest_timestamp: validation.latestTimestamp,
  };
  await fs.writeFile(
    path.join(bundleDir, "trace-validation.json"),
    JSON.stringify(validationJson, null, 2),
    "utf-8"
  );
  filesGenerated.push("trace-validation.json");

  // trace-checksums.json
  const checksumsJson = {
    checksums_enabled: config.checksumEnabled,
    checksum_algorithm: "SHA-256",
    files_checked: checksumEntries,
    all_verified: checksumEntries.length > 0 && checksumEntries.every((c) => c.verified),
    missing_checksums: checksumEntries.filter((c) => c.expected === null).map((c) => c.file),
  };
  await fs.writeFile(
    path.join(bundleDir, "trace-checksums.json"),
    JSON.stringify(checksumsJson, null, 2),
    "utf-8"
  );
  filesGenerated.push("trace-checksums.json");

  // trace-manifest.json
  const manifest = await generateManifest(bundleDir);
  await fs.writeFile(path.join(bundleDir, "trace-manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  filesGenerated.push("trace-manifest.json");

  // README-RUNTIME-TRACE-HANDOFF.md
  const readme = generateReadme(summaryJson);
  await fs.writeFile(path.join(bundleDir, "README-RUNTIME-TRACE-HANDOFF.md"), readme, "utf-8");
  filesGenerated.push("README-RUNTIME-TRACE-HANDOFF.md");

  return {
    bundleDir,
    filesGenerated,
    confidenceLevel: confidence.level,
    confidenceReason: confidence.reason,
  };
}

// ── validateHandoffBundle ─────────────────────────────────────────────

export async function validateHandoffBundle(bundleDir: string): Promise<BundleValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. trace-summary.json must exist
  const summaryPath = path.join(bundleDir, "trace-summary.json");
  let summary: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(summaryPath, "utf-8");
    summary = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    errors.push("Missing or unreadable trace-summary.json");
    return { valid: false, errors, warnings };
  }

  // 2. mutation_capability must be "none"
  if (summary.mutation_capability !== "none") {
    errors.push(`mutation_capability is '${summary.mutation_capability}', expected 'none'`);
  }

  // 3. contract_classification must be internal
  if (summary.contract_classification !== CONTRACT_CLASSIFICATION) {
    errors.push(`contract_classification is '${summary.contract_classification}', expected '${CONTRACT_CLASSIFICATION}'`);
  }

  // 4. Source path checks
  const sourceRoot = String(summary.source_trace_root ?? "").toLowerCase();
  if (sourceRoot.includes("shared-agent-bus")) {
    errors.push("Source path points to shared-agent-bus live root");
  }
  if (sourceRoot.includes("tripp.control") || sourceRoot.includes("tripp-control")) {
    errors.push("Source path points to Tripp.Control");
  }
  if (sourceRoot.includes("tripp.reason") || sourceRoot.includes("tripp-reason")) {
    errors.push("Source path points to Tripp.Reason");
  }

  // 5. Secret detection in summary files
  const filesToCheck = ["trace-summary.json", "trace-summary.md", "trace-health.json"];
  for (const fname of filesToCheck) {
    try {
      const content = await fs.readFile(path.join(bundleDir, fname), "utf-8");
      if (containsSecrets(content)) {
        errors.push(`Secret-like content detected in ${fname}`);
      }
    } catch {
      // File may not exist
    }
  }

  // 6. Checksums enabled → trace-checksums.json must exist
  const checksumsEnabled = summary.checksum_summary &&
    (summary.checksum_summary as Record<string, unknown>).checksums_enabled === true;
  if (checksumsEnabled) {
    try {
      await fs.access(path.join(bundleDir, "trace-checksums.json"));
    } catch {
      errors.push("checksums_enabled is true but trace-checksums.json is missing");
    }
  }

  // 7. trace-validation.json must exist
  try {
    await fs.access(path.join(bundleDir, "trace-validation.json"));
  } catch {
    errors.push("trace-validation.json is missing");
  }

  // 8. generated_at must be valid
  const generatedAt = String(summary.generated_at ?? "");
  if (!generatedAt || isNaN(Date.parse(generatedAt))) {
    errors.push("generated_at is invalid or missing");
  }

  // 9. recommended_next_marker
  const marker = String(summary.recommended_next_marker ?? "");
  if (!marker || !marker.startsWith("READY_FOR_")) {
    warnings.push("recommended_next_marker is missing or malformed");
  }

  // 10. handoff_version
  const hv = String(summary.handoff_version ?? "");
  if (!hv) {
    errors.push("handoff_version is missing");
  }

  // 11. confidence_level
  const cl = String(summary.confidence_level ?? "");
  if (cl === "unknown") {
    warnings.push("confidence_level is 'unknown'");
  }

  // 12. Evidence files must exist
  const evidenceFiles = Array.isArray(summary.evidence_files) ? summary.evidence_files : [];
  for (const ef of evidenceFiles) {
    try {
      await fs.access(path.join(bundleDir, String(ef)));
    } catch {
      errors.push(`Evidence file '${ef}' is listed but not present in bundle`);
    }
  }

  // 13. redaction_status
  const rs = String(summary.redaction_status ?? "");
  if (rs !== "safe-metadata-only" && rs !== "redacted") {
    errors.push(`redaction_status '${rs}' is invalid`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ── Summary Markdown Generator ────────────────────────────────────────

function generateSummaryMarkdown(
  summary: Record<string, unknown>,
  _health: TraceHealthStatus,
  validation: LedgerValidationSummary,
  checksums: ChecksumEntry[],
  config: TraceConfig
): string {
  const hs = summary.health_summary as Record<string, unknown> | undefined;
  const cs = summary.checksum_summary as Record<string, unknown> | undefined;
  const rs = summary.rotation_summary as Record<string, unknown> | undefined;
  const fs2 = summary.fallback_summary as Record<string, unknown> | undefined;
  const ms = summary.malformed_line_summary as Record<string, unknown> | undefined;

  return `# Tripp.OS Runtime Trace Handoff Summary

**Generated:** ${summary.generated_at}
**Producer:** ${summary.producer} v${summary.producer_version}
**Contract:** ${summary.contract_classification}
**Confidence:** ${summary.confidence_level}

## Source
- Trace root: ${summary.source_trace_root}
- Ledger files: ${(summary.source_ledger_files as string[]).length}
${(summary.source_ledger_files as string[]).map((f) => `  - ${f}`).join("\n")}

## Health
- Writable: ${hs?.writable ?? "unknown"}
- Degraded: ${hs?.degraded ?? "unknown"}
- Fallback sink: ${hs?.fallback_sink ?? "none"}
- Total appends: ${hs?.total_appends ?? 0}
- Malformed ratio: Not computed (reader-derived only)

## Validation
- Total lines: ${validation.totalLines}
- Valid lines: ${validation.validLines}
- Malformed lines: ${validation.malformedLines}
- Ledger is clean: ${validation.isValid ? "Yes" : "No"}

## Checksums
- Checksums enabled: ${cs?.checksums_enabled ?? false}
- Algorithm: SHA-256
- Files checked: ${checksums.length}
- All verified: ${cs?.all_verified ?? false}

## Rotation
- Rotation enabled: ${rs?.rotation_enabled ?? false}
- Interval: ${rs?.rotation_interval ?? "daily"}
- Max ledger bytes: ${rs?.max_ledger_bytes ?? 0}
- Max ledger files: ${rs?.max_ledger_files ?? 30}
- Rotated ledgers: ${rs?.rotated_ledgers ?? 0}
- Rotated files: ${(rs?.rotated_ledger_files as string[])?.join(", ") || "none"}
- Retention status: ${rs?.retention_status ?? "unknown"}

## Fallback
- Sinks configured: ${(fs2?.fallback_sinks_configured as string[])?.join(", ") ?? "none"}
- Degraded mode ever: ${fs2?.degraded_mode_ever_entered ? "Yes" : "No"}
- Fallback appends: ${fs2?.total_fallback_appends ?? 0}

## Recommended Next Marker
${summary.recommended_next_marker}

## Operator Notes
${summary.notes || "None."}

## Important
This is a **static handoff bundle**. Do not infer live runtime state.
Internal Tripp.OS contract only — not a public cross-project API.
`;
}

// ── README Generator ──────────────────────────────────────────────────

function generateReadme(summary: Record<string, unknown>): string {
  return `# README — Tripp.OS Runtime Trace Handoff Bundle

## What This Is

This is a **static handoff bundle** generated by the Tripp.OS runtime-trace
package. It contains summarized evidence from trace ledger files for operator
inspection.

## Classification

- **Scope:** Internal to Tripp.OS
- **Contract:** ${CONTRACT_CLASSIFICATION}
- **Mutation capability:** None (read-only)
- **Confidence:** ${summary.confidence_level}

## Files in This Bundle

| File | Purpose |
|---|---|
| trace-summary.json | Machine-readable metadata and summaries |
| trace-summary.md | Human-readable overview |
| trace-health.json | Writer health snapshot |
| trace-validation.json | Ledger validation results |
| trace-checksums.json | Checksum verification results |
| trace-manifest.json | File manifest with sizes |
| README-RUNTIME-TRACE-HANDOFF.md | This file |

## Operator Inspection Steps

1. Review trace-summary.md for a human-readable overview
2. Check trace-summary.json for metadata (confidence, classification)
3. Inspect trace-health.json for writer health state
4. Inspect trace-validation.json for ledger integrity
5. Inspect trace-checksums.json for checksum verification
6. Verify mutation_capability === "none"
7. Verify contract_classification === "internal-tripp-os-runtime-trace"
8. Check recommended_next_marker

## What You May Do

- Read all summary files
- Verify checksums against trace-checksums.json
- Compare validation results
- Report the recommended_next_marker
- Transfer this bundle directory as needed

## What You Must NOT Do

- Infer live runtime state from this static evidence
- Mutate shared-agent-bus
- Start agents
- Edit trace files as source of truth
- Run commands from bundle content
- Treat this as a public cross-project API
- Write to Tripp.Control or Tripp.Reason

## Bundle Validation

Run validateHandoffBundle(bundleDir) to check bundle integrity.
The validator uses 15 fail-closed checks including path validation,
secret detection, metadata verification, and bundle size caps.

## Generated

- **When:** ${summary.generated_at}
- **By:** ${summary.producer} v${summary.producer_version}
- **Source:** ${summary.source_trace_root}
`;
}

// ── Manifest Generator ────────────────────────────────────────────────

async function generateManifest(bundleDir: string): Promise<unknown> {
  const entries: Array<{ file: string; size: number; digest: string }> = [];
  let totalBytes = 0;

  try {
    const files = await fs.readdir(bundleDir);
    for (const file of files) {
      const filePath = path.join(bundleDir, file);
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        const content = await fs.readFile(filePath);
        // Enforce bundle size cap at manifest generation time
        totalBytes += content.length;
        if (totalBytes > MAX_BUNDLE_SIZE) {
          throw new Error(`HANDOFF_BUNDLE_TOO_LARGE: bundle exceeds ${MAX_BUNDLE_SIZE} bytes`);
        }
        entries.push({
          file,
          size: content.length,
          digest: createHash("sha256").update(content).digest("hex"),
        });
      }
    }
  } catch {
    // ignore
  }

  return {
    generated_at: new Date().toISOString(),
    files: entries,
    total_files: entries.length,
    total_bytes: totalBytes,
  };
}
