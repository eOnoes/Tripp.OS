/**
 * @tripp-os/runtime-trace — Rotation Hardening Tests
 *
 * Validates collision-safe rotation naming and cleanup.
 * All tests use isolated temp directories only.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  createTraceBusAdapter,
  createTracedQueue,
  createTraceReader,
  validateTraceConfig,
  listLedgerFiles,
  compressRotatedLedgers,
  readLedgerContent,
} from "../index.js";

async function mkTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeTaskPkt(packetId: string) {
  return {
    schemaVersion: "1.0.0" as const,
    packetId,
    runId: "rot-run-001",
    createdAt: new Date().toISOString(),
    createdBy: "rot-test",
    agentRole: "openclaw_tripp" as const,
    taskType: "plan" as const,
    title: "RotTest",
    objective: "Rotation hardening",
    scope: "rot_validation",
    trustZone: "local_audit_warden" as const,
    allowedPaths: [],
    deniedPaths: [],
    toolPolicy: { allowShell: false, allowWrite: false, allowNetwork: false, allowSecrets: false, allowedTools: [], deniedTools: [] },
    approvalPolicy: { requiresHumanApproval: false, requiresApprovalGate: false, agentMayApprove: false, echoReviewRequired: false },
    contextPolicy: { contextBudgetTokens: 8000, redactSecrets: true, includeRepoSummary: false, includeFileContents: false, allowedContextPaths: [], deniedContextPaths: [] },
    constraints: [],
    requiredOutputFormat: "json" as const,
    reportRequired: false,
    status: "pending" as const,
  };
}

function makeAdapter(traceRoot: string, maxLedgerBytes: number) {
  return createTraceBusAdapter({
    traceConfig: validateTraceConfig({
      traceRoot,
      fsyncOnAppend: false,
      checksumEnabled: true,
      rotationEnabled: true,
      maxLedgerBytes,
      maxLedgerFiles: 10,
    }),
    actorType: "openclaw_tripp",
    actorId: "tripp-rot-test",
    runId: "rot-run-001",
  });
}

// Helper: read events from ALL ledger files including rotated and compressed ones
async function readAllEvents(traceRoot: string) {
  const files = await listLedgerFiles(traceRoot);
  const allEvents: Array<Record<string, unknown>> = [];
  for (const file of files) {
    if (file.endsWith(".sha256")) continue;
    // Use readLedgerContent for transparent .gz decompression
    const content = await readLedgerContent(path.join(traceRoot, file));
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        allEvents.push(JSON.parse(line));
      } catch { /* skip malformed */ }
    }
  }
  return allEvents;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Same-day rotation overwrite prevention
// ═══════════════════════════════════════════════════════════════════════

