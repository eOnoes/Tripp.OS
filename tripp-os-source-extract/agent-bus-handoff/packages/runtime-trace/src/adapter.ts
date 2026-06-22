/**
 * @tripp-os/runtime-trace — Trace Bus Adapter
 *
 * Bridges Agent Bus packet operations to the durable trace writer.
 * Every packet lifecycle event (create, read, move, reject) is automatically
 * traced via TraceWriter with appropriate event types and correlation fields.
 *
 * Thin layer — delegates packet I/O to agent-bus, adds tracing only.
 * No packet mutation. No queue management. No live agent behavior.
 */
import {
  writeTaskPacket,
  writeResultPacket,
  writeReviewPacket,
  readTaskPacket,
  readResultPacket,
  movePacketToArchive,
  movePacketToRejected,
  listInboxPackets,
  listOutboxPackets,
  createTraceEvent,
  type CreateTraceEventInput,
} from "@tripp-os/agent-bus";
import type {
  ExternalAgentTaskPacket,
  ExternalAgentResultPacket,
  ExternalAgentReviewPacket,
  AgentBusTraceEventType,
  AgentBusTraceSeverity,
  AgentBusTraceActorType,
  WriteOptions,
  ListOptions,
} from "@tripp-os/agent-bus";
import { createTraceWriter, validateTraceConfig } from "./index.js";
import type { TraceConfig, TraceWriteResult, WriterState } from "./index.js";

// ── Adapter Options ───────────────────────────────────────────────────

export interface TraceBusAdapterOptions {
  /** Trace writer configuration. Required. */
  traceConfig: TraceConfig;
  /** Default actor type for trace events. Defaults to "system". */
  actorType?: AgentBusTraceActorType;
  /** Default actor ID. Optional. */
  actorId?: string;
  /** Default run ID for correlation. Optional. */
  runId?: string;
  /** Tags applied to all trace events. Optional. */
  tags?: string[];
}

// ── Adapter Result ────────────────────────────────────────────────────

export interface AdapterWriteResult<T> {
  /** The packet operation result from agent-bus. */
  packetResult: T;
  /** The trace write result from TraceWriter. */
  traceResult: TraceWriteResult;
  /** The trace event ID for correlation. */
  traceEventId: string;
}

// ── TraceBusAdapter ───────────────────────────────────────────────────

/**
 * Wraps Agent Bus packet operations with automatic durable tracing.
 *
 * Each method:
 * 1. Performs the agent-bus operation
 * 2. Maps the operation to a trace event
 * 3. Writes the trace event via TraceWriter
 * 4. Returns both the packet result and trace result
 *
 * The adapter is safe to use without tracing — if the trace writer
 * fails, the packet operation still succeeds (trace failure is non-blocking).
 */
export class TraceBusAdapter {
  private writer: ReturnType<typeof createTraceWriter>;
  private actorType: AgentBusTraceActorType;
  private actorId?: string;
  private runId?: string;
  private tags: string[];

  constructor(options: TraceBusAdapterOptions) {
    this.writer = createTraceWriter(options.traceConfig);
    this.actorType = options.actorType ?? "system";
    this.actorId = options.actorId;
    this.runId = options.runId;
    this.tags = options.tags ?? [];
  }

  // ── Packet Write Operations ────────────────────────────────────────

  /**
   * Write a task packet to the inbox and trace it as `packet_created`.
   */
  async writeTaskPacket(
    packet: ExternalAgentTaskPacket,
    options?: WriteOptions
  ): Promise<AdapterWriteResult<string>> {
    const filePath = await writeTaskPacket(packet, options);
    const traceResult = await this.traceEvent("packet_created", {
      summary: `Task packet written: ${packet.title ?? packet.objective ?? "untitled"}`,
      packetId: packet.packetId,
      agentRole: packet.agentRole,
      targetPath: filePath,
      severity: "info",
      details: { taskType: packet.taskType, trustZone: packet.trustZone },
    });
    return { packetResult: filePath, traceResult, traceEventId: traceResult.eventId };
  }

