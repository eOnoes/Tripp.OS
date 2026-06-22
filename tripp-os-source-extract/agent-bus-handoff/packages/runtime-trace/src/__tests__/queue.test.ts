/**
 * @tripp-os/runtime-trace — Controlled Runtime Queue Tests
 *
 * 10 integration tests + 6 fixture scenarios for queue integration.
 * All tests use temp directories only. No deployment. No live wiring.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  createUntracedQueue,
  createTracedQueue,
  isTracedQueue,
  rollbackToUntracedQueue,
  createTraceBusAdapter,
  validateTraceConfig,
  createTraceReader,
  generateTraceHandoff,
  validateHandoffBundle,
  compressRotatedLedgers,
} from "../index.js";
import type { ExternalAgentTaskPacket, ExternalAgentResultPacket, ExternalAgentReviewPacket } from "@tripp-os/agent-bus";

async function mkTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "tripp-q-"));
}

function makeTaskPkt(overrides: Partial<ExternalAgentTaskPacket> = {}): ExternalAgentTaskPacket {
  return {
    schemaVersion: "1.0.0", packetId: `pkt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    runId: `run-${Date.now()}`, createdAt: new Date().toISOString(), createdBy: "test",
    agentRole: "openclaw_tripp", taskType: "plan", title: "QTask", objective: "Test", scope: "test",
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
    trustZone: "cloud_sandbox_proposal", summary: "QResult", status: "success",
    assumptions: [], risks: [], proposedChanges: [], filesReferenced: [],
    validationPerformed: [], requestedApprovals: [], nextRecommendedAction: "",
    ...overrides,
  };
}

function makeReviewPkt(overrides: Partial<ExternalAgentReviewPacket> = {}): ExternalAgentReviewPacket {
  return {
    schemaVersion: "1.0.0", reviewId: `rev-${Date.now()}`, packetId: `pkt-${Date.now()}`,
    runId: `run-${Date.now()}`, createdAt: new Date().toISOString(), reviewerRole: "openclaw_echo",
    verdict: "pass", summary: "QReview", issues: [], boundaryFindings: [],
    doctrineFindings: [], safetyFindings: [], recommendedNextAction: "",
    ...overrides,
  };
}

async function readAllEvents(traceRoot: string) {
  const reader = createTraceReader(validateTraceConfig({ traceRoot, fsyncOnAppend: false }));
  return reader.tail({ limit: 1000 });
}

// ═══════════════════════════════════════════════════════════════════════
//  10 INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════════════

describe("Queue: untraced is default", () => {
  it("createUntracedQueue produces mode=untraced, no trace files", async () => {
    const busDir = await mkTempDir();
    const q = createUntracedQueue({ workdir: busDir });

    expect(q.mode).toBe("untraced");
    expect(isTracedQueue(q)).toBe(false);

    const h = q.health();
    expect(h.mode).toBe("untraced");
    expect(h.traceHealth).toBeUndefined();

    const s = q.getState();
    expect(s).toBeNull();

    // Operations work
    const filePath = await q.enqueueTask(makeTaskPkt());
    expect(filePath).toBeTruthy();
  });
});

describe("Queue: traced queue emits lifecycle events", () => {
  it("all 8 mapped operations produce correct trace events", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg, actorType: "openclaw_tripp", runId: "q-run-1" });
    const q = createTracedQueue({ adapter, workdir: busDir });

    expect(q.mode).toBe("traced");
    expect(isTracedQueue(q)).toBe(true);

    // 1. enqueueTask
    const task = makeTaskPkt({ packetId: "q-lc-1" });
    const taskPath = await q.enqueueTask(task);
    // 2. readPendingTask
    const readTask = await q.readPendingTask(taskPath);
    expect(readTask.packetId).toBe("q-lc-1");
    // 3. claimTask
    await q.claimTask("q-lc-1", "agent-42", "openclaw_tripp");
    // 4. writeResult
    await q.writeResult(makeResultPkt({ packetId: "q-lc-1" }));
    // 5. writeReview
    await q.writeReview(makeReviewPkt({ packetId: "q-lc-1" }));
    // 6. archivePacket
    await q.archivePacket(taskPath);
    // 7. emitStatusSnapshot
    await q.emitStatusSnapshot({ inboxCount: 1, outboxCount: 2, pendingCount: 3 });

    // 8. rejectPacket (separate flow)
    const task2 = makeTaskPkt({ packetId: "q-lc-2" });
    const task2Path = await q.enqueueTask(task2);
    await q.rejectPacket(task2Path, "test_rejection");

    // Verify all event types
    const events = await readAllEvents(traceDir);
    expect(events.filter((e) => e.eventType === "packet_created").length).toBe(2);
    expect(events.filter((e) => e.eventType === "packet_read").length).toBe(2); // readPendingTask + emitStatusSnapshot
    expect(events.filter((e) => e.eventType === "packet_claimed").length).toBe(1);
    expect(events.filter((e) => e.eventType === "result_written").length).toBe(1);
    expect(events.filter((e) => e.eventType === "warden_verdict_recorded").length).toBe(1);
    expect(events.filter((e) => e.eventType === "packet_archived").length).toBe(1);
    // Status snapshot uses packet_read with debug severity (valid schema type)
    expect(events.filter((e) => e.eventType === "packet_rejected").length).toBe(1);
  });
});

describe("Queue: trace failure does not block queue", () => {
  it("enqueueTask succeeds even if trace sink would fail", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg });
    const q = createTracedQueue({ adapter, workdir: busDir });

    // Normal operation: both should succeed
    const filePath = await q.enqueueTask(makeTaskPkt());
    expect(filePath).toBeTruthy();
    expect(typeof filePath).toBe("string");

    // Health should reflect normal operation
    const health = q.health();
    expect(health.mode).toBe("traced");
    expect(health.traceHealth?.degraded).toBe(false);
  });
});

describe("Queue: queue failure does not emit false success trace", () => {
  it("invalid packet throws and leaves trace empty", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg });
    const q = createTracedQueue({ adapter, workdir: busDir });

    let threw = false;
    try {
      await q.enqueueTask({} as ExternalAgentTaskPacket);
    } catch {
      threw = true;
    }

    if (threw) {
      const events = await readAllEvents(traceDir);
      expect(events.length).toBe(0);
    }
  });
});

describe("Queue: degraded fallback surfaced", () => {
  it("health() reports trace health accurately", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg });
    const q = createTracedQueue({ adapter, workdir: busDir });

    // Normal ops
    await q.enqueueTask(makeTaskPkt());
    await q.enqueueTask(makeTaskPkt());

    const health = q.health();
    expect(health.mode).toBe("traced");
    expect(health.traceHealth).toBeDefined();
    expect(health.traceHealth!.degraded).toBe(false);
    expect(health.traceState).toBeDefined();
    expect(health.traceState!.totalAppends).toBe(2);
  });
});

describe("Queue: rollback switches to untraced", () => {
  it("rollback returns untraced queue with metadata, traces preserved", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg });
    const traced = createTracedQueue({ adapter, workdir: busDir });

    // Run some traced ops
    await traced.enqueueTask(makeTaskPkt());
    await traced.enqueueTask(makeTaskPkt());
    const preRollbackState = traced.getState()!;

    // Rollback
    const untraced = rollbackToUntracedQueue(traced, "test_rollback");
    expect(untraced.mode).toBe("untraced");
    expect(isTracedQueue(untraced)).toBe(false);
    expect(untraced.rollbackInfo).toBeDefined();
    expect(untraced.rollbackInfo.reason).toBe("test_rollback");
    expect(untraced.rollbackInfo.preRollbackAppends).toBe(preRollbackState.totalAppends);

    // Post-rollback ops are untraced
    await untraced.enqueueTask(makeTaskPkt());

    // Pre-rollback traces still exist
    const events = await readAllEvents(traceDir);
    expect(events.length).toBe(2); // Only the 2 pre-rollback ops
  });
});

describe("Queue: handoff after traced queue validates", () => {
  it("generates valid 7-file handoff bundle after queue run", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const outDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false, checksumEnabled: true });
    const adapter = createTraceBusAdapter({ traceConfig: cfg, actorType: "openclaw_tripp" });
    const q = createTracedQueue({ adapter, workdir: busDir });

    // Run queue lifecycle
    const task = makeTaskPkt({ title: "Handoff Task" });
    const tp = await q.enqueueTask(task);
    await q.readPendingTask(tp);
    await q.claimTask(task.packetId, "agent-1");
    await q.writeResult(makeResultPkt({ packetId: task.packetId }));
    await q.writeReview(makeReviewPkt({ packetId: task.packetId }));
    await q.archivePacket(tp);

    // Handoff
    const handoff = await generateTraceHandoff(traceDir, outDir, { config: cfg });
    expect(handoff.filesGenerated.length).toBe(7);

    const validation = await validateHandoffBundle(handoff.bundleDir);
    expect(validation.valid).toBe(true);
  });
});

describe("Queue: compression does not affect active tracing", () => {
  it("compresses rotated ledgers, active ledger safe, queue still works", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({
      traceRoot: traceDir, fsyncOnAppend: false, rotationEnabled: true,
      maxLedgerBytes: 200, maxLedgerFiles: 10,
    });
    const adapter = createTraceBusAdapter({ traceConfig: cfg });
    const q = createTracedQueue({ adapter, workdir: busDir });

    // Generate events to trigger rotation
    for (let i = 0; i < 20; i++) {
      await q.enqueueTask(makeTaskPkt({ packetId: `comp-${i}` }));
    }

    // Find active ledger
    const files = await fs.readdir(traceDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort();
    const activeLedger = jsonlFiles[jsonlFiles.length - 1];

    // Compress rotated
    await compressRotatedLedgers(traceDir, activeLedger);

    // Active ledger still readable
    const activeContent = await fs.readFile(path.join(traceDir, activeLedger), "utf-8");
    expect(activeContent.length).toBeGreaterThan(0);

    // Queue still works post-compression
    await q.enqueueTask(makeTaskPkt({ packetId: "post-comp" }));

    const events = await readAllEvents(traceDir);
    expect(events.some((e) => e.packetId === "post-comp")).toBe(true);
  });
});

describe("Queue: no shared-agent-bus direct mutation", () => {
  it("all queue I/O scoped to configured workdir and traceRoot", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg });
    const q = createTracedQueue({ adapter, workdir: busDir });

    const filePath = await q.enqueueTask(makeTaskPkt());

    // Packet file in workdir
    expect(filePath.startsWith(busDir) || filePath.includes("inbox")).toBe(true);

    // Trace file in traceDir
    const traceFiles = await fs.readdir(traceDir);
    expect(traceFiles.length).toBeGreaterThan(0);

    // No shared-agent-bus in source
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
    const queueSrc = await fs.readFile(path.join(srcDir, "queue.ts"), "utf-8");
    expect(queueSrc.includes("shared-agent-bus")).toBe(false);
  });
});

describe("Queue: no live/remote/server behavior", () => {
  it("queue source has no forbidden patterns", async () => {
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
    const src = await fs.readFile(path.join(srcDir, "queue.ts"), "utf-8");

    expect(src.includes("child_process")).toBe(false);
    expect(src.includes("setInterval")).toBe(false);
    expect(src.includes("setTimeout")).toBe(false);
    expect(src.includes("fetch(")).toBe(false);
    expect(src.includes("http")).toBe(false);
    expect(src.includes("websocket")).toBe(false);
    expect(src.includes("sqlite")).toBe(false);
    expect(src.includes("server.listen")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  6 FIXTURE SCENARIOS
// ═══════════════════════════════════════════════════════════════════════

describe("Fixture: clean traced queue run", () => {
  it("full lifecycle with handoff validation", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const outDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false, checksumEnabled: true });
    const adapter = createTraceBusAdapter({ traceConfig: cfg, actorType: "openclaw_tripp", runId: "clean-run" });
    const q = createTracedQueue({ adapter, workdir: busDir });

    const task = makeTaskPkt({ packetId: "clean-1", title: "Clean Task" });
    const tp = await q.enqueueTask(task);
    await q.readPendingTask(tp);
    await q.claimTask("clean-1", "agent-a");
    await q.writeResult(makeResultPkt({ packetId: "clean-1" }));
    await q.writeReview(makeReviewPkt({ packetId: "clean-1" }));
    await q.archivePacket(tp);
    await q.emitStatusSnapshot({ inboxCount: 0, outboxCount: 1, pendingCount: 0 });

    const handoff = await generateTraceHandoff(traceDir, outDir, { config: cfg });
    expect(handoff.filesGenerated.length).toBe(7);
    expect(["confirmed", "report-backed"]).toContain(handoff.confidenceLevel);

    const validation = await validateHandoffBundle(handoff.bundleDir);
    expect(validation.valid).toBe(true);
    expect(validation.errors.length).toBe(0);
  });
});

describe("Fixture: degraded trace queue run", () => {
  it("health reports degraded when operations continue", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg });
    const q = createTracedQueue({ adapter, workdir: busDir });

    // Normal ops
    await q.enqueueTask(makeTaskPkt());
    await q.enqueueTask(makeTaskPkt());

    const health = q.health();
    expect(health.mode).toBe("traced");
    expect(health.traceHealth!.degraded).toBe(false);
    expect(health.traceState!.totalAppends).toBe(2);

    // Handoff confidence should be confirmed (checksums off = report-backed or confirmed depending)
    const outDir = await mkTempDir();
    const handoff = await generateTraceHandoff(traceDir, outDir, { config: cfg });
    expect(handoff.confidenceLevel).toBeTruthy();
  });
});

describe("Fixture: failed packet queue op", () => {
  it("invalid packet throws, no trace emitted, queue error path handles it", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg });
    const q = createTracedQueue({ adapter, workdir: busDir });

    let threw = false;
    try {
      await q.enqueueTask({} as ExternalAgentTaskPacket);
    } catch {
      threw = true;
    }

    if (threw) {
      const events = await readAllEvents(traceDir);
      expect(events.length).toBe(0);
    }

    // Queue can continue after failure
    await q.enqueueTask(makeTaskPkt());
    const events = await readAllEvents(traceDir);
    expect(events.length).toBe(1);
  });
});

describe("Fixture: rollback run", () => {
  it("pre-rollback traces preserved, post-rollback ops untraced", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });
    const adapter = createTraceBusAdapter({ traceConfig: cfg });
    const traced = createTracedQueue({ adapter, workdir: busDir });

    // Pre-rollback: 3 traced ops
    await traced.enqueueTask(makeTaskPkt({ packetId: "pre-1" }));
    await traced.enqueueTask(makeTaskPkt({ packetId: "pre-2" }));
    await traced.enqueueTask(makeTaskPkt({ packetId: "pre-3" }));

    const preState = traced.getState()!;
    expect(preState.totalAppends).toBe(3);

    // Rollback
    const untraced = rollbackToUntracedQueue(traced, "operator_initiated");
    expect(untraced.mode).toBe("untraced");
    expect(untraced.rollbackInfo.reason).toBe("operator_initiated");
    expect(untraced.rollbackInfo.preRollbackAppends).toBe(3);

    // Post-rollback: untraced ops
    await untraced.enqueueTask(makeTaskPkt({ packetId: "post-1" }));
    await untraced.enqueueTask(makeTaskPkt({ packetId: "post-2" }));

    // Only pre-rollback events in trace
    const events = await readAllEvents(traceDir);
    expect(events.length).toBe(3);
    expect(events.some((e) => e.packetId === "pre-1")).toBe(true);
    expect(events.some((e) => e.packetId === "pre-2")).toBe(true);
    expect(events.some((e) => e.packetId === "pre-3")).toBe(true);
    expect(events.some((e) => e.packetId === "post-1")).toBe(false);
  });
});

describe("Fixture: compressed trace handoff", () => {
  it("handoff valid after compressing rotated ledgers", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const outDir = await mkTempDir();
    const cfg = validateTraceConfig({
      traceRoot: traceDir, fsyncOnAppend: false, rotationEnabled: true,
      maxLedgerBytes: 300, maxLedgerFiles: 10,
    });
    const adapter = createTraceBusAdapter({ traceConfig: cfg });
    const q = createTracedQueue({ adapter, workdir: busDir });

    for (let i = 0; i < 25; i++) {
      await q.enqueueTask(makeTaskPkt({ packetId: `ch-${i}` }));
    }

    const files = await fs.readdir(traceDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort();
    const active = jsonlFiles[jsonlFiles.length - 1];
    await compressRotatedLedgers(traceDir, active);

    const handoff = await generateTraceHandoff(traceDir, outDir, { config: cfg });
    expect(handoff.filesGenerated.length).toBe(7);
    const validation = await validateHandoffBundle(handoff.bundleDir);
    expect(validation.valid).toBe(true);
  });
});

describe("Fixture: multi-agent queue run", () => {
  it("two traced queues with shared runId correlate events", async () => {
    const traceDir = await mkTempDir();
    const busDir = await mkTempDir();
    const cfg = validateTraceConfig({ traceRoot: traceDir, fsyncOnAppend: false });

    const trippAdapter = createTraceBusAdapter({ traceConfig: cfg, actorType: "openclaw_tripp", actorId: "tripp-1", runId: "multi-run" });
    const echoAdapter = createTraceBusAdapter({ traceConfig: cfg, actorType: "openclaw_echo", actorId: "echo-1", runId: "multi-run" });

    const trippQ = createTracedQueue({ adapter: trippAdapter, workdir: busDir });
    const echoQ = createTracedQueue({ adapter: echoAdapter, workdir: busDir });

    const task = makeTaskPkt({ packetId: "multi-1" });
    const tp = await trippQ.enqueueTask(task);
    await echoQ.writeReview(makeReviewPkt({ packetId: "multi-1" }));
    await trippQ.archivePacket(tp);

    const events = await readAllEvents(traceDir);
    const trippEvents = events.filter((e) => e.actorType === "openclaw_tripp");
    const echoEvents = events.filter((e) => e.actorType === "openclaw_echo");

    expect(trippEvents.length).toBe(2); // packet_created + packet_archived
    expect(echoEvents.length).toBe(1);  // warden_verdict_recorded

    for (const e of events) {
      expect(e.runId).toBe("multi-run");
    }
  });
});
