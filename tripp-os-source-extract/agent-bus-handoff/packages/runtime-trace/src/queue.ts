/**
 * @tripp-os/runtime-trace — Controlled Runtime Queue
 *
 * Provides traced and untraced queue implementations for agent-bus packet
 * lifecycle operations. Traced mode uses TraceBusAdapter for automatic
 * event tracing. Untraced mode uses raw agent-bus with zero tracing overhead.
 *
 * Explicit opt-in only. No env var activation. No default tracing.
 * No global singleton. No side effects on import.
 */
import {
  writeTaskPacket,
  writeResultPacket,
  writeReviewPacket,
  readTaskPacket,
  readResultPacket,
  movePacketToArchive,
  movePacketToRejected,
} from "@tripp-os/agent-bus";
import type {
  ExternalAgentTaskPacket,
  ExternalAgentResultPacket,
  ExternalAgentReviewPacket,
  WriteOptions,
  ListOptions,
} from "@tripp-os/agent-bus";
import { TraceBusAdapter } from "./adapter.js";
import type { TraceHealthStatus, WriterState } from "./index.js";

// ── Queue Types ───────────────────────────────────────────────────────

export type QueueMode = "untraced" | "traced";

export interface QueueHealth {
  mode: QueueMode;
  traceHealth?: TraceHealthStatus;
  traceState?: WriterState;
  rollbackInfo?: RollbackInfo;
}

export interface RollbackInfo {
  rolledBackAt: string;
  reason: string;
  preRollbackAppends: number;
}

// ── Traced Queue Config ───────────────────────────────────────────────

export interface TracedQueueConfig {
  /** The TraceBusAdapter instance to use for tracing. */
  adapter: TraceBusAdapter;
  /** Workdir for agent-bus file operations. */
  workdir: string;
}

// ── Untraced Queue Config ─────────────────────────────────────────────

export interface UntracedQueueConfig {
  /** Workdir for agent-bus file operations. Optional. */
  workdir?: string;
}

// ── Queue Interface ───────────────────────────────────────────────────

export interface TrippQueue {
  /** Queue mode — "traced" or "untraced". */
  readonly mode: QueueMode;

  // ── Packet Lifecycle Operations ──────────────────────────────────────

  /** Enqueue a task packet. Returns file path. */
  enqueueTask(packet: ExternalAgentTaskPacket, options?: WriteOptions): Promise<string>;

  /** Read a pending task packet from file path. */
  readPendingTask(filePath: string): Promise<ExternalAgentTaskPacket>;

  /** Claim a task for processing. Traced mode emits agent_claimed_task. */
  claimTask(packetId: string, agentId: string, agentRole?: string): Promise<void>;

  /** Write a result packet. Returns file path. */
  writeResult(packet: ExternalAgentResultPacket, options?: WriteOptions): Promise<string>;

  /** Write a review/verdict packet. */
  writeReview(packet: ExternalAgentReviewPacket, options?: WriteOptions): Promise<{ jsonPath: string; mdPath: string; reviewId: string }>;

  /** Archive a completed packet. Returns archive path. */
  archivePacket(filePath: string, options?: ListOptions): Promise<string>;

  /** Reject a packet. Returns rejected path. */
  rejectPacket(filePath: string, reason: string, options?: ListOptions): Promise<string>;

  /** Emit a queue status snapshot. Traced mode only. */
  emitStatusSnapshot(status: { inboxCount: number; outboxCount: number; pendingCount: number }): Promise<void>;

  // ── Health & Introspection ───────────────────────────────────────────

  /** Get queue health (mode + trace health if traced). */
  health(): QueueHealth;

  /** Get trace writer state if traced, null if untraced. */
  getState(): WriterState | null;
}

// ── Untraced Queue Implementation ─────────────────────────────────────

class UntracedQueue implements TrippQueue {
  readonly mode: QueueMode = "untraced";
  private workdir?: string;

  constructor(config: UntracedQueueConfig = {}) {
    this.workdir = config.workdir;
  }

  async enqueueTask(packet: ExternalAgentTaskPacket, options?: WriteOptions): Promise<string> {
    return writeTaskPacket(packet, this.mergeOptions(options));
  }

  async readPendingTask(filePath: string): Promise<ExternalAgentTaskPacket> {
    return readTaskPacket(filePath);
  }

  async claimTask(_packetId: string, _agentId: string, _agentRole?: string): Promise<void> {
    // Untraced: no-op (no trace to emit)
    return;
  }

  async writeResult(packet: ExternalAgentResultPacket, options?: WriteOptions): Promise<string> {
    return writeResultPacket(packet, this.mergeOptions(options));
  }

  async writeReview(
    packet: ExternalAgentReviewPacket,
    options?: WriteOptions
  ): Promise<{ jsonPath: string; mdPath: string; reviewId: string }> {
    return writeReviewPacket(packet, this.mergeOptions(options));
  }

  async archivePacket(filePath: string, options?: ListOptions): Promise<string> {
    return movePacketToArchive(filePath, this.mergeListOptions(options));
  }

  async rejectPacket(filePath: string, reason: string, options?: ListOptions): Promise<string> {
    return movePacketToRejected(filePath, reason, this.mergeListOptions(options));
  }

