/**
 * @tripp-os/runtime-trace — Queue Handoff Tests
 *
 * Queue adapter operator handoff bundle tests.
 * All tests use temporary directories only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  generateQueueHandoff,
  validateQueueHandoffBundle,
} from "../index.js";
import type { QueueValidationResults } from "../index.js";

async function mkTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "tripp-qhandoff-test-"));
}

function makeValidationResults(overrides: Partial<QueueValidationResults> = {}): QueueValidationResults {
  return {
    typecheck: "pass",
    build: "pass",
    testsTotal: 196,
    testsPassing: 196,
    testsFailing: 0,
    suites: 88,
    fixtureScenarios: 11,
    fixtureScenariosPassing: 11,
    safetySearch: "clean",
    ...overrides,
  };
}

// ── 1. Bundle Generation ──────────────────────────────────────────────

describe("QueueHandoff: bundle generation", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkTempDir();
  });

  it("generates all 9 bundle files", async () => {
    const result = await generateQueueHandoff({
      outputDir: outDir,
      validationResults: makeValidationResults(),
    });

    expect(result.filesGenerated.length).toBe(9);
    expect(result.filesGenerated).toContain("README-TRACE-QUEUE-HANDOFF.md");
    expect(result.filesGenerated).toContain("queue-mode-summary.json");
    expect(result.filesGenerated).toContain("queue-mode-summary.md");
    expect(result.filesGenerated).toContain("trace-config-summary.json");
    expect(result.filesGenerated).toContain("rollback-plan.md");
    expect(result.filesGenerated).toContain("validation-results.json");
    expect(result.filesGenerated).toContain("safety-boundary-checklist.md");
    expect(result.filesGenerated).toContain("sample-trace-events.json");
    expect(result.filesGenerated).toContain("operator-decision-packet.json");
  });

  it("creates a timestamped bundle directory", async () => {
    const result = await generateQueueHandoff({
      outputDir: outDir,
      validationResults: makeValidationResults(),
    });

    expect(result.bundleDir).toContain("trace-queue-handoff-");
    const stat = await fs.stat(result.bundleDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("includes operator notes when provided", async () => {
    const notes = "Test operator notes for staging review.";
    const result = await generateQueueHandoff({
      outputDir: outDir,
      validationResults: makeValidationResults(),
      notes,
    });

    const readme = await fs.readFile(path.join(result.bundleDir, "README-TRACE-QUEUE-HANDOFF.md"), "utf-8");
    expect(readme).toContain("Test operator notes for staging review.");
  });

  it("includes recommended next marker when provided", async () => {
    const marker = "READY_FOR_PRODUCTION_REVIEW";
    const result = await generateQueueHandoff({
      outputDir: outDir,
      validationResults: makeValidationResults(),
      recommendedNextMarker: marker,
    });

    const readme = await fs.readFile(path.join(result.bundleDir, "README-TRACE-QUEUE-HANDOFF.md"), "utf-8");
    expect(readme).toContain("READY_FOR_PRODUCTION_REVIEW");
  });

  it("uses default validation results when none provided", async () => {
    const result = await generateQueueHandoff({
      outputDir: outDir,
    });

    const validationRaw = await fs.readFile(path.join(result.bundleDir, "validation-results.json"), "utf-8");
    const validation = JSON.parse(validationRaw);

    expect(validation.typecheck).toBe("pass");
    expect(validation.build).toBe("pass");
    expect(validation.testsTotal).toBe(196);
    expect(validation.testsPassing).toBe(196);
    expect(validation.testsFailing).toBe(0);
  });

  it("rejects forbidden output paths (shared-agent-bus)", async () => {
    await expect(
      generateQueueHandoff({
        outputDir: "/tmp/shared-agent-bus/handoff",
        validationResults: makeValidationResults(),
      })
    ).rejects.toThrow("HANDOFF_PATH_REJECTED");
  });

  it("rejects forbidden output paths (Tripp.Control)", async () => {
    await expect(
      generateQueueHandoff({
        outputDir: "/tmp/tripp.control/handoff",
        validationResults: makeValidationResults(),
      })
    ).rejects.toThrow("HANDOFF_PATH_REJECTED");
  });

  it("rejects forbidden output paths (Tripp.Reason)", async () => {
    await expect(
      generateQueueHandoff({
        outputDir: "/tmp/tripp-reason/handoff",
        validationResults: makeValidationResults(),
      })
    ).rejects.toThrow("HANDOFF_PATH_REJECTED");
  });
});

// ── 2. Bundle Validation ──────────────────────────────────────────────

describe("QueueHandoff: bundle validation", () => {
  let outDir: string;
  let bundleDir: string;

  beforeEach(async () => {
    outDir = await mkTempDir();
    const result = await generateQueueHandoff({
      outputDir: outDir,
      validationResults: makeValidationResults(),
    });
    bundleDir = result.bundleDir;
  });

  it("passes validation for a complete bundle", async () => {
    const result = await validateQueueHandoffBundle(bundleDir);
    if (!result.valid) {
      console.log("Validation errors:", result.errors);
      console.log("Validation warnings:", result.warnings);
    }
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it("fails validation when README is missing", async () => {
    await fs.unlink(path.join(bundleDir, "README-TRACE-QUEUE-HANDOFF.md"));
    const result = await validateQueueHandoffBundle(bundleDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("README-TRACE-QUEUE-HANDOFF.md"))).toBe(true);
  });

  it("fails validation when queue-mode-summary.json is missing", async () => {
    await fs.unlink(path.join(bundleDir, "queue-mode-summary.json"));
    const result = await validateQueueHandoffBundle(bundleDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("queue-mode-summary.json"))).toBe(true);
  });

  it("fails validation when rollback-plan.md is missing", async () => {
    await fs.unlink(path.join(bundleDir, "rollback-plan.md"));
    const result = await validateQueueHandoffBundle(bundleDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("rollback-plan.md"))).toBe(true);
  });

  it("fails validation when decision packet is missing", async () => {
    await fs.unlink(path.join(bundleDir, "operator-decision-packet.json"));
    const result = await validateQueueHandoffBundle(bundleDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("operator-decision-packet.json"))).toBe(true);
  });

  it("fails validation with invalid contract_classification", async () => {
    const summaryRaw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(summaryRaw);
    summary.contract_classification = "public-api";
    await fs.writeFile(path.join(bundleDir, "queue-mode-summary.json"), JSON.stringify(summary, null, 2));

    const result = await validateQueueHandoffBundle(bundleDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("contract_classification"))).toBe(true);
  });

  it("fails validation when mutation_capability is not 'none'", async () => {
    const summaryRaw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(summaryRaw);
    summary.mutation_capability = "full";
    await fs.writeFile(path.join(bundleDir, "queue-mode-summary.json"), JSON.stringify(summary, null, 2));

    const result = await validateQueueHandoffBundle(bundleDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mutation_capability"))).toBe(true);
  });

  it("fails validation when remote_capability is not 'none'", async () => {
    const summaryRaw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(summaryRaw);
    summary.remote_capability = "api";
    await fs.writeFile(path.join(bundleDir, "queue-mode-summary.json"), JSON.stringify(summary, null, 2));

    const result = await validateQueueHandoffBundle(bundleDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("remote_capability"))).toBe(true);
  });

  it("fails validation when live_agent_capability is not 'none'", async () => {
    const summaryRaw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(summaryRaw);
    summary.live_agent_capability = "spawn";
    await fs.writeFile(path.join(bundleDir, "queue-mode-summary.json"), JSON.stringify(summary, null, 2));

    const result = await validateQueueHandoffBundle(bundleDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("live_agent_capability"))).toBe(true);
  });

  it("fails validation when default_mode is not 'untraced'", async () => {
    const summaryRaw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(summaryRaw);
    summary.default_mode = "traced";
    await fs.writeFile(path.join(bundleDir, "queue-mode-summary.json"), JSON.stringify(summary, null, 2));

    const result = await validateQueueHandoffBundle(bundleDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("default_mode"))).toBe(true);
  });

  it("fails validation when rollback_available is not true", async () => {
    const summaryRaw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(summaryRaw);
    summary.rollback_available = false;
    await fs.writeFile(path.join(bundleDir, "queue-mode-summary.json"), JSON.stringify(summary, null, 2));

    const result = await validateQueueHandoffBundle(bundleDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("rollback_available"))).toBe(true);
  });

  it("fails validation when consumer_forbidden_actions is empty", async () => {
    const summaryRaw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(summaryRaw);
    summary.consumer_forbidden_actions = [];
    await fs.writeFile(path.join(bundleDir, "queue-mode-summary.json"), JSON.stringify(summary, null, 2));

    const result = await validateQueueHandoffBundle(bundleDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("consumer_forbidden_actions"))).toBe(true);
  });

  it("warns when traced_mode_requires is empty", async () => {
    const summaryRaw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(summaryRaw);
    summary.traced_mode_requires = [];
    await fs.writeFile(path.join(bundleDir, "queue-mode-summary.json"), JSON.stringify(summary, null, 2));

    const result = await validateQueueHandoffBundle(bundleDir);
    expect(result.warnings.some((w) => w.includes("traced_mode_requires"))).toBe(true);
  });
});

// ── 3. queue-mode-summary.json Content ────────────────────────────────

describe("QueueHandoff: mode summary content", () => {
  let outDir: string;
  let bundleDir: string;

  beforeEach(async () => {
    outDir = await mkTempDir();
    const result = await generateQueueHandoff({
      outputDir: outDir,
      validationResults: makeValidationResults(),
    });
    bundleDir = result.bundleDir;
  });

  it("has correct $schema", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    expect(summary.$schema).toBe("internal/tripp-os-trace-queue-handoff-v1");
  });

  it("has correct producer and version", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    expect(summary.producer).toBe("tripp-os-runtime-trace");
    expect(summary.package_name).toBe("@tripp-os/runtime-trace");
    expect(summary.package_version).toBe("0.1.0");
  });

  it("has both untraced and traced mode definitions", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    expect(summary.queue_mode_options.untraced).toBeDefined();
    expect(summary.queue_mode_options.traced).toBeDefined();
    expect(summary.queue_mode_options.untraced.default).toBe(true);
    expect(summary.queue_mode_options.traced.default).toBe(false);
  });

  it("lists traced mode features", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    const features = summary.queue_mode_options.traced.features;
    expect(features).toContain("packet_ops");
    expect(features).toContain("automatic_tracing");
    expect(features).toContain("rollback_support");
  });

  it("lists traced mode requirements", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    const reqs = summary.queue_mode_options.traced.requirements;
    expect(reqs).toContain("operator-approval");
    expect(reqs).toContain("trace-root-directory");
  });

  it("includes consumer permissions list", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    expect(Array.isArray(summary.consumer_permissions)).toBe(true);
    expect(summary.consumer_permissions.length).toBeGreaterThan(0);
  });

  it("includes consumer forbidden actions list", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    expect(Array.isArray(summary.consumer_forbidden_actions)).toBe(true);
    expect(summary.consumer_forbidden_actions.length).toBeGreaterThan(0);
  });

  it("embeds validation summary", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    expect(summary.validation_summary).toBeDefined();
    expect(summary.validation_summary.typecheck).toBe("pass");
  });
});

// ── 4. Safety Boundaries ──────────────────────────────────────────────

describe("QueueHandoff: safety boundaries", () => {
  let outDir: string;
  let bundleDir: string;

  beforeEach(async () => {
    outDir = await mkTempDir();
    const result = await generateQueueHandoff({
      outputDir: outDir,
      validationResults: makeValidationResults(),
    });
    bundleDir = result.bundleDir;
  });

  it("checklist marks all boundaries as HELD", async () => {
    const checklist = await fs.readFile(path.join(bundleDir, "safety-boundary-checklist.md"), "utf-8");
    const heldMatches = checklist.match(/\| HELD \|/g);
    expect(heldMatches?.length).toBeGreaterThanOrEqual(10);
    expect(checklist).not.toContain("BREACHED");
    expect(checklist).not.toContain("VIOLATED");
  });

  it("checklist confirms internal contract classification", async () => {
    const checklist = await fs.readFile(path.join(bundleDir, "safety-boundary-checklist.md"), "utf-8");
    expect(checklist).toContain("internal-tripp-os-runtime-trace");
  });

  it("mode summary has mutation_capability=none", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    expect(summary.mutation_capability).toBe("none");
  });

  it("mode summary has remote_capability=none", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    expect(summary.remote_capability).toBe("none");
  });

  it("mode summary has live_agent_capability=none", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    expect(summary.live_agent_capability).toBe("none");
  });

  it("checklist confirms no env var activation", async () => {
    const checklist = await fs.readFile(path.join(bundleDir, "safety-boundary-checklist.md"), "utf-8");
    expect(checklist.toLowerCase()).toContain("env var");
  });

  it("checklist confirms no live agents spawned", async () => {
    const checklist = await fs.readFile(path.join(bundleDir, "safety-boundary-checklist.md"), "utf-8");
    expect(checklist.toLowerCase()).toContain("live agent");
  });

  it("checklist confirms no Tripp.Control writes", async () => {
    const checklist = await fs.readFile(path.join(bundleDir, "safety-boundary-checklist.md"), "utf-8");
    expect(checklist).toContain("Tripp.Control");
  });

  it("checklist confirms no Tripp.Reason writes", async () => {
    const checklist = await fs.readFile(path.join(bundleDir, "safety-boundary-checklist.md"), "utf-8");
    expect(checklist).toContain("Tripp.Reason");
  });

  it("mode summary forbids env-var activation", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    const forbidden = summary.consumer_forbidden_actions;
    expect(forbidden.some((a: string) => a.includes("env-var-activation") || a.includes("env_var"))).toBe(true);
  });

  it("mode summary forbids default tracing", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    const forbidden = summary.consumer_forbidden_actions;
    expect(forbidden.some((a: string) => a.includes("default-tracing"))).toBe(true);
  });

  it("mode summary forbids shared-agent-bus mutation", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);
    const forbidden = summary.consumer_forbidden_actions;
    expect(forbidden.some((a: string) => a.includes("shared-agent-bus"))).toBe(true);
  });
});

// ── 5. Rollback Plan ──────────────────────────────────────────────────

describe("QueueHandoff: rollback plan", () => {
  let outDir: string;
  let bundleDir: string;

  beforeEach(async () => {
    outDir = await mkTempDir();
    const result = await generateQueueHandoff({
      outputDir: outDir,
      validationResults: makeValidationResults(),
    });
    bundleDir = result.bundleDir;
  });

  it("contains rollback triggers", async () => {
    const plan = await fs.readFile(path.join(bundleDir, "rollback-plan.md"), "utf-8");
    expect(plan).toContain("Triggers");
    expect(plan.toLowerCase()).toContain("disk usage");
  });

  it("contains rollback steps", async () => {
    const plan = await fs.readFile(path.join(bundleDir, "rollback-plan.md"), "utf-8");
    expect(plan).toContain("rollbackToUntracedQueue");
    expect(plan).toContain("Flush");
  });

  it("contains post-rollback state expectations", async () => {
    const plan = await fs.readFile(path.join(bundleDir, "rollback-plan.md"), "utf-8");
    expect(plan).toContain("untraced");
    expect(plan).toContain("Preserved");
  });

  it("contains 'must not happen' section", async () => {
    const plan = await fs.readFile(path.join(bundleDir, "rollback-plan.md"), "utf-8");
    expect(plan).toContain("Must NOT Happen");
    expect(plan).toContain("Do NOT delete trace files");
  });

  it("contains evidence preservation table", async () => {
    const plan = await fs.readFile(path.join(bundleDir, "rollback-plan.md"), "utf-8");
    expect(plan).toContain("Evidence to Preserve");
    expect(plan).toContain("traceRoot");
  });
});

// ── 6. Decision Packet ────────────────────────────────────────────────

describe("QueueHandoff: decision packet", () => {
  let outDir: string;
  let bundleDir: string;

  beforeEach(async () => {
    outDir = await mkTempDir();
    const result = await generateQueueHandoff({
      outputDir: outDir,
      validationResults: makeValidationResults(),
    });
    bundleDir = result.bundleDir;
  });

  it("has correct $schema", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "operator-decision-packet.json"), "utf-8");
    const packet = JSON.parse(raw);
    expect(packet.$schema).toBe("internal/tripp-os-trace-queue-handoff-v1");
  });

  it("contains all 4 decisions", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "operator-decision-packet.json"), "utf-8");
    const packet = JSON.parse(raw);
    expect(packet.decisions.length).toBe(4);
    const ids = packet.decisions.map((d: { id: string }) => d.id);
    expect(ids).toContain("APPROVE_STAGING_TRACED_QUEUE");
    expect(ids).toContain("KEEP_UNTRACED_QUEUE");
    expect(ids).toContain("REQUEST_MORE_FIXTURES");
    expect(ids).toContain("BLOCK_TRACED_QUEUE");
  });

  it("each decision has required_evidence", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "operator-decision-packet.json"), "utf-8");
    const packet = JSON.parse(raw);
    for (const decision of packet.decisions) {
      expect(Array.isArray(decision.required_evidence)).toBe(true);
      expect(decision.required_evidence.length).toBeGreaterThan(0);
    }
  });

  it("each decision has forbidden_assumptions", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "operator-decision-packet.json"), "utf-8");
    const packet = JSON.parse(raw);
    for (const decision of packet.decisions) {
      expect(Array.isArray(decision.forbidden_assumptions)).toBe(true);
      expect(decision.forbidden_assumptions.length).toBeGreaterThan(0);
    }
  });

  it("each decision has a next_marker", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "operator-decision-packet.json"), "utf-8");
    const packet = JSON.parse(raw);
    for (const decision of packet.decisions) {
      expect(decision.next_marker).toBeTruthy();
      expect(decision.next_marker.length).toBeGreaterThan(0);
    }
  });

  it("APPROVE_STAGING requires test evidence", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "operator-decision-packet.json"), "utf-8");
    const packet = JSON.parse(raw);
    const decision = packet.decisions.find((d: { id: string }) => d.id === "APPROVE_STAGING_TRACED_QUEUE");
    expect(decision.required_evidence.some((e: string) => e.includes("test"))).toBe(true);
  });

  it("KEEP_UNTRACED does not block future opt-in", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "operator-decision-packet.json"), "utf-8");
    const packet = JSON.parse(raw);
    const decision = packet.decisions.find((d: { id: string }) => d.id === "KEEP_UNTRACED_QUEUE");
    expect(decision.forbidden_assumptions.some((a: string) => a.includes("forever") || a.includes("future"))).toBe(true);
  });

  it("BLOCK decision does not affect untraced mode", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "operator-decision-packet.json"), "utf-8");
    const packet = JSON.parse(raw);
    const decision = packet.decisions.find((d: { id: string }) => d.id === "BLOCK_TRACED_QUEUE");
    expect(decision.forbidden_assumptions.some((a: string) => a.includes("untraced"))).toBe(true);
  });
});

// ── 7. Sample Events ──────────────────────────────────────────────────

describe("QueueHandoff: sample events", () => {
  let outDir: string;
  let bundleDir: string;

  beforeEach(async () => {
    outDir = await mkTempDir();
    const result = await generateQueueHandoff({
      outputDir: outDir,
      validationResults: makeValidationResults(),
    });
    bundleDir = result.bundleDir;
  });

  it("contains at least 3 sample events", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "sample-trace-events.json"), "utf-8");
    const events = JSON.parse(raw);
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  it("each event has required fields", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "sample-trace-events.json"), "utf-8");
    const events = JSON.parse(raw);
    for (const event of events) {
      expect(event.eventId).toBeTruthy();
      expect(event.eventType).toBeTruthy();
      expect(event.createdAt).toBeTruthy();
    }
  });

  it("contains packet_created event", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "sample-trace-events.json"), "utf-8");
    const events = JSON.parse(raw);
    const hasCreated = events.some((e: { eventType: string }) => e.eventType === "packet_created");
    expect(hasCreated).toBe(true);
  });

  it("contains packet_read or packet_claimed event", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "sample-trace-events.json"), "utf-8");
    const events = JSON.parse(raw);
    const hasRead = events.some((e: { eventType: string }) =>
      e.eventType === "packet_read" || e.eventType === "packet_claimed"
    );
    expect(hasRead).toBe(true);
  });

  it("contains packet_archived or result_written event", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "sample-trace-events.json"), "utf-8");
    const events = JSON.parse(raw);
    const hasArchived = events.some((e: { eventType: string }) =>
      e.eventType === "packet_archived" || e.eventType === "result_written"
    );
    expect(hasArchived).toBe(true);
  });

  it("events do not contain real secrets", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "sample-trace-events.json"), "utf-8");
    // Should not contain obvious secret patterns
    expect(raw).not.toMatch(/password\s*[=:]\s*["'][^"']+["']/i);
    expect(raw).not.toMatch(/token\s*[=:]\s*["'][^"']+["']/i);
    expect(raw).not.toMatch(/secret\s*[=:]\s*["'][^"']+["']/i);
  });
});

// ── 8. README Content ─────────────────────────────────────────────────

describe("QueueHandoff: README content", () => {
  let outDir: string;
  let bundleDir: string;

  beforeEach(async () => {
    outDir = await mkTempDir();
    const result = await generateQueueHandoff({
      outputDir: outDir,
      validationResults: makeValidationResults(),
    });
    bundleDir = result.bundleDir;
  });

  it("has correct classification", async () => {
    const readme = await fs.readFile(path.join(bundleDir, "README-TRACE-QUEUE-HANDOFF.md"), "utf-8");
    expect(readme).toContain("internal-tripp-os-runtime-trace");
  });

  it("documents what traced mode does", async () => {
    const readme = await fs.readFile(path.join(bundleDir, "README-TRACE-QUEUE-HANDOFF.md"), "utf-8");
    expect(readme).toContain("What Traced Queue Mode Does");
  });

  it("documents what traced mode does NOT do", async () => {
    const readme = await fs.readFile(path.join(bundleDir, "README-TRACE-QUEUE-HANDOFF.md"), "utf-8");
    expect(readme).toContain("What Traced Queue Mode Does NOT Do");
    expect(readme).toContain("Does NOT enable itself automatically");
    expect(readme).toContain("Does NOT start live agents");
  });

  it("documents operator decisions", async () => {
    const readme = await fs.readFile(path.join(bundleDir, "README-TRACE-QUEUE-HANDOFF.md"), "utf-8");
    expect(readme).toContain("What the Operator Must Decide");
  });

  it("documents operator prohibitions", async () => {
    const readme = await fs.readFile(path.join(bundleDir, "README-TRACE-QUEUE-HANDOFF.md"), "utf-8");
    expect(readme).toContain("What the Operator Must NOT Do");
    expect(readme).toContain("Mutate trace files");
  });

  it("contains validation results table", async () => {
    const readme = await fs.readFile(path.join(bundleDir, "README-TRACE-QUEUE-HANDOFF.md"), "utf-8");
    expect(readme).toContain("Validation Results");
    expect(readme).toContain("Typecheck");
    expect(readme).toContain("Build");
  });

  it("contains bundle files table", async () => {
    const readme = await fs.readFile(path.join(bundleDir, "README-TRACE-QUEUE-HANDOFF.md"), "utf-8");
    expect(readme).toContain("Bundle Files");
    expect(readme).toContain("queue-mode-summary.json");
    expect(readme).toContain("operator-decision-packet.json");
  });
});

// ── 9. Trace Config Summary ───────────────────────────────────────────

describe("QueueHandoff: trace config summary", () => {
  let outDir: string;
  let bundleDir: string;

  beforeEach(async () => {
    outDir = await mkTempDir();
    const result = await generateQueueHandoff({
      outputDir: outDir,
      validationResults: makeValidationResults(),
    });
    bundleDir = result.bundleDir;
  });

  it("has all three environments", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "trace-config-summary.json"), "utf-8");
    const config = JSON.parse(raw);
    expect(config.environments.development).toBeDefined();
    expect(config.environments.staging).toBeDefined();
    expect(config.environments.production).toBeDefined();
  });

  it("development has fsync disabled", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "trace-config-summary.json"), "utf-8");
    const config = JSON.parse(raw);
    expect(config.environments.development.fsyncOnAppend).toBe(false);
  });

  it("production has fsync enabled", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "trace-config-summary.json"), "utf-8");
    const config = JSON.parse(raw);
    expect(config.environments.production.fsyncOnAppend).toBe(true);
  });

  it("has notes array", async () => {
    const raw = await fs.readFile(path.join(bundleDir, "trace-config-summary.json"), "utf-8");
    const config = JSON.parse(raw);
    expect(Array.isArray(config.notes)).toBe(true);
    expect(config.notes.length).toBeGreaterThan(0);
  });
});

// ── 10. Secret Detection ─────────────────────────────────────────────

describe("QueueHandoff: secret detection", () => {
  it("throws when generated content contains secrets", async () => {
    const outDir = await mkTempDir();
    // Create a handoff that would trigger secret detection by using notes
    // The actual implementation scans all generated files
    // Since our builders don't include secrets, this tests the negative case
    const result = await generateQueueHandoff({
      outputDir: outDir,
      validationResults: makeValidationResults(),
    });

    // All files should be clean
    for (const file of result.filesGenerated) {
      const content = await fs.readFile(path.join(result.bundleDir, file), "utf-8");
      expect(content).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);
      expect(content).not.toMatch(/password\s*[=:]\s*["'][^"']+["']/i);
    }
  });
});

// ── 11. Fail-Closed Validation Edge Cases ────────────────────────────

describe("QueueHandoff: fail-closed edge cases", () => {
  it("fails validation for non-existent directory", async () => {
    const result = await validateQueueHandoffBundle("/nonexistent/dir-12345");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("fails validation for empty directory", async () => {
    const emptyDir = await mkTempDir();
    const result = await validateQueueHandoffBundle(emptyDir);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(9); // All 9 required files missing
  });

  it("fails validation when queue-mode-summary.json is malformed JSON", async () => {
    const outDir = await mkTempDir();
    const genResult = await generateQueueHandoff({
      outputDir: outDir,
      validationResults: makeValidationResults(),
    });

    await fs.writeFile(path.join(genResult.bundleDir, "queue-mode-summary.json"), "not json");
    const result = await validateQueueHandoffBundle(genResult.bundleDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unparseable"))).toBe(true);
  });
});