describe("Rotation Hardening: same-day overwrite prevention", () => {
  it("produces unique rotated filenames for multiple same-day rotations", async () => {
    const traceRoot = await mkTempDir("tripp-rot-unique-");
    const workdir = await mkTempDir("tripp-rot-unique-work-");

    const adapter = makeAdapter(traceRoot, 1500); // ~3 events per rotation
    const queue = createTracedQueue({ adapter, workdir });

    // Write 15 events — should trigger 3-4 rotations
    for (let i = 0; i < 15; i++) {
      await queue.enqueueTask(makeTaskPkt(`unique-${String(i).padStart(3, "0")}`));
    }

    const files = await listLedgerFiles(traceRoot);
    const rotatedFiles = files.filter(
      (f) => f.startsWith("agent-bus-trace-") && f.endsWith(".jsonl") && f !== "agent-bus-trace.jsonl"
    );

    // Should have multiple rotated files
    expect(rotatedFiles.length).toBeGreaterThanOrEqual(2);

    // All rotated filenames must be unique
    expect(new Set(rotatedFiles).size).toBe(rotatedFiles.length);

    // No filename should contain bare date without time (old format)
    for (const f of rotatedFiles) {
      expect(f).toMatch(/agent-bus-trace-\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}\.jsonl/);
      // Must NOT match old date-only format
      expect(f).not.toMatch(/agent-bus-trace-\d{4}-\d{2}-\d{2}\.jsonl$/);
    }

    // All events preserved across all rotations
    const allEvents = await readAllEvents(traceRoot);
    expect(allEvents.length).toBe(15);

    // No duplicate events
    expect(new Set(allEvents.map((e) => (e as { eventId: string }).eventId)).size).toBe(15);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("does not overwrite an existing rotated ledger on repeated rotation", async () => {
    const traceRoot = await mkTempDir("tripp-rot-no-overwrite-");
    const workdir = await mkTempDir("tripp-rot-no-overwrite-work-");

    const adapter = makeAdapter(traceRoot, 1000); // small to trigger rapid rotation
    const queue = createTracedQueue({ adapter, workdir });

    // Write events in rapid succession to trigger multiple rotations
    const eventCounts: number[] = [];
    for (let batch = 0; batch < 5; batch++) {
      for (let i = 0; i < 3; i++) {
        await queue.enqueueTask(makeTaskPkt(`noov-${batch}-${i}`));
      }
      // Small delay to ensure different millisecond timestamps
      await new Promise((r) => setTimeout(r, 15));
      const events = await readAllEvents(traceRoot);
      eventCounts.push(events.length);
    }

    // All batches should have cumulative event count (no overwrites)
    expect(eventCounts[0]).toBe(3);
    expect(eventCounts[1]).toBe(6);
    expect(eventCounts[2]).toBe(9);
    expect(eventCounts[3]).toBe(12);
    expect(eventCounts[4]).toBe(15);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Rotation cleanup pattern
// ═══════════════════════════════════════════════════════════════════════

describe("Rotation Hardening: cleanup retention", () => {
  it("retains newest rotated files and deletes oldest when over maxLedgerFiles", async () => {
    const traceRoot = await mkTempDir("tripp-rot-cleanup-");
    const workdir = await mkTempDir("tripp-rot-cleanup-work-");

    // maxLedgerFiles = 3: keep at most 3 rotated + 1 active
    const adapter = createTraceBusAdapter({
      traceConfig: validateTraceConfig({
        traceRoot,
        fsyncOnAppend: false,
        checksumEnabled: true,
        rotationEnabled: true,
        maxLedgerBytes: 600,
        maxLedgerFiles: 3,
      }),
      actorType: "openclaw_tripp",
      actorId: "tripp-cleanup",
      runId: "cleanup-run",
    });
    const queue = createTracedQueue({ adapter, workdir });

    // Write events with small delays to ensure different mtimes
    for (let i = 0; i < 20; i++) {
      await queue.enqueueTask(makeTaskPkt(`cleanup-${String(i).padStart(3, "0")}`));
      if (i % 4 === 0) await new Promise((r) => setTimeout(r, 20));
    }

    const files = await listLedgerFiles(traceRoot);
    const rotatedFiles = files.filter(
      (f) => f.startsWith("agent-bus-trace-") && f.endsWith(".jsonl") && f !== "agent-bus-trace.jsonl"
    );

    // Should have at most 3 rotated files (maxLedgerFiles)
    expect(rotatedFiles.length).toBeLessThanOrEqual(3);

    // Active ledger must always exist
    const activeExists = files.includes("agent-bus-trace.jsonl");
    expect(activeExists).toBe(true);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("never deletes unrelated files in traceRoot", async () => {
    const traceRoot = await mkTempDir("tripp-rot-unrelated-");
    const workdir = await mkTempDir("tripp-rot-unrelated-work-");

    // Create an unrelated file in traceRoot
    await fs.writeFile(path.join(traceRoot, "important-notes.txt"), "do not delete");
    await fs.writeFile(path.join(traceRoot, "config-backup.json"), "{}");

    const adapter = makeAdapter(traceRoot, 1000);
    const queue = createTracedQueue({ adapter, workdir });

    // Trigger multiple rotations
    for (let i = 0; i < 15; i++) {
      await queue.enqueueTask(makeTaskPkt(`unrel-${String(i).padStart(3, "0")}`));
    }

    // Unrelated files must still exist
    const notesContent = await fs.readFile(path.join(traceRoot, "important-notes.txt"), "utf-8");
    expect(notesContent).toBe("do not delete");

    const configContent = await fs.readFile(path.join(traceRoot, "config-backup.json"), "utf-8");
    expect(configContent).toBe("{}");

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("never deletes the active ledger during cleanup", async () => {
    const traceRoot = await mkTempDir("tripp-rot-active-safe-");
    const workdir = await mkTempDir("tripp-rot-active-safe-work-");

    // Very small maxLedgerBytes and maxLedgerFiles = 2
    const adapter = createTraceBusAdapter({
      traceConfig: validateTraceConfig({
        traceRoot,
        fsyncOnAppend: false,
        checksumEnabled: true,
        rotationEnabled: true,
        maxLedgerBytes: 600,
        maxLedgerFiles: 2,
      }),
      actorType: "openclaw_tripp",
      actorId: "tripp-act-safe",
      runId: "act-safe-run",
    });
    const queue = createTracedQueue({ adapter, workdir });

    // Write many events — many rotations, aggressive cleanup
    for (let i = 0; i < 30; i++) {
      await queue.enqueueTask(makeTaskPkt(`actsafe-${String(i).padStart(3, "0")}`));
    }

    // Active ledger must still exist and be readable
    const activeLedger = path.join(traceRoot, "agent-bus-trace.jsonl");
    const stat = await fs.stat(activeLedger).catch(() => null);
    expect(stat).not.toBeNull();
    expect(stat?.isFile()).toBe(true);

    // Can read events from active ledger
    const reader = createTraceReader(validateTraceConfig({ traceRoot, fsyncOnAppend: false }));
    const events = await reader.search({});
    expect(events.length).toBeGreaterThan(0);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Rotated checksum verification
// ═══════════════════════════════════════════════════════════════════════

describe("Rotation Hardening: rotated checksum verification", () => {
  it("generates checksum sidecars for rotated ledgers and verifies them", async () => {
    const traceRoot = await mkTempDir("tripp-rot-checksum-");
    const workdir = await mkTempDir("tripp-rot-checksum-work-");

    const adapter = makeAdapter(traceRoot, 1200);
    const queue = createTracedQueue({ adapter, workdir });

    // Write events to trigger rotation
    for (let i = 0; i < 10; i++) {
      await queue.enqueueTask(makeTaskPkt(`chk-${String(i).padStart(3, "0")}`));
    }

    const files = await listLedgerFiles(traceRoot);
    const rotatedFiles = files.filter(
      (f) => f.startsWith("agent-bus-trace-") && f.endsWith(".jsonl") && f !== "agent-bus-trace.jsonl"
    );

    // Should have at least 1 rotated file
    expect(rotatedFiles.length).toBeGreaterThanOrEqual(1);

    const reader = createTraceReader(validateTraceConfig({ traceRoot, fsyncOnAppend: false }));

    // Verify checksum for each rotated ledger
    for (const rotatedFile of rotatedFiles) {
      const rotatedPath = path.join(traceRoot, rotatedFile);
      const checksumFile = `${rotatedPath}.sha256`;

      // Checksum file must exist
      const checksumStat = await fs.stat(checksumFile).catch(() => null);
      expect(checksumStat).not.toBeNull();

      // Checksum content must match the ledger
      const checksumValid = await reader.verifyChecksum(rotatedPath);
      expect(checksumValid).toBe(true);
    }

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("verifies rotated ledgers can be compressed and read back", async () => {
    const traceRoot = await mkTempDir("tripp-rot-checksum-comp-");
    const workdir = await mkTempDir("tripp-rot-checksum-comp-work-");

    const adapter = makeAdapter(traceRoot, 1200);
    const queue = createTracedQueue({ adapter, workdir });

    for (let i = 0; i < 10; i++) {
      await queue.enqueueTask(makeTaskPkt(`chkcomp-${String(i).padStart(3, "0")}`));
    }

    // Count events before compression
    const preCompressCount = (await readAllEvents(traceRoot)).length;
    expect(preCompressCount).toBe(10);

    // Compress rotated ledgers
    const state = adapter.getState();
    const compressed = await compressRotatedLedgers(traceRoot, path.basename(state.currentLedgerFile));

    // Should have compressed at least 1 rotated ledger
    expect(compressed.length).toBeGreaterThanOrEqual(1);

    // All events still readable after compression
    const postCompressCount = (await readAllEvents(traceRoot)).length;
    expect(postCompressCount).toBe(10);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Event preservation across 2+ rotations
// ═══════════════════════════════════════════════════════════════════════

describe("Rotation Hardening: event preservation", () => {
  it("preserves all events across 3+ same-day rotations", async () => {
    const traceRoot = await mkTempDir("tripp-rot-preserve-");
    const workdir = await mkTempDir("tripp-rot-preserve-work-");

    // maxLedgerBytes forces rotation; maxLedgerFiles=20 generous to avoid cleanup
    const adapter = createTraceBusAdapter({
      traceConfig: validateTraceConfig({
        traceRoot,
        fsyncOnAppend: false,
        checksumEnabled: true,
        rotationEnabled: true,
        maxLedgerBytes: 900,
        maxLedgerFiles: 20,
      }),
      actorType: "openclaw_tripp",
      actorId: "tripp-preserve",
      runId: "preserve-run",
    });
    const queue = createTracedQueue({ adapter, workdir });

    // Write 30 events — should trigger 3+ rotations
    for (let i = 0; i < 30; i++) {
      await queue.enqueueTask(makeTaskPkt(`preserve-${String(i).padStart(3, "0")}`));
    }

    // Read all events from all ledgers
    const allEvents = await readAllEvents(traceRoot);
    expect(allEvents.length).toBe(30);

    // Verify ordering (timestamps monotonic)
    const timestamps = allEvents.map((e) => new Date((e as { createdAt: string }).createdAt).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }

    // Verify all packet IDs present
    const packetIds = allEvents.map((e) => (e as { packetId: string }).packetId);
    expect(packetIds.every((id) => id?.startsWith("preserve-"))).toBe(true);

    await fs.rm(traceRoot, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });
});