  async emitStatusSnapshot(_status: { inboxCount: number; outboxCount: number; pendingCount: number }): Promise<void> {
    // Untraced: no-op
    return;
  }

  health(): QueueHealth {
    return { mode: "untraced" };
  }

  getState(): null {
    return null;
  }

  private mergeOptions(options?: WriteOptions): WriteOptions | undefined {
    if (!this.workdir) return options ?? undefined;
    return { workdir: this.workdir, ...options };
  }

  private mergeListOptions(options?: ListOptions): ListOptions | undefined {
    if (!this.workdir) return options ?? undefined;
    return { workdir: this.workdir, ...options };
  }
}

// ── Traced Queue Implementation ───────────────────────────────────────

class TracedQueue implements TrippQueue {
  readonly mode: QueueMode = "traced";
  private adapter: TraceBusAdapter;
  private workdir: string;

  constructor(config: TracedQueueConfig) {
    this.adapter = config.adapter;
    this.workdir = config.workdir;
  }

  async enqueueTask(packet: ExternalAgentTaskPacket, options?: WriteOptions): Promise<string> {
    const result = await this.adapter.writeTaskPacket(packet, this.mergeOptions(options));
    return result.packetResult;
  }

  async readPendingTask(filePath: string): Promise<ExternalAgentTaskPacket> {
    const result = await this.adapter.readTaskPacket(filePath);
    return result.packetResult;
  }

  async claimTask(packetId: string, agentId: string, agentRole?: string): Promise<void> {
    await this.adapter.trace("packet_claimed", {
      summary: `Agent ${agentId} claimed task ${packetId}`,
      packetId,
      agentRole: (agentRole ?? "system") as ExternalAgentTaskPacket["agentRole"],
      severity: "info",
      details: { claimedBy: agentId, timestamp: Date.now() },
    });
  }

  async writeResult(packet: ExternalAgentResultPacket, options?: WriteOptions): Promise<string> {
    const result = await this.adapter.writeResultPacket(packet, this.mergeOptions(options));
    return result.packetResult;
  }

  async writeReview(
    packet: ExternalAgentReviewPacket,
    options?: WriteOptions
  ): Promise<{ jsonPath: string; mdPath: string; reviewId: string }> {
    const result = await this.adapter.writeReviewPacket(packet, this.mergeOptions(options));
    return result.packetResult;
  }

  async archivePacket(filePath: string, options?: ListOptions): Promise<string> {
    const result = await this.adapter.moveToArchive(filePath, this.mergeListOptions(options));
    return result.packetResult;
  }

  async rejectPacket(filePath: string, reason: string, options?: ListOptions): Promise<string> {
    const result = await this.adapter.moveToRejected(filePath, reason, this.mergeListOptions(options));
    return result.packetResult;
  }

  async emitStatusSnapshot(status: { inboxCount: number; outboxCount: number; pendingCount: number }): Promise<void> {
    await this.adapter.trace("packet_read", {
      summary: `Queue status: ${status.inboxCount} inbox, ${status.outboxCount} outbox, ${status.pendingCount} pending`,
      severity: "debug",
      details: status,
    });
  }

  health(): QueueHealth {
    return {
      mode: "traced",
      traceHealth: this.adapter.health(),
      traceState: this.adapter.getState(),
    };
  }

  getState(): WriterState {
    return this.adapter.getState();
  }

  /** Internal: get the adapter for introspection or handoff. */
  getAdapter(): TraceBusAdapter {
    return this.adapter;
  }

  private mergeOptions(options?: WriteOptions): WriteOptions {
    return { workdir: this.workdir, ...options };
  }

  private mergeListOptions(options?: ListOptions): ListOptions {
    return { workdir: this.workdir, ...options };
  }
}

// ── Factory Functions ─────────────────────────────────────────────────

/**
 * Create an untraced queue. Uses raw agent-bus operations with zero tracing.
 * This is the default mode. No trace files are created.
 */
export function createUntracedQueue(config?: UntracedQueueConfig): TrippQueue {
  return new UntracedQueue(config);
}

/**
 * Create a traced queue. Requires an explicit TraceBusAdapter instance.
 * All packet lifecycle operations are automatically traced.
 */
export function createTracedQueue(config: TracedQueueConfig): TrippQueue {
  return new TracedQueue(config);
}

// ── Type Guard ────────────────────────────────────────────────────────

/**
 * Check if a queue is traced.
 */
export function isTracedQueue(queue: TrippQueue): queue is TracedQueue {
  return queue.mode === "traced";
}

// ── Rollback ──────────────────────────────────────────────────────────

/**
 * Rollback a traced queue to untraced mode.
 * Does not delete trace files. Does not mutate packet files.
 * Does not generate handoff automatically.
 * Records rollback metadata in returned queue.
 */
export function rollbackToUntracedQueue(
  queue: TrippQueue,
  reason = "operator_rollback"
): TrippQueue & { rollbackInfo: RollbackInfo } {
  const preRollbackAppends = queue.getState()?.totalAppends ?? 0;

  const untraced = new UntracedQueue({});
  const rollbackInfo: RollbackInfo = {
    rolledBackAt: new Date().toISOString(),
    reason,
    preRollbackAppends,
  };

  return Object.assign(untraced, { rollbackInfo });
}