  /**
   * Write a result packet to the outbox and trace it as `result_written`.
   */
  async writeResultPacket(
    packet: ExternalAgentResultPacket,
    options?: WriteOptions
  ): Promise<AdapterWriteResult<string>> {
    const filePath = await writeResultPacket(packet, options);
    const traceResult = await this.traceEvent("result_written", {
      summary: `Result packet written: ${packet.summary ?? "untitled"}`,
      packetId: packet.packetId,
      resultId: packet.resultId,
      agentRole: packet.agentRole,
      targetPath: filePath,
      severity: packet.status === "failed" || packet.status === "unsafe" ? "warning" : "info",
      details: { status: packet.status, proposedChanges: packet.proposedChanges.length },
    });
    return { packetResult: filePath, traceResult, traceEventId: traceResult.eventId };
  }

  /**
   * Write a review packet and trace it as `warden_verdict_recorded`.
   */
  async writeReviewPacket(
    packet: ExternalAgentReviewPacket,
    options?: WriteOptions
  ): Promise<AdapterWriteResult<{ jsonPath: string; mdPath: string; reviewId: string }>> {
    const result = await writeReviewPacket(packet, options);
    const traceResult = await this.traceEvent("warden_verdict_recorded", {
      summary: `Review recorded: ${packet.summary ?? packet.verdict ?? "untitled"}`,
      reviewId: packet.reviewId ?? result.reviewId,
      packetId: packet.packetId,
      agentRole: packet.reviewerRole as ExternalAgentTaskPacket["agentRole"],
      targetPath: result.jsonPath,
      severity: packet.verdict === "block" || packet.verdict === "escalate" ? "warning" : "info",
      details: { verdict: packet.verdict, issues: packet.issues.length },
    });
    return { packetResult: result, traceResult, traceEventId: traceResult.eventId };
  }

  // ── Packet Read Operations ─────────────────────────────────────────

  /**
   * Read a task packet and trace it as `packet_read`.
   */
  async readTaskPacket(filePath: string): Promise<AdapterWriteResult<ExternalAgentTaskPacket>> {
    const packet = await readTaskPacket(filePath);
    const traceResult = await this.traceEvent("packet_read", {
      summary: `Task packet read: ${packet.title ?? packet.objective ?? "untitled"}`,
      packetId: packet.packetId,
      agentRole: packet.agentRole,
      sourcePath: filePath,
      severity: "info",
      details: { taskType: packet.taskType },
    });
    return { packetResult: packet, traceResult, traceEventId: traceResult.eventId };
  }

  /**
   * Read a result packet and trace it as `result_read`.
   */
  async readResultPacket(filePath: string): Promise<AdapterWriteResult<ExternalAgentResultPacket>> {
    const packet = await readResultPacket(filePath);
    const traceResult = await this.traceEvent("result_read", {
      summary: `Result packet read: ${packet.summary ?? "untitled"}`,
      packetId: packet.packetId,
      resultId: packet.resultId,
      agentRole: packet.agentRole,
      sourcePath: filePath,
      severity: "info",
      details: { status: packet.status, proposedChanges: packet.proposedChanges.length },
    });
    return { packetResult: packet, traceResult, traceEventId: traceResult.eventId };
  }

  // ── Packet Move Operations ─────────────────────────────────────────

  /**
   * Move a packet to archive and trace it as `packet_archived`.
   */
  async moveToArchive(filePath: string, options?: ListOptions): Promise<AdapterWriteResult<string>> {
    const destPath = await movePacketToArchive(filePath, options);
    const traceResult = await this.traceEvent("packet_archived", {
      summary: `Packet archived: ${filePath}`,
      sourcePath: filePath,
      targetPath: destPath,
      severity: "info",
    });
    return { packetResult: destPath, traceResult, traceEventId: traceResult.eventId };
  }

