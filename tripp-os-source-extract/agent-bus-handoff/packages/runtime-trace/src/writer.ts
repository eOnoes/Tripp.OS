/**
 * @tripp-os/runtime-trace — Trace Writer
 *
 * Durable append-only trace writer with fsync, rotation,
 * fallback sink chain, and optional runtime health integration.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  createTraceEvent,
  appendTraceEvent,
  type CreateTraceEventInput,
  type AgentBusTraceEvent,
} from "@tripp-os/agent-bus";
import type { TraceConfig } from "./config.js";
import { FallbackChain } from "./fallback.js";
import type { TraceHealthStatus, TraceWriteResult, TraceHealthCheckable } from "./health.js";

// ── Optional Runtime Interface (duck-typed, no import) ────────────────

interface RuntimeLike {
  health: {
    markDegraded(reason: string): void;
    markHealthy(): void;
    snapshot(): { isHealthy: boolean };
  };
  safeMode?: {
    trigger(reason: string): void;
  };
  panic?: {
    trigger(reason: string): void;
  };
}

// ── Trace Writer State ────────────────────────────────────────────────

export interface WriterState {
  totalAppends: number;
  successfulAppends: number;
  fallbackAppends: number;
  failedAppends: number;
  currentLedgerFile: string;
  currentLedgerBytes: number;
  lastFsyncMs: number;
  isDegraded: boolean;
  fallbackSinkName: string | null;
  lastRotationDate: string; // YYYY-MM-DD
}

// ── Trace Writer ──────────────────────────────────────────────────────

export class TraceWriter implements TraceHealthCheckable {
  private config: TraceConfig;
  private runtime: RuntimeLike | undefined;
  private state: WriterState;
  private fallback: FallbackChain;
  private traceRoot: string;

  constructor(config: TraceConfig, runtime?: RuntimeLike) {
    this.config = config;
    this.runtime = runtime;
    this.traceRoot = path.resolve(config.traceRoot);
    this.fallback = new FallbackChain(config.fallbackSinks);

    const ledgerFile = path.join(this.traceRoot, config.ledgerFileName);
    this.state = {
      totalAppends: 0,
      successfulAppends: 0,
      fallbackAppends: 0,
      failedAppends: 0,
      currentLedgerFile: ledgerFile,
      currentLedgerBytes: 0,
      lastFsyncMs: 0,
      isDegraded: false,
      fallbackSinkName: null,
      lastRotationDate: this.getCurrentDate(),
    };
  }

  // ── Core: Append ────────────────────────────────────────────────────

  async append(input: CreateTraceEventInput): Promise<TraceWriteResult> {
    this.state.totalAppends++;

    // 1. Create and validate the event
    let event: AgentBusTraceEvent;
    try {
      event = createTraceEvent(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        sink: "none",
        eventId: "",
        timestamp: new Date().toISOString(),
        error: `VALIDATION_FAILED: ${msg}`,
      };
    }

    // 2. Check rotation before writing
    if (this.config.rotationEnabled) {
      await this.maybeRotate();
    }

    // 3. Write to primary sink
    const primaryResult = await this.writePrimary(event);
    if (primaryResult.success) {
      this.state.successfulAppends++;
      this.state.isDegraded = false;
      this.state.fallbackSinkName = null;
      return {
        success: true,
        sink: "primary",
        eventId: event.eventId,
        timestamp: event.createdAt,
      };
    }

    // 4. Try fallback chain
    const fallbackResult = await this.fallback.write(event);
    if (fallbackResult.success) {
      this.state.fallbackAppends++;
      this.state.isDegraded = true;
      this.state.fallbackSinkName = fallbackResult.sinkName;

      if (this.config.alertOnFallback) {
        this.notifyDegraded(fallbackResult.sinkName);
      }

      return {
        success: true,
        sink: fallbackResult.sinkName as TraceWriteResult["sink"],
        eventId: event.eventId,
        timestamp: event.createdAt,
        degraded: true,
      };
    }

    // 5. All sinks failed
    this.state.failedAppends++;
    this.state.isDegraded = true;
    this.notifyAllSinksFailed();

    return {
      success: false,
      sink: "none",
      eventId: event.eventId,
      timestamp: event.createdAt,
      error: "ALL_SINKS_FAILED",
    };
  }

  // ── Health ──────────────────────────────────────────────────────────

  health(): TraceHealthStatus {
    return {
      writable: this.state.successfulAppends > 0 || this.state.fallbackAppends > 0,
      degraded: this.state.isDegraded,
      fallbackSink: this.state.fallbackSinkName,
      lastWriteMs: this.state.lastFsyncMs,
      malformedRatio: null, // Reader-derived only; use TraceReader.validate() to compute
      alert: this.state.isDegraded
        ? `Trace writer is degraded. Fallback: ${this.state.fallbackSinkName ?? "none"}. Failed: ${this.state.failedAppends}`
        : null,
    };
  }

  // ── State Access ────────────────────────────────────────────────────

  getState(): Readonly<WriterState> {
    return { ...this.state };
  }

  // ── Rotation ────────────────────────────────────────────────────────

  async rotate(): Promise<void> {
    const currentPath = this.state.currentLedgerFile;

    // Collision-safe rotated name: agent-bus-trace-2026-06-07T160530.123.jsonl
    // Uses ISO timestamp with milliseconds to guarantee uniqueness even with
    // multiple rotations in the same second.
    const timestamp = new Date().toISOString().replace(/[:]/g, "").replace("Z", "");
    const rotatedName = `${this.config.ledgerFileName.replace(/\.jsonl$/, "")}-${timestamp}.jsonl`;
    const rotatedPath = path.join(this.traceRoot, rotatedName);

    try {
      await fs.rename(currentPath, rotatedPath);
    } catch {
      // File may not exist yet — that's fine
    }

    // Write checksum for rotated file
    if (this.config.checksumEnabled) {
      await this.writeChecksum(rotatedPath);
    }

    // Clean up old files
    await this.cleanupOldFiles();

    // Start new ledger
    this.state.currentLedgerFile = path.join(this.traceRoot, this.config.ledgerFileName);
    this.state.currentLedgerBytes = 0;
    this.state.lastRotationDate = this.getCurrentDate();
  }

  // ── Internal: Primary Write ─────────────────────────────────────────

  private async writePrimary(event: AgentBusTraceEvent): Promise<{ success: boolean }> {
    try {
      // Ensure trace root exists
      await fs.mkdir(this.traceRoot, { recursive: true });

      const ledgerPath = this.state.currentLedgerFile;
      const line = JSON.stringify(event) + "\n";

      await fs.appendFile(ledgerPath, line, "utf-8");

      // Fsync if enabled
      if (this.config.fsyncOnAppend) {
        const fd = await fs.open(ledgerPath, "a");
        try {
          await fd.sync();
        } finally {
          await fd.close();
        }
        this.state.lastFsyncMs = Date.now();
      }

      // Update byte count
      this.state.currentLedgerBytes += Buffer.byteLength(line, "utf-8");

      return { success: true };
    } catch {
      return { success: false };
    }
  }

  // ── Internal: Rotation Check ────────────────────────────────────────

  private async maybeRotate(): Promise<void> {
    const shouldRotateByDate = this.getCurrentDate() !== this.state.lastRotationDate;
    const shouldRotateBySize = this.state.currentLedgerBytes >= this.config.maxLedgerBytes;

    if (shouldRotateByDate || shouldRotateBySize) {
      await this.rotate();
    }
  }

  // ── Internal: Checksum ──────────────────────────────────────────────

  private async writeChecksum(ledgerPath: string): Promise<void> {
    try {
      const data = await fs.readFile(ledgerPath, "utf-8");
      const hash = createHash("sha256").update(data).digest("hex");
      const checksumPath = `${ledgerPath}.sha256`;
      await fs.writeFile(checksumPath, hash, "utf-8");
    } catch {
      // Checksum is best-effort; failure is non-blocking
    }
  }

  // ── Internal: Cleanup ───────────────────────────────────────────────

  private async cleanupOldFiles(): Promise<void> {
    try {
      const entries = await fs.readdir(this.traceRoot);
      // Match collision-safe rotated filenames:
      // agent-bus-trace-2026-06-07T160530.123.jsonl
      const ledgerPattern = new RegExp(
        `^${this.config.ledgerFileName.replace(/\.jsonl$/, "")}-\\d{4}-\\d{2}-\\d{2}T\\d{6}\\.\\d{3}\\.jsonl$`
      );
      const ledgerFiles = entries
        .filter((e) => ledgerPattern.test(e))
        .map((e) => ({
          name: e,
          path: path.join(this.traceRoot, e),
          mtime: 0,
        }));

      // Get mtimes
      for (const f of ledgerFiles) {
        try {
          const stat = await fs.stat(f.path);
          f.mtime = stat.mtimeMs;
        } catch {
          // ignore
        }
      }

      // Sort by mtime (oldest first)
      ledgerFiles.sort((a, b) => a.mtime - b.mtime);

      // Delete excess files
      const toDelete = ledgerFiles.length - this.config.maxLedgerFiles;
      if (toDelete > 0) {
        for (let i = 0; i < toDelete; i++) {
          try {
            await fs.unlink(ledgerFiles[i].path);
            // Also delete checksum if exists
            try {
              await fs.unlink(`${ledgerFiles[i].path}.sha256`);
            } catch {
              // ignore
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // Cleanup is best-effort
    }
  }

  // ── Internal: Notifications ─────────────────────────────────────────

  private notifyDegraded(sinkName: string): void {
    if (this.runtime?.health) {
      this.runtime.health.markDegraded(`trace_fallback_${sinkName}`);
    }
  }

  private notifyAllSinksFailed(): void {
    if (this.runtime?.safeMode) {
      this.runtime.safeMode.trigger("trace_atomicity_failure");
    }
    if (this.runtime?.panic) {
      this.runtime.panic.trigger("trace_all_sinks_failed");
    }
  }

  // ── Internal: Date Helper ───────────────────────────────────────────

  private getCurrentDate(): string {
    return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  }
}

// ── Factory ───────────────────────────────────────────────────────────

export function createTraceWriter(
  config: TraceConfig,
  runtime?: RuntimeLike
): TraceWriter {
  return new TraceWriter(config, runtime);
}
