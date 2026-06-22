/**
 * @tripp-os/runtime-trace — Bundle Diff
 *
 * Compare two handoff bundles to detect changes in trace state.
 * Used by operators to understand what changed between snapshots.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ── Diff Result ───────────────────────────────────────────────────────

export interface BundleDiffResult {
  /** Human-readable summary of changes. */
  summary: string;
  /** Confidence level change (e.g. "confirmed → report-backed"). */
  confidenceDelta: string;
  /** Files present in B but not in A. */
  newFiles: string[];
  /** Files present in A but not in B. */
  missingFiles: string[];
  /** Files whose content changed. */
  modifiedFiles: Array<{ file: string; changes: string[] }>;
  /** Change in malformed line count. */
  malformedDelta: number;
  /** Warnings about the diff. */
  warnings: string[];
}

// ── diffHandoffBundles ────────────────────────────────────────────────

/**
 * Compare two handoff bundles and report differences.
 * Both bundles must have trace-summary.json.
 */
export async function diffHandoffBundles(
  bundleA: string,
  bundleB: string
): Promise<BundleDiffResult> {
  const result: BundleDiffResult = {
    summary: `Comparing ${path.basename(bundleA)} vs ${path.basename(bundleB)}`,
    confidenceDelta: "unknown → unknown",
    newFiles: [],
    missingFiles: [],
    modifiedFiles: [],
    malformedDelta: 0,
    warnings: [],
  };

  // Read summaries
  let summaryA: Record<string, unknown> = {};
  let summaryB: Record<string, unknown> = {};

  try {
    const rawA = await fs.readFile(path.join(bundleA, "trace-summary.json"), "utf-8");
    summaryA = JSON.parse(rawA) as Record<string, unknown>;
  } catch {
    result.warnings.push("Bundle A missing trace-summary.json");
  }

  try {
    const rawB = await fs.readFile(path.join(bundleB, "trace-summary.json"), "utf-8");
    summaryB = JSON.parse(rawB) as Record<string, unknown>;
  } catch {
    result.warnings.push("Bundle B missing trace-summary.json");
  }

  // Compare confidence
  const confA = String(summaryA.confidence_level ?? "unknown");
  const confB = String(summaryB.confidence_level ?? "unknown");
  result.confidenceDelta = confA === confB ? `${confA} (unchanged)` : `${confA} → ${confB}`;

  // Compare malformed lines
  const malA = getMalformedCount(summaryA);
  const malB = getMalformedCount(summaryB);
  result.malformedDelta = malB - malA;

  // Compare file manifests
  const filesA = await listFiles(bundleA);
  const filesB = await listFiles(bundleB);

  result.newFiles = filesB.filter((f) => !filesA.includes(f));
  result.missingFiles = filesA.filter((f) => !filesB.includes(f));

  const commonFiles = filesA.filter((f) => filesB.includes(f));
  for (const file of commonFiles) {
    const contentA = await readFileSafe(path.join(bundleA, file));
    const contentB = await readFileSafe(path.join(bundleB, file));
    if (contentA && contentB && contentA !== contentB) {
      const changes = describeChanges(file, contentA, contentB);
      result.modifiedFiles.push({ file, changes });
    }
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────

function getMalformedCount(summary: Record<string, unknown>): number {
  const vs = summary.validation_summary as Record<string, unknown> | undefined;
  if (vs && typeof vs.malformed_lines === "number") return vs.malformed_lines;
  const mls = summary.malformed_line_summary as Record<string, unknown> | undefined;
  if (mls && typeof mls.malformed_lines_detected === "number") return mls.malformed_lines_detected;
  return 0;
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((f) => !f.endsWith(".map")).sort();
  } catch {
    return [];
  }
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function describeChanges(file: string, _contentA: string, _contentB: string): string[] {
  const changes: string[] = [];
  if (file === "trace-summary.json") {
    changes.push("Summary metadata changed");
  } else if (file === "trace-health.json") {
    changes.push("Health snapshot changed");
  } else if (file === "trace-validation.json") {
    changes.push("Validation results changed");
  } else if (file === "trace-checksums.json") {
    changes.push("Checksum verification changed");
  } else if (file === "trace-manifest.json") {
    changes.push("File manifest changed");
  } else {
    changes.push("Content changed");
  }
  return changes;
}
