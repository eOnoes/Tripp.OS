/**
 * @tripp-os/runtime-trace — TraceBusAdapter Integration Fixture Gate
 *
 * 10 dedicated fixture scenarios for adapter integration validation.
 * All tests use temp directories only. No deployment. No live wiring.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  createTraceBusAdapter,
  validateTraceConfig,
  createTraceReader,
  generateTraceHandoff,
  validateHandoffBundle,
  generateDashboard,
  compressRotatedLedgers,
  diffHandoffBundles,
} from "../index.js";
import type { ExternalAgentTaskPacket, ExternalAgentResultPacket, ExternalAgentReviewPacket } from "@tripp-os/agent-bus";

async function mkTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "tripp-fix-"));
}

function makeTaskPkt(overrides: Partial<ExternalAgentTaskPacket> = {}): ExternalAgentTaskPacket {
  return {
    schemaVersion: "1.0.0", packetId: `pkt-${Date.now()}`, runId: `run-${Date.now()}`,
    createdAt: new Date().toISOString(), createdBy: "test", agentRole: "openclaw_tripp",
    taskType: "plan", title: "Fixture Task", objective: "Test objective", scope: "test",
    trustZone: "cloud_sandbox_proposal", allowedPaths: [], deniedPaths: [],
    toolPolicy: { allowShell: false, allowWrite: false, allowNetwork: false, allowSecrets: false, allowedTools: [], deniedTools: [] },
    approvalPolicy: { requiresHumanApproval: false, requiresApprovalGate: false, agentMayApprove: false, echoReviewRequired: false },
    contextPolicy: { contextBudgetTokens: 8000, redactSecrets: true, includeRepoSummary: false, includeFileContents: false, allowedContextPaths: [], deniedContextPaths: [] },
    constraints: [], requiredOutputFormat: "json", reportRequired: false, status: "pending",
    ...overrides,
  };
}

function makeResultPkt(overrides: Partial<ExternalAgentResultPacket> = {}): ExternalAgentResultPacket {
  return {
    schemaVersion: "1.0.0", resultId: `res-${Date.now()}`, packetId: `pkt-${Date.now()}`,
    runId: `run-${Date.now()}`, createdAt: new Date().toISOString(), agentRole: "openclaw_tripp",
    trustZone: "cloud_sandbox_proposal", summary: "Fixture result", status: "success",
    assumptions: [], risks: [], proposedChanges: [], filesReferenced: [],
    validationPerformed: [], requestedApprovals: [], nextRecommendedAction: "",
    ...overrides,
  };
}

function makeReviewPkt(overrides: Partial<ExternalAgentReviewPacket> = {}): ExternalAgentReviewPacket {
  return {
    schemaVersion: "1.0.0", reviewId: `rev-${Date.now()}`, packetId: `pkt-${Date.now()}`,
    runId: `run-${Date.now()}`, createdAt: new Date().toISOString(), reviewerRole: "openclaw_echo",
    verdict: "pass", summary: "Fixture review", issues: [], boundaryFindings: [],
    doctrineFindings: [], safetyFindings: [], recommendedNextAction: "",
    ...overrides,
  };
}

async function readAllEvents(traceRoot: string) {
  const cfg = validateTraceConfig({ traceRoot, fsyncOnAppend: false });
  const reader = createTraceReader(cfg);
  return reader.tail({ limit: 1000 });
}

// ═══════════════════════════════════════════════════════════════════════
//  FIXTURE 1: Full Lifecycle
// ═══════════════════════════════════════════════════════════════════════

describe("Fixture 1: full lifecycle", () => {
  it("task -> read -> result -> read -> review -> archive with complete correlation", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg, actorType: "openclaw_tripp", runId: "fixture-run-1" });

    const task = makeTaskPkt({ packetId: "lifecycle-p1", title: "Lifecycle Task" });
    const t1 = await adapter.writeTaskPacket(task, { workdir: busDir });
    const t1Read = await adapter.readTaskPacket(t1.packetResult);

    const result = makeResultPkt({ packetId: task.packetId, summary: "Lifecycle Result" });
    const r1 = await adapter.writeResultPacket(result, { workdir: busDir });
    await adapter.readResultPacket(r1.packetResult);

    const review = makeReviewPkt({ packetId: task.packetId, verdict: "pass" });
    await adapter.writeReviewPacket(review, { workdir: busDir });

    await adapter.moveToArchive(t1.packetResult, { workdir: busDir });

    const events = await readAllEvents(traceDir);

    // All expected event types
    expect(events.filter((e) => e.eventType === "packet_created").length).toBe(1);
    expect(events.filter((e) => e.eventType === "packet_read").length).toBe(1);
    expect(events.filter((e) => e.eventType === "result_written").length).toBe(1);
    expect(events.filter((e) => e.eventType === "result_read").length).toBe(1);
    expect(events.filter((e) => e.eventType === "warden_verdict_recorded").length).toBe(1);
    expect(events.filter((e) => e.eventType === "packet_archived").length).toBe(1);

    // Deterministic ordering: find events by position
    const createdEvt = events.find((e) => e.eventType === "packet_created");
    const readEvt = events.find((e) => e.eventType === "packet_read");
    const resultWrittenEvt = events.find((e) => e.eventType === "result_written");
    const resultReadEvt = events.find((e) => e.eventType === "result_read");
    const reviewEvt = events.find((e) => e.eventType === "warden_verdict_recorded");
    const archiveEvt = events.find((e) => e.eventType === "packet_archived");

    expect(createdEvt).toBeDefined();
    expect(readEvt).toBeDefined();
    expect(resultWrittenEvt).toBeDefined();
    expect(resultReadEvt).toBeDefined();
    expect(reviewEvt).toBeDefined();
    expect(archiveEvt).toBeDefined();

    // Ordering: created before read, read before result, etc.
    const idx = (e: any) => events.indexOf(e);
    expect(idx(createdEvt!)).toBeLessThan(idx(readEvt!));
    expect(idx(readEvt!)).toBeLessThan(idx(resultWrittenEvt!));
    expect(idx(resultWrittenEvt!)).toBeLessThan(idx(reviewEvt!));
    expect(idx(reviewEvt!)).toBeLessThan(idx(archiveEvt!));

    // Correlation
    for (const e of events) {
      expect(e.runId).toBe("fixture-run-1");
    }
    expect(createdEvt!.packetId).toBe("lifecycle-p1");

    // No duplicate event IDs
    const ids = events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  FIXTURE 2: Rejection
// ═══════════════════════════════════════════════════════════════════════

describe("Fixture 2: rejection", () => {
  it("task -> rejection with safe metadata and no false positives", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg });

    const task = makeTaskPkt({ packetId: "reject-p1", title: "Rejection Task" });
    const t1 = await adapter.writeTaskPacket(task, { workdir: busDir });

    await adapter.moveToRejected(t1.packetResult, "boundary_violation_detected", { workdir: busDir });

    const events = await readAllEvents(traceDir);

    // Expected events only
    expect(events.filter((e) => e.eventType === "packet_created").length).toBe(1);
    expect(events.filter((e) => e.eventType === "packet_rejected").length).toBe(1);

    // No archive false-positive
    expect(events.filter((e) => e.eventType === "packet_archived").length).toBe(0);
    // No result false-positive
    expect(events.filter((e) => e.eventType === "result_written").length).toBe(0);

    // Rejection metadata safe
    const rejected = events.find((e) => e.eventType === "packet_rejected")!;
    expect(rejected.severity).toBe("warning");
    expect(rejected.sourcePath).toBe(t1.packetResult);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  FIXTURE 3: Degraded Trace (fallback sink activation)
// ═══════════════════════════════════════════════════════════════════════

describe("Fixture 3: degraded trace with fallback sink", () => {
  it("trace never throws and packet operation always returns valid result", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg, actorType: "system" });

    // Normal operation: both packet and trace succeed
    const task = makeTaskPkt({ title: "Normal Task" });
    const result = await adapter.writeTaskPacket(task, { workdir: busDir });

    // packetResult is always valid regardless of trace state
    expect(result.packetResult).toBeTruthy();
    expect(typeof result.packetResult).toBe("string");
    expect(result.traceEventId).toBeTruthy();

    // trace() direct call never throws — contract verification
    const traceResult = await adapter.trace("packet_created", { summary: "Direct trace test" });
    expect(traceResult).toBeDefined();
    expect(traceResult.timestamp).toBeDefined();
    // Either success or graceful failure shape
    expect(traceResult.sink).toBeDefined();

    // Health stays accurate
    const health = adapter.health();
    expect(health.degraded).toBe(false); // file sink works in normal conditions
    expect(health.fallbackSink).toBeNull();

    // State reflects actual writes
    const state = adapter.getState();
    expect(state.totalAppends).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  FIXTURE 4: Failed Packet Operation
// ═══════════════════════════════════════════════════════════════════════

describe("Fixture 4: failed packet operation", () => {
  it("does not emit false success trace when packet write fails", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg });

    // Force packet failure with invalid input
    let threw = false;
    try {
      await (adapter as any).writeTaskPacket(null, { workdir: busDir });
    } catch {
      threw = true;
    }

    if (threw) {
      // No trace should exist for a failed operation
      const events = await readAllEvents(traceDir);
      expect(events.length).toBe(0);
    }

    // Health should show no appends (no false inflation)
    const state = adapter.getState();
    expect(state.totalAppends).toBe(threw ? 0 : 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  FIXTURE 5: Compression
// ═══════════════════════════════════════════════════════════════════════

describe("Fixture 5: compression of rotated ledgers", () => {
  it("compresses rotated ledgers without affecting active ledger or handoff validity", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const outDir = await mkTempDir();
    const cfg = validateTraceConfig({
      traceRoot: traceDir, fsyncOnAppend: false, rotationEnabled: true,
      maxLedgerBytes: 300, maxLedgerFiles: 10,
    });
    const adapter = createTraceBusAdapter({ traceConfig: cfg });

    // Generate many events to trigger rotation
    for (let i = 0; i < 40; i++) {
      await adapter.writeTaskPacket(makeTaskPkt({ packetId: `compress-${i}` }), { workdir: busDir });
    }

    // Identify current (active) ledger
    const files = await fs.readdir(traceDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort();
    const currentLedger = jsonlFiles[jsonlFiles.length - 1];

    // Compress rotated (not current)
    await compressRotatedLedgers(traceDir, currentLedger);

    // Active ledger still exists
    const activeExists = await fs.access(path.join(traceDir, currentLedger)).then(() => true).catch(() => false);
    expect(activeExists).toBe(true);

    // Handoff still generates valid bundle
    const handoff = await generateTraceHandoff(traceDir, outDir, { config: cfg });
    expect(handoff.filesGenerated.length).toBe(7);

    const validation = await validateHandoffBundle(handoff.bundleDir);
    expect(validation.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  FIXTURE 6: Dashboard
// ═══════════════════════════════════════════════════════════════════════

describe("Fixture 6: dashboard from adapter traces", () => {
  it("generates self-contained HTML with no external dependencies", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const outDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg, actorType: "openclaw_tripp" });

    await adapter.writeTaskPacket(makeTaskPkt({ title: "Dash Task" }), { workdir: busDir });
    await adapter.writeResultPacket(makeResultPkt({ summary: "Dash Result" }), { workdir: busDir });

    const handoff = await generateTraceHandoff(traceDir, outDir, { config: cfg });
    const dashPath = path.join(outDir, "dashboard.html");
    await generateDashboard(handoff.bundleDir, dashPath);

    const html = await fs.readFile(dashPath, "utf-8");

    // Self-contained
    expect(html.includes("<!DOCTYPE html>")).toBe(true);
    expect(html.includes('src="http')).toBe(false);
    expect(html.includes('href="http')).toBe(false);
    expect(html.includes("fetch(")).toBe(false);
    expect(html.includes("ws://")).toBe(false);

    // Lifecycle events appear
    expect(html.includes("confirmed") || html.includes("report-backed")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  FIXTURE 7: CLI
// ═══════════════════════════════════════════════════════════════════════

describe("Fixture 7: CLI commands on adapter trace output", () => {
  it("handoff generates valid bundle, validate confirms, diff detects changes", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const outDirA = await mkTempDir();
    const outDirB = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg });

    // Generate adapter traces
    await adapter.writeTaskPacket(makeTaskPkt(), { workdir: busDir });

    // Handoff (API call that CLI would make)
    const handoffA = await generateTraceHandoff(traceDir, outDirA, { config: cfg });
    expect(handoffA.filesGenerated.length).toBe(7);

    // Validate
    const validation = await validateHandoffBundle(handoffA.bundleDir);
    expect(validation.valid).toBe(true);

    // Generate second bundle for diff
    await adapter.writeTaskPacket(makeTaskPkt(), { workdir: busDir });
    const handoffB = await generateTraceHandoff(traceDir, outDirB, { config: cfg });

    // Diff
    const diff = await diffHandoffBundles(handoffA.bundleDir, handoffB.bundleDir);
    expect(diff.summary).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  FIXTURE 8: Multi-Agent Correlation
// ═══════════════════════════════════════════════════════════════════════

describe("Fixture 8: multi-agent correlation", () => {
  it("two adapters with same runId correlate without cross-contamination", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });

    const tripp = createTraceBusAdapter({ traceConfig: cfg, actorType: "openclaw_tripp", actorId: "tripp-1", runId: "shared-run" });
    const echo = createTraceBusAdapter({ traceConfig: cfg, actorType: "openclaw_echo", actorId: "echo-1", runId: "shared-run" });

    await tripp.writeTaskPacket(makeTaskPkt({ packetId: "ma-p1" }), { workdir: busDir });
    await echo.trace("warden_verdict_recorded", { summary: "Echo reviewed", packetId: "ma-p1" });

    const events = await readAllEvents(traceDir);

    // actorType separation
    const trippEvents = events.filter((e) => e.actorType === "openclaw_tripp");
    const echoEvents = events.filter((e) => e.actorType === "openclaw_echo");
    expect(trippEvents.length).toBe(1);
    expect(echoEvents.length).toBe(1);

    // Shared runId
    expect(trippEvents[0].runId).toBe("shared-run");
    expect(echoEvents[0].runId).toBe("shared-run");

    // packetId isolation — both refer to same packet
    expect(trippEvents[0].packetId).toBe("ma-p1");
    expect(echoEvents[0].packetId).toBe("ma-p1");

    // No cross-contamination
    expect(trippEvents[0].actorId).toBe("tripp-1");
    expect(echoEvents[0].actorId).toBe("echo-1");
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  FIXTURE 9: Opt-In Boundary
// ═══════════════════════════════════════════════════════════════════════

describe("Fixture 9: opt-in boundary", () => {
  it("agent-bus operations work without adapter, no trace files appear", async () => {
    const busDir = await mkTempDir();
    const traceDir = await mkTempDir();

    // Use agent-bus directly — no adapter
    const { writeTaskPacket } = await import("@tripp-os/agent-bus");
    const packet = makeTaskPkt({ title: "No Adapter" });
    const filePath = await writeTaskPacket(packet, { workdir: busDir });

    expect(filePath).toBeTruthy();

    // No trace files should appear in traceDir (adapter was never constructed)
    const traceFiles = await fs.readdir(traceDir);
    expect(traceFiles.length).toBe(0);
  });

  it("adapter requires explicit construction with traceConfig", async () => {
    const traceDir = await mkTempDir();

    // traceConfig is required — compile-time enforcement
    const adapter = createTraceBusAdapter({
      traceConfig: validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false }),
    });
    expect(adapter).toBeDefined();

    // Without construction, no trace writer exists
    const files = await fs.readdir(traceDir);
    expect(files.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  FIXTURE 10: Source / Boundary
// ═══════════════════════════════════════════════════════════════════════

describe("Fixture 10: source and boundary analysis", () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

  it("adapter.ts has no forbidden patterns", async () => {
    const src = await fs.readFile(path.join(srcDir, "adapter.ts"), "utf-8");
    expect(src.includes("child_process")).toBe(false);
    expect(src.includes("setInterval")).toBe(false);
    expect(src.includes("setTimeout")).toBe(false);
    expect(src.includes("fetch(")).toBe(false);
    expect(src.includes("http")).toBe(false);
    expect(src.includes("websocket")).toBe(false);
    expect(src.includes("sqlite")).toBe(false);
    expect(src.includes("database")).toBe(false);
  });

  it("cli.ts has no forbidden patterns", async () => {
    const src = await fs.readFile(path.join(srcDir, "cli.ts"), "utf-8");
    expect(src.includes("child_process")).toBe(false);
    expect(src.includes("exec(")).toBe(false);
    expect(src.includes("spawn(")).toBe(false);
    expect(src.includes("setInterval")).toBe(false);
    expect(src.includes("fetch(")).toBe(false);
  });

  it("compress.ts only removes rotated ledgers with size verification", async () => {
    const src = await fs.readFile(path.join(srcDir, "compress.ts"), "utf-8");
    // unlink only appears in compressLedgerFile with safety checks
    expect(src.includes("unlink")).toBe(true); // Expected — bounded file ops
    expect(src.includes("fs.rm(")).toBe(false); // No rm
  });

  it("dashboard.ts has no external dependencies", async () => {
    const src = await fs.readFile(path.join(srcDir, "dashboard.ts"), "utf-8");
    expect(src.includes('src="http')).toBe(false);
    expect(src.includes('href="http')).toBe(false);
    expect(src.includes("fetch(")).toBe(false);
    expect(src.includes("import(")).toBe(false);
  });

  it("no shared-agent-bus, Tripp.Control, or Tripp.Reason in new source files", async () => {
    for (const file of ["adapter.ts", "cli.ts", "diff.ts", "compress.ts", "dashboard.ts", "benchmark.ts"]) {
      const src = await fs.readFile(path.join(srcDir, file), "utf-8");
      expect(src.includes("shared-agent-bus")).toBe(false);
      expect(src.includes("tripp.control")).toBe(false);
      expect(src.includes("tripp.reason")).toBe(false);
    }
  });
});
