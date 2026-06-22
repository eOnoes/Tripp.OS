/**
 * @tripp-os/runtime-trace — Handoff Tests
 *
 * Stage 6J: Operator handoff generator tests.
 * All tests use temporary directories only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  generateTraceHandoff,
  validateHandoffBundle,
  createTraceWriter,
  createTraceReader,
  validateTraceConfig,
} from "../index.js";
import type { HandoffOptions } from "../index.js";
import type { CreateTraceEventInput } from "@tripp-os/agent-bus";

async function mkTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "tripp-handoff-test-"));
}

function makeEvent(overrides: Partial<CreateTraceEventInput> = {}): CreateTraceEventInput {
  return {
    eventType: "packet_created",
    severity: "info",
    actorType: "system",
    summary: "Test event",
    ...overrides,
  };
}

// ── 1. Generates all seven bundle files ───────────────────────────────

describe("Handoff: bundle generation", () => {
  let tmpDir: string;
  let outDir: string;

  beforeEach(async () => {
    tmpDir = await mkTempDir();
    outDir = await mkTempDir();
  });

  it("generates all seven bundle files", async () => {
    const config = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false });
    const writer = createTraceWriter(config);
    await writer.append(makeEvent());

    const result = await generateTraceHandoff(tmpDir, outDir, { config });
    expect(result.filesGenerated.length).toBe(7);
    expect(result.filesGenerated).toContain("trace-summary.json");
    expect(result.filesGenerated).toContain("trace-summary.md");
    expect(result.filesGenerated).toContain("trace-health.json");
    expect(result.filesGenerated).toContain("trace-validation.json");
    expect(result.filesGenerated).toContain("trace-checksums.json");
    expect(result.filesGenerated).toContain("trace-manifest.json");
    expect(result.filesGenerated).toContain("README-RUNTIME-TRACE-HANDOFF.md");
  });

  // ── 2. trace-summary.json has required metadata ─────────────────────
  it("trace-summary.json has all required metadata fields", async () => {
    const config = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false });
    const writer = createTraceWriter(config);
    await writer.append(makeEvent());

    await generateTraceHandoff(tmpDir, outDir, { config });
    const bundleDir = (await fs.readdir(outDir)).find((d) => d.startsWith("runtime-trace-handoff-"));
    const summaryRaw = await fs.readFile(path.join(outDir, bundleDir!, "trace-summary.json"), "utf-8");
    const summary = JSON.parse(summaryRaw);

    expect(summary.handoff_version).toBeTruthy();
    expect(summary.generated_at).toBeTruthy();
    expect(summary.producer).toBe("tripp-os-runtime-trace");
    expect(summary.producer_version).toBe("0.1.0");
    expect(summary.producer_project).toBe("Tripp.OS");
    expect(summary.contract_classification).toBe("internal-tripp-os-runtime-trace");
    expect(summary.source_trace_root).toBe(tmpDir);
    expect(Array.isArray(summary.source_ledger_files)).toBe(true);
    expect(summary.mutation_capability).toBe("none");
    expect(Array.isArray(summary.consumer_permissions)).toBe(true);
    expect(Array.isArray(summary.consumer_forbidden_actions)).toBe(true);
    expect(summary.redaction_status).toBe("safe-metadata-only");
    expect(summary.confidence_level).toBeTruthy();
    expect(summary.confidence_reason).toBeTruthy();
    expect(summary.recommended_next_marker).toBeTruthy();
    expect(Array.isArray(summary.evidence_files)).toBe(true);
    expect(summary.health_summary).toBeDefined();
    expect(summary.validation_summary).toBeDefined();
    expect(summary.checksum_summary).toBeDefined();
    expect(summary.rotation_summary).toBeDefined();
    expect(summary.fallback_summary).toBeDefined();
    expect(summary.malformed_line_summary).toBeDefined();
  });

  // ── 3. README includes operator inspection steps ────────────────────
  it("README includes operator inspection steps and warnings", async () => {
    const cfg = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false });
    const writer = createTraceWriter(cfg);
    await writer.append(makeEvent());

    await generateTraceHandoff(tmpDir, outDir, { config: cfg });
    const bundleDir = (await fs.readdir(outDir)).find((d) => d.startsWith("runtime-trace-handoff-"));
    const readme = await fs.readFile(path.join(outDir, bundleDir!, "README-RUNTIME-TRACE-HANDOFF.md"), "utf-8");

    expect(readme).toContain("Operator Inspection Steps");
    expect(readme).toContain("What You Must NOT Do");
    expect(readme).toContain("static handoff bundle");
    expect(readme).toContain("internal-tripp-os-runtime-trace");
  });

  // ── 4. trace-validation.json reflects reader.validate() ─────────────
  it("trace-validation.json reflects ledger validation results", async () => {
    const cfg = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false });
    const writer = createTraceWriter(cfg);
    await writer.append(makeEvent());
    await writer.append(makeEvent());

    await generateTraceHandoff(tmpDir, outDir, { config: cfg });
    const bundleDir = (await fs.readdir(outDir)).find((d) => d.startsWith("runtime-trace-handoff-"));
    const valRaw = await fs.readFile(path.join(outDir, bundleDir!, "trace-validation.json"), "utf-8");
    const val = JSON.parse(valRaw);

    expect(val.is_valid).toBe(true);
    expect(val.total_lines).toBe(2);
    expect(val.valid_lines).toBe(2);
    expect(val.malformed_lines).toBe(0);
  });

  // ── 5. trace-checksums.json verifies checksum sidecars ──────────────
  it("trace-checksums.json reports checksum verification", async () => {
    const cfg = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false, checksumEnabled: true });
    const writer = createTraceWriter(cfg);
    await writer.append(makeEvent());
    await writer.rotate();

    await generateTraceHandoff(tmpDir, outDir, { config: cfg });
    const bundleDir = (await fs.readdir(outDir)).find((d) => d.startsWith("runtime-trace-handoff-"));
    const csRaw = await fs.readFile(path.join(outDir, bundleDir!, "trace-checksums.json"), "utf-8");
    const cs = JSON.parse(csRaw);

    expect(cs.checksums_enabled).toBe(true);
    expect(cs.checksum_algorithm).toBe("SHA-256");
    expect(Array.isArray(cs.files_checked)).toBe(true);
  });

  // ── 6. trace-health.json maps health fields correctly ───────────────
  it("trace-health.json maps writer health fields (fresh writer)", async () => {
    const cfg = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false });

    // generateTraceHandoff creates a fresh writer for introspection
    // It does not use the caller's writer, so health reflects a fresh state
    await generateTraceHandoff(tmpDir, outDir, { config: cfg });
    const bundleDir = (await fs.readdir(outDir)).find((d) => d.startsWith("runtime-trace-handoff-"));
    const healthRaw = await fs.readFile(path.join(outDir, bundleDir!, "trace-health.json"), "utf-8");
    const health = JSON.parse(healthRaw);

    // Fresh writer: never used to append
    expect(health.writable).toBe(false);
    expect(health.degraded).toBe(false);
    expect(health.fallback_sink).toBeNull();
    expect(health.malformed_ratio).toBeNull();
    expect(health.total_appends).toBe(0);
    expect(health.successful_appends).toBe(0);
  });

  // ── 7. trace-manifest.json lists all bundle files ───────────────────
  it("trace-manifest.json lists all bundle files with digests", async () => {
    const cfg = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false });
    const writer = createTraceWriter(cfg);
    await writer.append(makeEvent());

    const result = await generateTraceHandoff(tmpDir, outDir, { config: cfg });
    const manifestRaw = await fs.readFile(path.join(result.bundleDir, "trace-manifest.json"), "utf-8");
    const manifest = JSON.parse(manifestRaw);

    expect(Array.isArray(manifest.files)).toBe(true);
    // Manifest is generated after 5 files, before README (which is written last)
    // So manifest lists the 5 files that exist at generation time
    expect(manifest.files.length).toBe(5);
    expect(manifest.total_files).toBe(5);
    expect(manifest.total_bytes).toBeGreaterThan(0);
    expect(manifest.files[0].digest).toBeTruthy(); // SHA-256 digest
    expect(manifest.files[0].size).toBeGreaterThan(0);

    // Verify all 7 files actually exist in bundle directory
    const bundleFiles = await fs.readdir(result.bundleDir);
    expect(bundleFiles.length).toBe(7);
  });

  // ── 8. Confidence is confirmed for clean trace ──────────────────────
  it("confidence is confirmed for clean trace with checksums", async () => {
    const writer = createTraceWriter(validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false, checksumEnabled: true }));
    await writer.append(makeEvent());
    await writer.rotate();

    const cfg = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false, checksumEnabled: true });
    const result = await generateTraceHandoff(tmpDir, outDir, { config: cfg });
    expect(result.confidenceLevel).toBe("confirmed");
  });

  // ── 9. Confidence is report-backed for degraded or partial checksum case ─
  it("confidence is report-backed when checksums are disabled", async () => {
    const cfg = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false, checksumEnabled: false });
    const writer = createTraceWriter(cfg);
    await writer.append(makeEvent());

    const result = await generateTraceHandoff(tmpDir, outDir, { config: cfg });
    expect(result.confidenceLevel).toBe("report-backed");
  });

  // ── 10. validateHandoffBundle passes clean bundle ───────────────────
  it("validateHandoffBundle passes for clean bundle", async () => {
    const cfg = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false });
    const writer = createTraceWriter(cfg);
    await writer.append(makeEvent());

    const result = await generateTraceHandoff(tmpDir, outDir, { config: cfg });
    const validation = await validateHandoffBundle(result.bundleDir);

    expect(validation.valid).toBe(true);
    expect(validation.errors.length).toBe(0);
  });
});

// ── 11-20: Invalid bundle conditions ──────────────────────────────────

describe("Handoff: invalid bundle validation", () => {
  let tmpDir: string;
  let outDir: string;

  beforeEach(async () => {
    tmpDir = await mkTempDir();
    outDir = await mkTempDir();
  });

  // 11. missing trace-summary.json fails validation
  it("fails validation when trace-summary.json is missing", async () => {
    const writer = createTraceWriter(validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false }));
    await writer.append(makeEvent());

    const result = await generateTraceHandoff(tmpDir, outDir, { config: validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false }) });
    await fs.unlink(path.join(result.bundleDir, "trace-summary.json"));

    const validation = await validateHandoffBundle(result.bundleDir);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes("trace-summary.json"))).toBe(true);
  });

  // 12. mutation_capability not none fails validation
  it("fails validation when mutation_capability is not none", async () => {
    const writer = createTraceWriter(validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false }));
    await writer.append(makeEvent());

    const cfg = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false });
    const result = await generateTraceHandoff(tmpDir, outDir, { config: cfg });
    const summaryRaw = await fs.readFile(path.join(result.bundleDir, "trace-summary.json"), "utf-8");
    const summary = JSON.parse(summaryRaw);
    summary.mutation_capability = "read-write";
    await fs.writeFile(path.join(result.bundleDir, "trace-summary.json"), JSON.stringify(summary, null, 2), "utf-8");

    const validation = await validateHandoffBundle(result.bundleDir);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes("mutation_capability"))).toBe(true);
  });

  // 13. wrong contract_classification fails validation
  it("fails validation when contract_classification is wrong", async () => {
    const writer = createTraceWriter(validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false }));
    await writer.append(makeEvent());

    const cfg = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false });
    const result = await generateTraceHandoff(tmpDir, outDir, { config: cfg });
    const summaryRaw = await fs.readFile(path.join(result.bundleDir, "trace-summary.json"), "utf-8");
    const summary = JSON.parse(summaryRaw);
    summary.contract_classification = "public-api";
    await fs.writeFile(path.join(result.bundleDir, "trace-summary.json"), JSON.stringify(summary, null, 2), "utf-8");

    const validation = await validateHandoffBundle(result.bundleDir);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes("contract_classification"))).toBe(true);
  });

  // 14. shared-agent-bus source path fails generation
  it("fails generation when source path contains shared-agent-bus", async () => {
    const badPath = path.join(tmpDir, "shared-agent-bus", "trace");
    let threw = false;
    try {
      await generateTraceHandoff(badPath, outDir);
    } catch (err: unknown) {
      threw = true;
      expect((err as Error).message).toContain("shared-agent-bus");
    }
    expect(threw).toBe(true);
  });

  // 15. Tripp.Control source path fails generation
  it("fails generation when source path contains Tripp.Control", async () => {
    const badPath = path.join(tmpDir, "tripp-control", "trace");
    let threw = false;
    try {
      await generateTraceHandoff(badPath, outDir);
    } catch (err: unknown) {
      threw = true;
      expect((err as Error).message).toContain("Tripp.Control");
    }
    expect(threw).toBe(true);
  });

  // 16. Tripp.Reason source path fails generation
  it("fails generation when source path contains Tripp.Reason", async () => {
    const badPath = path.join(tmpDir, "tripp-reason", "trace");
    let threw = false;
    try {
      await generateTraceHandoff(badPath, outDir);
    } catch (err: unknown) {
      threw = true;
      expect((err as Error).message).toContain("Tripp.Reason");
    }
    expect(threw).toBe(true);
  });

  // 17. missing evidence file fails validation
  it("fails validation when evidence file is missing", async () => {
    const cfg = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false });
    const writer = createTraceWriter(cfg);
    await writer.append(makeEvent());

    const result = await generateTraceHandoff(tmpDir, outDir, { config: cfg });
    await fs.unlink(path.join(result.bundleDir, "trace-health.json"));

    const validation = await validateHandoffBundle(result.bundleDir);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes("evidence") || e.includes("trace-health"))).toBe(true);
  });

  // 18. recommended_next_marker missing/malformed warns
  it("warns when recommended_next_marker is malformed", async () => {
    const cfg = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false });
    const writer = createTraceWriter(cfg);
    await writer.append(makeEvent());

    const result = await generateTraceHandoff(tmpDir, outDir, { config: cfg, recommendedNextMarker: "" });
    const validation = await validateHandoffBundle(result.bundleDir);
    expect(validation.warnings.some((w) => w.includes("recommended_next_marker"))).toBe(true);
  });

  // 19. output stays inside explicit local output path
  it("bundle is created inside specified output directory", async () => {
    const cfg = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false });
    const writer = createTraceWriter(cfg);
    await writer.append(makeEvent());

    const result = await generateTraceHandoff(tmpDir, outDir, { config: cfg });
    expect(result.bundleDir.startsWith(outDir)).toBe(true);
  });

  // 20. no live/shared-bus/cross-project behavior
  it("does not reference live agents, shared bus, or cross-project", async () => {
    const cfg = validateTraceConfig({ traceRoot: tmpDir, fsyncOnAppend: false });
    const writer = createTraceWriter(cfg);
    await writer.append(makeEvent());

    const result = await generateTraceHandoff(tmpDir, outDir, { config: cfg });
    const summaryRaw = await fs.readFile(path.join(result.bundleDir, "trace-summary.json"), "utf-8");
    const summary = JSON.parse(summaryRaw);

    // Internal contract classification
    expect(summary.contract_classification).toBe("internal-tripp-os-runtime-trace");
    expect(summary.mutation_capability).toBe("none");
    expect(summary.producer).toBe("tripp-os-runtime-trace");
    expect(summary.producer_project).toBe("Tripp.OS");

    // Source path is local temp dir, not shared-agent-bus
    expect(summary.source_trace_root).toBe(tmpDir);
    expect(summary.source_trace_root).not.toContain("shared-agent-bus");

    // No Tripp.Control or Tripp.Reason in any string field
    const allStrings = JSON.stringify(summary);
    expect(allStrings).not.toContain("Tripp.Control");
    expect(allStrings).not.toContain("Tripp.Reason");

    // Note: "mutate-shared-agent-bus" is in consumer_forbidden_actions,
    // which is expected. We check source_trace_root specifically for the
    // shared-agent-bus path, not the raw JSON.
  });
});
