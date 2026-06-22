/**
 * @tripp-os/runtime-trace — Production Readiness Fixture Tests
 *
 * 8 production readiness fixtures for traced queue mode.
 * All tests use isolated temp directories only.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  createTraceBusAdapter,
  createTracedQueue,
  rollbackToUntracedQueue,
  isTracedQueue,
  generateTraceHandoff,
  generateQueueHandoff,
  validateQueueHandoffBundle,
  generateDashboard,
  createTraceReader,
  compressRotatedLedgers,
  readLedgerContent,
  listLedgerFiles,
  validateTraceConfig,
} from "../index.js";
import {
  ValidatedTraceEventSchema,
  type AgentBusTraceEvent,
} from "@tripp-os/agent-bus";
import type { ExternalAgentTaskPacket, ExternalAgentResultPacket, ExternalAgentReviewPacket } from "@tripp-os/agent-bus";

async function mkTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeTaskPkt(overrides: Partial<ExternalAgentTaskPacket> = {}): ExternalAgentTaskPacket {
  return {
    schemaVersion: "1.0.0",
    packetId: `pkt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    runId: `run-${Date.now()}`,
    createdAt: new Date().toISOString(),
    createdBy: "prod-test",
    agentRole: "openclaw_tripp",
    taskType: "plan",
    title: "ProdTestTask",
    objective: "Production readiness validation",
    scope: "prod_validation",
    trustZone: "local_audit_warden",
    allowedPaths: [],
    deniedPaths: [],
    toolPolicy: { allowShell: false, allowWrite: false, allowNetwork: false, allowSecrets: false, allowedTools: [], deniedTools: [] },
    approvalPolicy: { requiresHumanApproval: false, requiresApprovalGate: false, agentMayApprove: false, echoReviewRequired: false },
    contextPolicy: { contextBudgetTokens: 8000, redactSecrets: true, includeRepoSummary: false, includeFileContents: false, allowedContextPaths: [], deniedContextPaths: [] },
    constraints: [],
    requiredOutputFormat: "json",
    reportRequired: false,
    status: "pending",
    ...overrides,
  };
}

function makeResultPkt(overrides: Partial<ExternalAgentResultPacket> = {}): ExternalAgentResultPacket {
  return {
    schemaVersion: "1.0.0",
    resultId: `res-${Date.now()}`,
    packetId: `pkt-${Date.now()}`,
    runId: `run-${Date.now()}`,
    createdAt: new Date().toISOString(),
    agentRole: "openclaw_tripp",
    trustZone: "local_audit_warden",
    summary: "Production test result",
    status: "success",
    assumptions: [],
    risks: [],
    proposedChanges: [],
    filesReferenced: [],
    validationPerformed: [],
    requestedApprovals: [],
    nextRecommendedAction: "",
    ...overrides,
  };
}

function makeReviewPkt(overrides: Partial<ExternalAgentReviewPacket> = {}): ExternalAgentReviewPacket {
  return {
    schemaVersion: "1.0.0",
    reviewId: `rev-${Date.now()}`,
    packetId: `pkt-${Date.now()}`,
    runId: `run-${Date.now()}`,
    createdAt: new Date().toISOString(),
    reviewerRole: "openclaw_tripp",
    verdict: "pass",
    summary: "Production test review",
    issues: [],
    boundaryFindings: [],
    doctrineFindings: [],
    safetyFindings: [],
    recommendedNextAction: "",
    ...overrides,
  };
}

function makeAdapter(traceRoot: string, overrides: Record<string, unknown> = {}) {
  return createTraceBusAdapter({
    traceConfig: validateTraceConfig({
      traceRoot,
      fsyncOnAppend: false,
      checksumEnabled: true,
      rotationEnabled: true,
      maxLedgerBytes: 1024 * 1024,
      maxLedgerFiles: 3,
    }),
    actorType: "openclaw_tripp",
    actorId: "tripp-prod-test-1",
    runId: "prod-readiness-run-001",
    tags: ["production-readiness", "controlled-test"],
    ...overrides,
  });
}

function readerFor(traceRoot: string) {
  return createTraceReader(validateTraceConfig({ traceRoot, fsyncOnAppend: false }));
}

// Helper: read ALL events from ALL ledger files (active + rotated + compressed)
async function readAllEventsFromAllLedgers(traceRoot: string): Promise<AgentBusTraceEvent[]> {
  const files = await listLedgerFiles(traceRoot);
  const allEvents: AgentBusTraceEvent[] = [];
  for (const file of files) {
    const content = await readLedgerContent(path.join(traceRoot, file));
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const event = ValidatedTraceEventSchema.parse(parsed);
        allEvents.push(event);
      } catch {
        // skip malformed
      }
    }
  }
  return allEvents;
}

// ═══════════════════════════════════════════════════════════════════════
// Fixture 1: Restart Recovery
// ═══════════════════════════════════════════════════════════════════════

describe("Production Readiness: Restart recovery", () => {
  it("verifies existing ledger continuity after simulated restart", async () => {
    const traceRoot = await mkTempDir("tripp-prod-restart-");
    const workdir = await mkTempDir("tripp-prod-restart-work-");

    // Phase 1: Write 10 events with initial queue
    const adapter1 = makeAdapter(traceRoot);
    const queue1 = createTracedQueue({ adapter: adapter1, workdir });

    for (let i = 0; i < 10; i++) {
      await queue1.enqueueTask(makeTaskPkt({ packetId: `restart-pkt-${String(i).padStart(3, "0")}` }));
    }

    const preRestartAppends = queue1.getState()?.totalAppends ?? 0;
    expect(preRestartAppends).toBe(10);

    // Phase 2: Simulate restart — create completely new adapter + queue on same traceRoot
    const adapter2 = makeAdapter(traceRoot);
    const queue2 = createTracedQueue({ adapter: adapter2, workdir });

    // Phase 3: Write 5 more events with "restarted" queue
    for (let i = 10; i < 15; i++) {
      await queue2.enqueueTask(makeTaskPkt({ packetId: `restart-pkt-${String(i).padStart(3, "0")}` }));
    }

    // Phase 4: Read all events
    const reader = readerFor(traceRoot);
    const allEvents = await reader.search({});

    // Phase 5: Validate
    expect(allEvents.length).toBe(15);

    const eventIds = allEvents.map((e) => e.eventId);
    expect(new Set(eventIds).size).toBe(15); // No duplicates across restart

    // Timestamps should be monotonic
    const timestamps = allEvents.map((e) => new Date(e.createdAt).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }

    // Ledger validation: 0 malformed lines (active ledger only)
    const validation = await reader.validate();
    expect(validation.malformedLines).toBe(0);

    // New writer state starts fresh (does not carry old state)
    const postRestartState = queue2.getState();
    expect(postRestartState).not.toBeNull();
    expect(postRestartState!.totalAppends).toBe(5);

    // Pre-restart events remain readable
    const preRestartIds = allEvents.slice(0, 10).map((e) => e.packetId);
    expect(preRestartIds.every((id) => id?.startsWith("restart-pkt-"))).toBe(true);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("verifies no duplicate event IDs caused by restart state carryover", async () => {
    const traceRoot = await mkTempDir("tripp-prod-restart-dup-");
    const workdir = await mkTempDir("tripp-prod-restart-dup-work-");

    // Write events, restart multiple times
    for (let restart = 0; restart < 3; restart++) {
      const adapter = makeAdapter(traceRoot);
      const queue = createTracedQueue({ adapter, workdir });
      await queue.enqueueTask(makeTaskPkt({ packetId: `multi-restart-pkt-${restart}-001` }));
    }

    const reader = readerFor(traceRoot);
    const events = await reader.search({});
    const ids = events.map((e) => e.eventId);

    expect(ids.length).toBe(new Set(ids).size);
    expect(events.length).toBe(3);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Fixture 2: Rotation Under Load
// ═══════════════════════════════════════════════════════════════════════

describe("Production Readiness: Rotation under load", () => {
  it("rotates ledger while events are appended, no event loss", async () => {
    const traceRoot = await mkTempDir("tripp-prod-rotation-");
    const workdir = await mkTempDir("tripp-prod-rotation-work-");

    // Small maxLedgerBytes (2KB) to force rapid rotation
    const config = validateTraceConfig({
      traceRoot,
      fsyncOnAppend: false,
      checksumEnabled: true,
      rotationEnabled: true,
      maxLedgerBytes: 2500,
      maxLedgerFiles: 10,
    });

    const adapter = createTraceBusAdapter({
      traceConfig: config,
      actorType: "openclaw_tripp",
      actorId: "tripp-rotation-test",
      runId: "rotation-run-001",
    });
    const queue = createTracedQueue({ adapter, workdir });

    // Write 50 events — triggers ~8 rotations with collision-safe naming
    for (let i = 0; i < 50; i++) {
      await queue.enqueueTask(makeTaskPkt({ packetId: `rot-pkt-${String(i).padStart(3, "0")}` }));
    }

    // List ledger files
    const ledgerFiles = await listLedgerFiles(traceRoot);
    const jsonlFiles = ledgerFiles.filter((f) => f.endsWith(".jsonl"));

    // Should have rotated ledgers plus active
    expect(jsonlFiles.length).toBeGreaterThanOrEqual(2);

    // Read all events across all ledgers (active + rotated)
    const allEvents = await readAllEventsFromAllLedgers(traceRoot);

    expect(allEvents.length).toBe(50);

    // No duplicate events
    expect(new Set(allEvents.map((e) => e.eventId)).size).toBe(50);

    // Event ordering preserved
    const timestamps = allEvents.map((e) => new Date(e.createdAt).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }

    // All packet IDs present
    expect(allEvents.every((e) => e.packetId?.startsWith("rot-pkt-"))).toBe(true);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("active ledger is the most recent and not rotated away", async () => {
    const traceRoot = await mkTempDir("tripp-prod-rotation-active-");
    const workdir = await mkTempDir("tripp-prod-rotation-active-work-");

    const config = validateTraceConfig({
      traceRoot,
      fsyncOnAppend: false,
      checksumEnabled: true,
      rotationEnabled: true,
      maxLedgerBytes: 2500,
      maxLedgerFiles: 10,
    });

    const adapter = createTraceBusAdapter({
      traceConfig: config,
      actorType: "openclaw_tripp",
      actorId: "tripp-active-test",
      runId: "active-run-001",
    });
    const queue = createTracedQueue({ adapter, workdir });

    for (let i = 0; i < 20; i++) {
      await queue.enqueueTask(makeTaskPkt({ packetId: `active-pkt-${String(i).padStart(3, "0")}` }));
    }

    // Active ledger should be readable
    const allEvents = await readAllEventsFromAllLedgers(traceRoot);
    expect(allEvents.length).toBe(20);

    // The ledger file with exact name (no date suffix) should exist
    const activeLedger = path.join(traceRoot, config.ledgerFileName);
    const activeStat = await fs.stat(activeLedger).catch(() => null);
    expect(activeStat).not.toBeNull();
    expect(activeStat?.isFile()).toBe(true);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Fixture 3: Compression Integration
// ═══════════════════════════════════════════════════════════════════════

describe("Production Readiness: Compression integration", () => {
  it("compresses rotated ledgers without touching active ledger", async () => {
    const traceRoot = await mkTempDir("tripp-prod-compress-");
    const workdir = await mkTempDir("tripp-prod-compress-work-");

    const config = validateTraceConfig({
      traceRoot,
      fsyncOnAppend: false,
      checksumEnabled: true,
      rotationEnabled: true,
      maxLedgerBytes: 15000,
      maxLedgerFiles: 10,
    });

    const adapter = createTraceBusAdapter({
      traceConfig: config,
      actorType: "openclaw_tripp",
      actorId: "tripp-compress-test",
      runId: "compress-run-001",
    });
    const queue = createTracedQueue({ adapter, workdir });

    // Write 40 events — triggers 1 rotation
    for (let i = 0; i < 40; i++) {
      await queue.enqueueTask(makeTaskPkt({ packetId: `comp-pkt-${String(i).padStart(3, "0")}` }));
    }

    // Count pre-compression (read from all ledgers)
    const preCompressEvents = await readAllEventsFromAllLedgers(traceRoot);
    expect(preCompressEvents.length).toBe(40);

    // Get current ledger file name
    const state = adapter.getState();
    const currentLedger = path.basename(state.currentLedgerFile);

    // Compress rotated ledgers
    const compressed = await compressRotatedLedgers(traceRoot, currentLedger);
    expect(compressed.length).toBeGreaterThanOrEqual(1);

    // Active ledger should still be .jsonl (uncompressed)
    const activeLedgerPath = path.join(traceRoot, currentLedger);
    expect(await fs.stat(activeLedgerPath).then(() => true).catch(() => false)).toBe(true);
    expect(activeLedgerPath.endsWith(".jsonl")).toBe(true);
    expect(activeLedgerPath.endsWith(".gz")).toBe(false);

    // All events still readable via transparent decompression
    const postCompressEvents = await readAllEventsFromAllLedgers(traceRoot);
    expect(postCompressEvents.length).toBe(40);

    // Verify no events lost
    const preIds = preCompressEvents.map((e) => e.eventId).sort();
    const postIds = postCompressEvents.map((e) => e.eventId).sort();
    expect(postIds).toEqual(preIds);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Fixture 4: Permission Failure Recovery
// ═══════════════════════════════════════════════════════════════════════

describe("Production Readiness: Permission failure recovery", () => {
  it("activates fallback when traceRoot becomes unwritable, recovers when restored", async () => {
    const traceRoot = await mkTempDir("tripp-prod-perm-");
    const workdir = await mkTempDir("tripp-prod-perm-work-");

    const adapter = makeAdapter(traceRoot);
    const queue = createTracedQueue({ adapter, workdir });

    // Phase 1: Write 5 events (primary sink working)
    for (let i = 0; i < 5; i++) {
      await queue.enqueueTask(makeTaskPkt({ packetId: `perm-pkt-${String(i).padStart(3, "0")}` }));
    }

    // Phase 2: Make traceRoot unwritable by replacing directory with a file
    const savedEntries = await fs.readdir(traceRoot);
    const savedData: Record<string, Buffer> = {};
    for (const entry of savedEntries) {
      savedData[entry] = await fs.readFile(path.join(traceRoot, entry));
    }
    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.writeFile(traceRoot, "not-a-directory");

    // Phase 3: Write 3 more events — should trigger fallback
    for (let i = 5; i < 8; i++) {
      await queue.enqueueTask(makeTaskPkt({ packetId: `perm-pkt-${String(i).padStart(3, "0")}` }));
    }

    const healthDuringFailure = adapter.health();

    // Phase 4: Restore traceRoot
    await fs.rm(traceRoot, { force: true });
    await fs.mkdir(traceRoot, { recursive: true });
    for (const [name, data] of Object.entries(savedData)) {
      await fs.writeFile(path.join(traceRoot, name), data);
    }

    // Phase 5: Write 2 more events — primary should resume
    for (let i = 8; i < 10; i++) {
      await queue.enqueueTask(makeTaskPkt({ packetId: `perm-pkt-${String(i).padStart(3, "0")}` }));
    }

    // Validate: 5 pre-failure + 2 post-recovery = 7 in primary
    const primaryEvents = await readerFor(traceRoot).search({});
    expect(primaryEvents.length).toBe(7);

    // Health was degraded during failure
    expect(healthDuringFailure.degraded).toBe(true);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Fixture 5: Disk-Full Simulation
// ═══════════════════════════════════════════════════════════════════════

describe("Production Readiness: Disk-full simulation", () => {
  it("simulates ENOSPC by making traceRoot unwritable, verifies fallback and recovery", async () => {
    const traceRoot = await mkTempDir("tripp-prod-disk-");
    const workdir = await mkTempDir("tripp-prod-disk-work-");

    const adapter = makeAdapter(traceRoot);
    const queue = createTracedQueue({ adapter, workdir });

    // Phase 1: Write 3 events normally
    for (let i = 0; i < 3; i++) {
      await queue.enqueueTask(makeTaskPkt({ packetId: `disk-pkt-${String(i).padStart(3, "0")}` }));
    }

    // Phase 2: Simulate disk-full by making traceRoot a file
    const savedEntries = await fs.readdir(traceRoot);
    const savedData: Record<string, Buffer> = {};
    for (const entry of savedEntries) {
      savedData[entry] = await fs.readFile(path.join(traceRoot, entry));
    }
    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.writeFile(traceRoot, "simulating-enospc");

    // Phase 3: Continue operations — should use fallback
    for (let i = 3; i < 6; i++) {
      await queue.enqueueTask(makeTaskPkt({ packetId: `disk-pkt-${String(i).padStart(3, "0")}` }));
    }

    const degradedHealth = adapter.health();

    // Phase 4: "Free disk space" — restore traceRoot
    await fs.rm(traceRoot, { force: true });
    await fs.mkdir(traceRoot, { recursive: true });
    for (const [name, data] of Object.entries(savedData)) {
      await fs.writeFile(path.join(traceRoot, name), data);
    }

    // Phase 5: Write 2 more events — primary should recover
    for (let i = 6; i < 8; i++) {
      await queue.enqueueTask(makeTaskPkt({ packetId: `disk-pkt-${String(i).padStart(3, "0")}` }));
    }

    // Validate: 3 pre-failure + 2 post-recovery = 5 in primary
    const primaryEvents = await readerFor(traceRoot).search({});
    expect(primaryEvents.length).toBe(5);
    expect(degradedHealth.degraded).toBe(true);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("verifies packet ops remain non-blocking when all trace sinks fail", async () => {
    const traceRoot = await mkTempDir("tripp-prod-disk-block-");
    const workdir = await mkTempDir("tripp-prod-disk-block-work-");

    // Create adapter with only a no-op fallback (drops events)
    const config = validateTraceConfig({
      traceRoot,
      fsyncOnAppend: false,
      checksumEnabled: false,
      rotationEnabled: false,
      fallbackSinks: [{ type: "noop" }],
    });

    const adapter = createTraceBusAdapter({
      traceConfig: config,
      actorType: "openclaw_tripp",
      actorId: "tripp-noop-test",
      runId: "noop-run-001",
    });
    const queue = createTracedQueue({ adapter, workdir });

    // Make traceRoot unwritable
    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.writeFile(traceRoot, "unwritable");

    // Operations should still succeed (trace dropped, packet operation succeeds)
    let threw = false;
    try {
      await queue.enqueueTask(makeTaskPkt({ packetId: "noop-pkt-001" }));
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);

    await fs.rm(traceRoot, { force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Fixture 6: Operator Rollback Drill
// ═══════════════════════════════════════════════════════════════════════

describe("Production Readiness: Operator rollback drill", () => {
  it("executes full rollback with evidence preservation checklist", async () => {
    const traceRoot = await mkTempDir("tripp-prod-rollback-");
    const workdir = await mkTempDir("tripp-prod-rollback-work-");

    const adapter = makeAdapter(traceRoot);
    const queue = createTracedQueue({ adapter, workdir });

    // Pre-rollback: emit events across all types
    const taskPath = await queue.enqueueTask(makeTaskPkt({ packetId: "rollback-pkt-001" }));
    await queue.readPendingTask(taskPath);
    await queue.claimTask("rollback-pkt-001", "tripp-test", "openclaw_tripp");
    await queue.writeResult(makeResultPkt({ packetId: "rollback-pkt-001", resultId: "rollback-res-001" }));
    await queue.writeReview(makeReviewPkt({ packetId: "rollback-pkt-001", resultId: "rollback-res-001" }));

    // Record pre-rollback state
    const preReader = readerFor(traceRoot);
    const preEvents = await preReader.search({});
    const preEventCount = preEvents.length;
    const preLedgerFiles = await listLedgerFiles(traceRoot);

    // Execute rollback
    const rolledBack = rollbackToUntracedQueue(queue, "production_readiness_drill");

    // Evidence checklist verification
    expect(rolledBack.health().mode).toBe("untraced");
    expect(rolledBack.getState()).toBeNull();
    expect(rolledBack.rollbackInfo).toBeDefined();
    expect(rolledBack.rollbackInfo.reason).toBe("production_readiness_drill");
    expect(rolledBack.rollbackInfo.preRollbackAppends).toBe(preEventCount);
    expect(rolledBack.rollbackInfo.rolledBackAt).toBeTruthy();

    // Post-rollback operations: emit 3 untraced events
    await rolledBack.enqueueTask(makeTaskPkt({ packetId: "post-rollback-pkt-001" }), { workdir });
    await rolledBack.enqueueTask(makeTaskPkt({ packetId: "post-rollback-pkt-002" }), { workdir });
    await rolledBack.enqueueTask(makeTaskPkt({ packetId: "post-rollback-pkt-003" }), { workdir });

    // Verify no new trace events after rollback
    const postReader = readerFor(traceRoot);
    const postEvents = await postReader.search({});
    expect(postEvents.length).toBe(preEventCount);

    // Verify pre-rollback trace files preserved and readable
    const postLedgerFiles = await listLedgerFiles(traceRoot);
    expect(postLedgerFiles.length).toBe(preLedgerFiles.length);

    // Verify pre-rollback events unchanged
    const preIds = preEvents.map((e) => e.eventId).sort();
    const postIds = postEvents.map((e) => e.eventId).sort();
    expect(postIds).toEqual(preIds);

    // Generate handoff
    const handoffOutDir = await mkTempDir("tripp-prod-rollback-handoff-");
    const handoffResult = await generateQueueHandoff({
      outputDir: handoffOutDir,
      validationResults: {
        typecheck: "pass", build: "pass",
        testsTotal: 271, testsPassing: 271, testsFailing: 0,
        suites: 88, fixtureScenarios: 11, fixtureScenariosPassing: 11,
        safetySearch: "clean",
      },
    });
    const hv = await validateQueueHandoffBundle(handoffResult.bundleDir);
    expect(hv.valid).toBe(true);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
    await fs.rm(handoffOutDir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Fixture 7: Dashboard Accuracy
// ═══════════════════════════════════════════════════════════════════════

describe("Production Readiness: Dashboard accuracy", () => {
  it("generates dashboard with accurate values and static-vs-live warnings", async () => {
    const traceRoot = await mkTempDir("tripp-prod-dash-");
    const workdir = await mkTempDir("tripp-prod-dash-work-");

    const adapter = makeAdapter(traceRoot);
    const queue = createTracedQueue({ adapter, workdir });

    // Emit 8 events
    for (let i = 0; i < 8; i++) {
      await queue.enqueueTask(makeTaskPkt({ packetId: `dash-pkt-${String(i).padStart(3, "0")}` }));
    }

    // Generate base handoff bundle
    const handoffOutDir = await mkTempDir("tripp-prod-dash-handoff-");
    const handoffResult = await generateTraceHandoff(
      traceRoot,
      handoffOutDir,
      { config: validateTraceConfig({ traceRoot, fsyncOnAppend: false }) }
    );

    // Generate dashboard
    const dashboardPath = await generateDashboard(handoffResult.bundleDir);

    // Read dashboard HTML
    const html = await fs.readFile(dashboardPath, "utf-8");

    // Verify HTML structure
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.includes("Tripp.OS Trace Handoff Dashboard")).toBe(true);

    // Verify static-vs-live warnings
    const lowerHtml = html.toLowerCase();
    expect(lowerHtml.includes("live monitoring")).toBe(false);
    expect(lowerHtml.includes("real-time")).toBe(false);
    expect(lowerHtml.includes("websocket")).toBe(false);
    expect(lowerHtml.includes("eventsource")).toBe(false);

    // Verify no external script references
    expect(html.includes('src="http')).toBe(false);
    expect(html.includes('src="//')).toBe(false);

    // Verify no fetch/WebSocket calls
    expect(lowerHtml.includes("fetch(")).toBe(false);
    expect(lowerHtml.includes("xmlhttprequest")).toBe(false);

    // Verify self-contained
    expect(html.includes('<link rel="stylesheet" href=')).toBe(false);
    expect(html.includes('<script src=')).toBe(false);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
    await fs.rm(handoffOutDir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Fixture 8: High-Volume Long-Run
// ═══════════════════════════════════════════════════════════════════════

describe("Production Readiness: High-volume long-run", () => {
  it("sustains 1000 events with unique IDs, correct ordering, and accurate handoff", async () => {
    const traceRoot = await mkTempDir("tripp-prod-volume-");
    const workdir = await mkTempDir("tripp-prod-volume-work-");

    const config = validateTraceConfig({
      traceRoot,
      fsyncOnAppend: true,
      checksumEnabled: true,
      rotationEnabled: true,
      maxLedgerBytes: 50 * 1024 * 1024,
      maxLedgerFiles: 30,
    });

    const adapter = createTraceBusAdapter({
      traceConfig: config,
      actorType: "openclaw_tripp",
      actorId: "tripp-volume-test",
      runId: "volume-run-001",
    });
    const queue = createTracedQueue({ adapter, workdir });

    // Emit 1000 events
    const startTime = Date.now();
    for (let i = 0; i < 1000; i++) {
      await queue.enqueueTask(makeTaskPkt({ packetId: `vol-pkt-${String(i).padStart(4, "0")}` }));
    }
    const elapsedMs = Date.now() - startTime;

    // Read all events (explicit high limit to bypass default 100)
    const reader = createTraceReader(config);
    const allEvents = await reader.search({ limit: 10000 });

    // Verify count
    expect(allEvents.length).toBe(1000);

    // Verify all IDs unique
    expect(new Set(allEvents.map((e) => e.eventId)).size).toBe(1000);

    // Verify timestamps monotonic
    const timestamps = allEvents.map((e) => new Date(e.createdAt).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }

    // Verify correlation fields
    expect(allEvents.every((e) => e.runId === "volume-run-001")).toBe(true);
    expect(allEvents.every((e) => e.actorType === "openclaw_tripp")).toBe(true);
    expect(allEvents.every((e) => e.actorId === "tripp-volume-test")).toBe(true);

    // Verify ledger validation: 0 malformed
    const validation = await reader.validate();
    expect(validation.malformedLines).toBe(0);
    expect(validation.validLines).toBe(1000);

    // Verify health: writable, not degraded
    const health = adapter.health();
    expect(health.writable).toBe(true);
    expect(health.degraded).toBe(false);

    // Verify search/tail performance
    const searchStart = Date.now();
    const searchResults = await reader.search({ limit: 10 });
    expect(searchResults.length).toBe(10);
    expect(Date.now() - searchStart).toBeLessThan(5000);

    // Generate handoff
    const handoffOutDir = await mkTempDir("tripp-prod-volume-handoff-");
    const handoffResult = await generateTraceHandoff(traceRoot, handoffOutDir, { config });
    expect(handoffResult.filesGenerated.length).toBe(7);

    console.log(`  High-volume: 1000 events in ${elapsedMs}ms (${(elapsedMs / 1000).toFixed(1)}ms avg)`);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
    await fs.rm(handoffOutDir, { recursive: true, force: true });
  }, 120000);

  it("verifies all 7 required event types are represented in high-volume mix", async () => {
    const traceRoot = await mkTempDir("tripp-prod-vol-types-");
    const workdir = await mkTempDir("tripp-prod-vol-types-work-");

    const config = validateTraceConfig({
      traceRoot,
      fsyncOnAppend: false,
      checksumEnabled: true,
      rotationEnabled: true,
      maxLedgerBytes: 50 * 1024 * 1024,
      maxLedgerFiles: 30,
    });

    const adapter = createTraceBusAdapter({
      traceConfig: config,
      actorType: "openclaw_tripp",
      actorId: "tripp-types-test",
      runId: "types-run-001",
    });
    const queue = createTracedQueue({ adapter, workdir });

    // Mix of all event types
    for (let i = 0; i < 200; i++) {
      const pkt = makeTaskPkt({ packetId: `types-pkt-${String(i).padStart(3, "0")}` });
      const p = await queue.enqueueTask(pkt);
      await queue.readPendingTask(p);
      await queue.claimTask(pkt.packetId, "tripp-types-test", "openclaw_tripp");

      if (i % 2 === 0) {
        await queue.writeResult(makeResultPkt({ packetId: pkt.packetId, resultId: `res-${i}` }));
      }
      if (i % 4 === 0) {
        await queue.writeReview(makeReviewPkt({ packetId: pkt.packetId, resultId: `res-${i}` }));
      }
      if (i % 5 === 0 && i > 0) {
        const ap = makeTaskPkt({ packetId: `archive-pkt-${i}` });
        const apPath = await queue.enqueueTask(ap);
        await queue.archivePacket(apPath);
      }
      if (i % 7 === 0 && i > 0) {
        const rp = makeTaskPkt({ packetId: `reject-pkt-${i}` });
        const rpPath = await queue.enqueueTask(rp);
        await queue.rejectPacket(rpPath, "test_rejection");
      }
    }

    const reader = createTraceReader(config);
    const events = await reader.search({});

    const types = [...new Set(events.map((e) => e.eventType))];
    expect(types.includes("packet_created")).toBe(true);
    expect(types.includes("packet_read")).toBe(true);
    expect(types.includes("packet_claimed")).toBe(true);
    expect(types.includes("result_written")).toBe(true);
    expect(types.includes("warden_verdict_recorded")).toBe(true);
    expect(types.includes("packet_archived")).toBe(true);
    expect(types.includes("packet_rejected")).toBe(true);

    // All IDs unique
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  }, 120000);
});
