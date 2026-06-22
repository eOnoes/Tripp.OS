/**
 * @tripp-os/runtime-trace — Benchmark Suite
 *
 * Run with: node dist/benchmark.js [duration-seconds]
 * Measures append throughput, rotation latency, search/tail latency,
 * and memory footprint.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { createTraceWriter, createTraceReader, validateTraceConfig } from "./index.js";
import type { CreateTraceEventInput } from "@tripp-os/agent-bus";

function makeEvent(idx: number): CreateTraceEventInput {
  return {
    eventType: "packet_created",
    severity: "info",
    actorType: "system",
    summary: `Benchmark event ${idx}`,
    tags: ["benchmark"],
  };
}

async function runBenchmark(durationSeconds: number): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tripp-bench-"));
  const config = validateTraceConfig({
    traceRoot: tmpDir,
    fsyncOnAppend: false,
    checksumEnabled: false,
    rotationEnabled: true,
    rotationInterval: "daily",
    maxLedgerBytes: 1 * 1024 * 1024, // 1 MiB for faster rotation
    maxLedgerFiles: 10,
  });

  console.log(`Benchmark: ${durationSeconds}s @ ${tmpDir}`);
  console.log(`Config: maxLedgerBytes=1MiB, fsync=false, checksums=false\n`);

  // ── 1. Append Throughput ────────────────────────────────────────────

  const writer = createTraceWriter(config);
  const appends: number[] = [];
  let totalAppends = 0;
  const startTime = performance.now();
  const deadline = startTime + durationSeconds * 1000;

  let batchStart = performance.now();
  let batchCount = 0;

  while (performance.now() < deadline) {
    const evStart = performance.now();
    await writer.append(makeEvent(totalAppends));
    const evEnd = performance.now();
    appends.push(evEnd - evStart);
    totalAppends++;
    batchCount++;

    // Report every 1000 events
    if (batchCount >= 1000) {
      const batchElapsed = performance.now() - batchStart;
      const batchRate = batchCount / (batchElapsed / 1000);
      process.stdout.write(`  ${totalAppends.toLocaleString()} events @ ${batchRate.toFixed(0)}/s\r`);
      batchStart = performance.now();
      batchCount = 0;
    }
  }

  const elapsed = (performance.now() - startTime) / 1000;
  const appendTimes = appends.sort((a, b) => a - b);
  const p50 = appendTimes[Math.floor(appendTimes.length * 0.5)];
  const p99 = appendTimes[Math.floor(appendTimes.length * 0.99)];

  console.log(`\n\n--- Append Throughput ---`);
  console.log(`Total events: ${totalAppends.toLocaleString()}`);
  console.log(`Duration: ${elapsed.toFixed(1)}s`);
  console.log(`Throughput: ${(totalAppends / elapsed).toFixed(0)} events/sec`);
  console.log(`Latency p50: ${p50.toFixed(2)}ms`);
  console.log(`Latency p99: ${p99.toFixed(2)}ms`);

  // ── 2. Rotation ─────────────────────────────────────────────────────

  console.log(`\n--- Rotation ---`);
  const state = writer.getState();
  console.log(`Rotations: ${state.totalAppends > 0 ? "yes" : "no"}`);
  console.log(`Successful appends: ${state.successfulAppends}`);
  console.log(`Failed appends: ${state.failedAppends}`);

  // ── 3. Tail Latency ─────────────────────────────────────────────────

  console.log(`\n--- Tail Latency ---`);
  const reader = createTraceReader(config);

  const tailStart = performance.now();
  const tail100 = await reader.tail({ limit: 100 });
  const tail100Ms = performance.now() - tailStart;
  console.log(`Tail 100 events: ${tail100Ms.toFixed(2)}ms (${tail100.length} returned)`);

  const tailStart2 = performance.now();
  const tail1000 = await reader.tail({ limit: 1000 });
  const tail1000Ms = performance.now() - tailStart2;
  console.log(`Tail 1000 events: ${tail1000Ms.toFixed(2)}ms (${tail1000.length} returned)`);

  // ── 4. Search Latency ───────────────────────────────────────────────

  console.log(`\n--- Search Latency ---`);
  const searchStart = performance.now();
  const found = await reader.search({ q: "Benchmark event 0" });
  const searchMs = performance.now() - searchStart;
  console.log(`Search by summary: ${searchMs.toFixed(2)}ms (${found.length} matches)`);

  // ── 5. Memory ───────────────────────────────────────────────────────

  if (globalThis.gc) {
    globalThis.gc();
  }
  const mem = process.memoryUsage();
  console.log(`\n--- Memory ---`);
  console.log(`RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Heap used: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Heap total: ${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`);

  // ── Cleanup ─────────────────────────────────────────────────────────

  const ledgerFiles = await fs.readdir(tmpDir);
  const totalBytes = await ledgerFiles.reduce(async (sum, f) => {
    const stat = await fs.stat(path.join(tmpDir, f));
    return (await sum) + stat.size;
  }, Promise.resolve(0));

  console.log(`\n--- Storage ---`);
  console.log(`Ledger files: ${ledgerFiles.length}`);
  console.log(`Total bytes: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Bytes/event: ${(totalBytes / totalAppends).toFixed(1)}`);

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log(`\nCleanup complete.`);
}

// ── Run ───────────────────────────────────────────────────────────────

const duration = parseInt(process.argv[2] ?? "5", 10);
runBenchmark(duration).catch((err) => {
  console.error(err);
  process.exit(1);
});