  /**
   * Move a packet to rejected and trace it as `packet_rejected`.
   */
  async moveToRejected(
    filePath: string,
    reason: string,
    options?: ListOptions
  ): Promise<AdapterWriteResult<string>> {
    const destPath = await movePacketToRejected(filePath, reason, options);
    const traceResult = await this.traceEvent("packet_rejected", {
      summary: `Packet rejected: ${reason}`,
      sourcePath: filePath,
      targetPath: destPath,
      severity: "warning",
      details: { rejectionReason: reason },
    });
    return { packetResult: destPath, traceResult, traceEventId: traceResult.eventId };
  }

  // ── List Operations (lightweight tracing) ──────────────────────────

  /**
   * List inbox packets and trace a summary event.
   */
  async listInbox(options?: ListOptions): Promise<{ packets: string[]; count: number }> {
    const packets = await listInboxPackets(options);
    if (packets.length > 0) {
      await this.traceEvent("packet_read", {
        summary: `Listed inbox: ${packets.length} packet(s)`,
        severity: "debug",
        details: { count: packets.length },
      });
    }
    return { packets, count: packets.length };
  }

  /**
   * List outbox packets and trace a summary event.
   */
  async listOutbox(options?: ListOptions): Promise<{ packets: string[]; count: number }> {
    const packets = await listOutboxPackets(options);
    if (packets.length > 0) {
      await this.traceEvent("result_read", {
        summary: `Listed outbox: ${packets.length} result(s)`,
        severity: "debug",
        details: { count: packets.length },
      });
    }
    return { packets, count: packets.length };
  }

  // ── Direct Trace API ───────────────────────────────────────────────

  /**
   * Manually trace any agent-bus event type.
   * Used for events that don't map to a file-bus operation.
   */
  async trace(
    eventType: AgentBusTraceEventType | string,
    input: {
      summary: string;
      severity?: AgentBusTraceSeverity;
      packetId?: string;
      resultId?: string;
      reviewId?: string;
      agentRole?: ExternalAgentTaskPacket["agentRole"];
      subagentId?: string;
      subagentRole?: string;
      sourcePath?: string;
      targetPath?: string;
      details?: Record<string, unknown>;
      tags?: string[];
    }
  ): Promise<TraceWriteResult> {
    return this.traceEvent(eventType, input);
  }

  // ── Health & State ─────────────────────────────────────────────────

  /** Get the underlying trace writer's health. */
  health() {
    return this.writer.health();
  }

  /** Get the underlying trace writer's state. */
  getState(): WriterState {
    return this.writer.getState();
  }

  // ── Internal: Trace Event Helper ───────────────────────────────────

  private async traceEvent(
    eventType: AgentBusTraceEventType | string,
    input: {
      summary: string;
      severity?: AgentBusTraceSeverity;
      packetId?: string;
      resultId?: string;
      reviewId?: string;
      agentRole?: ExternalAgentTaskPacket["agentRole"];
      subagentId?: string;
      subagentRole?: string;
      sourcePath?: string;
      targetPath?: string;
      details?: Record<string, unknown>;
      tags?: string[];
    }
  ): Promise<TraceWriteResult> {
    try {
      const traceEvent = createTraceEvent({
        eventType,
        severity: input.severity ?? "info",
        actorType: this.actorType,
        actorId: this.actorId,
        runId: this.runId,
        packetId: input.packetId,
        resultId: input.resultId,
        reviewId: input.reviewId,
        agentRole: input.agentRole,
        subagentId: input.subagentId,
        subagentRole: input.subagentRole,
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        summary: input.summary,
        details: input.details ?? {},
        tags: [...this.tags, ...(input.tags ?? [])],
      } as CreateTraceEventInput);

      return await this.writer.append(traceEvent);
    } catch {
      // Trace failure is non-blocking — packet operation still succeeded
      return {
        success: false,
        sink: "none",
        eventId: "trace-failed",
        timestamp: new Date().toISOString(),
        error: "Trace write failed but packet operation succeeded",
      };
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────

/**
 * Create a TraceBusAdapter with validation.
 */
export function createTraceBusAdapter(options: TraceBusAdapterOptions): TraceBusAdapter {
  // Validate trace config
  const _ = validateTraceConfig(options.traceConfig);
  return new TraceBusAdapter(options);
}
