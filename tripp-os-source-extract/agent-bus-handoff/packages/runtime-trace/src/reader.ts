/**
 * @tripp-os/runtime-trace — Trace Reader
 *
 * Read-only trace reader: tail, search, causal chain, validate.
 * All operations are read-only. No mutation.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ValidatedTraceEventSchema,
  type AgentBusTraceEvent,
  type AgentBusTraceEventType,
  type AgentBusTraceSeverity,
  type AgentBusTraceActorType,
} from "@tripp-os/agent-bus";
import type { TraceConfig } from "./config.js";
import type { LedgerValidationSummary } from "./health.js";

// ── Read Options ──────────────────────────────────────────────────────

export interface TailOptions {
  limit?: number;
  severity?: AgentBusTraceSeverity[];
  actorType?: AgentBusTraceActorType[];
  eventType?: AgentBusTraceEventType[];
  since?: string; // ISO timestamp
  packetId?: string;
}

export interface SearchCriteria {
  packetId?: string;
  runId?: string;
  agentId?: string;
  eventType?: AgentBusTraceEventType;
  severity?: AgentBusTraceSeverity;
  dateFrom?: string; // ISO date YYYY-MM-DD
  dateTo?: string;
  q?: string; // simple text match
  limit?: number;
}

// ── Trace Reader ──────────────────────────────────────────────────────

export class TraceReader {
  private config: TraceConfig;
  private traceRoot: string;

  constructor(config: TraceConfig) {
    this.config = config;
    this.traceRoot = path.resolve(config.traceRoot);
  }

  // ── Tail ────────────────────────────────────────────────────────────

  async tail(options: TailOptions = {}): Promise<AgentBusTraceEvent[]> {
    const events = await this.readAllEvents();

    // Apply filters
    const filtered = events.filter((e) => {
      if (options.severity && !options.severity.includes(e.severity)) return false;
      if (options.actorType && !options.actorType.includes(e.actorType)) return false;
      if (options.eventType && !options.eventType.includes(e.eventType)) return false;
      if (options.since && e.createdAt < options.since) return false;
      if (options.packetId && e.packetId !== options.packetId) return false;
      return true;
    });

    const limit = options.limit ?? 100;
    return filtered.slice(-limit);
  }

  // ── Search ──────────────────────────────────────────────────────────

  async search(criteria: SearchCriteria = {}): Promise<AgentBusTraceEvent[]> {
    const allEvents = await this.readAllEvents();

    const filtered = allEvents.filter((e) => {
      if (criteria.packetId && e.packetId !== criteria.packetId) return false;
      if (criteria.runId && e.runId !== criteria.runId) return false;
      if (criteria.agentId && e.actorId !== criteria.agentId) return false;
      if (criteria.eventType && e.eventType !== criteria.eventType) return false;
      if (criteria.severity && e.severity !== criteria.severity) return false;
      if (criteria.dateFrom && e.createdAt.split("T")[0] < criteria.dateFrom) return false;
      if (criteria.dateTo && e.createdAt.split("T")[0] > criteria.dateTo) return false;
      if (criteria.q) {
        const text = JSON.stringify(e).toLowerCase();
        if (!text.includes(criteria.q.toLowerCase())) return false;
      }
      return true;
    });

    const limit = criteria.limit ?? 100;
    return filtered.slice(0, limit);
  }

  // ── Causal Chain ────────────────────────────────────────────────────

  async causalChain(eventId: string): Promise<AgentBusTraceEvent[]> {
    const allEvents = await this.readAllEvents();
    const eventMap = new Map<string, AgentBusTraceEvent>();
    for (const e of allEvents) {
      eventMap.set(e.eventId, e);
    }

    const chain: AgentBusTraceEvent[] = [];
    const visited = new Set<string>();
    let current = eventMap.get(eventId);

    while (current && !visited.has(current.eventId)) {
      chain.unshift(current);
      visited.add(current.eventId);

      const parentId = current.rootCauseEventId ?? current.parentEventId;
      if (parentId) {
        current = eventMap.get(parentId);
      } else {
        break;
      }
    }

    return chain;
  }

  // ── Validate ────────────────────────────────────────────────────────

  async validate(): Promise<LedgerValidationSummary> {
    const ledgerPath = path.join(this.traceRoot, this.config.ledgerFileName);
    let raw: string;

    try {
      raw = await fs.readFile(ledgerPath, "utf-8");
    } catch {
      return {
        totalLines: 0,
        validLines: 0,
        malformedLines: 0,
        malformedLineNumbers: [],
        isValid: true,
        earliestTimestamp: null,
        latestTimestamp: null,
      };
    }

    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const malformedLineNumbers: number[] = [];
    let validCount = 0;
    let earliestTs: string | null = null;
    let latestTs: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        const event = ValidatedTraceEventSchema.parse(parsed);
        validCount++;

        if (!earliestTs || event.createdAt < earliestTs) earliestTs = event.createdAt;
        if (!latestTs || event.createdAt > latestTs) latestTs = event.createdAt;
      } catch {
        malformedLineNumbers.push(i + 1); // 1-based
      }
    }

    return {
      totalLines: lines.length,
      validLines: validCount,
      malformedLines: malformedLineNumbers.length,
      malformedLineNumbers,
      isValid: malformedLineNumbers.length === 0,
      earliestTimestamp: earliestTs,
      latestTimestamp: latestTs,
    };
  }

  // ── Checksum Verify ─────────────────────────────────────────────────

  async verifyChecksum(ledgerPath?: string): Promise<boolean> {
    const targetPath = ledgerPath ?? path.join(this.traceRoot, this.config.ledgerFileName);
    const checksumPath = `${targetPath}.sha256`;

    try {
      const expected = (await fs.readFile(checksumPath, "utf-8")).trim();
      const { createHash } = await import("node:crypto");
      const data = await fs.readFile(targetPath, "utf-8");
      const actual = createHash("sha256").update(data).digest("hex");
      return expected === actual;
    } catch {
      return false;
    }
  }

  // ── Internal: Read All Events ───────────────────────────────────────

  private async readAllEvents(): Promise<AgentBusTraceEvent[]> {
    const ledgerPath = path.join(this.traceRoot, this.config.ledgerFileName);
    let raw: string;

    try {
      raw = await fs.readFile(ledgerPath, "utf-8");
    } catch {
      return [];
    }

    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const events: AgentBusTraceEvent[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const event = ValidatedTraceEventSchema.parse(parsed);
        events.push(event);
      } catch {
        // Skip malformed lines — validation reports them separately
      }
    }

    return events;
  }
}

// ── Factory ───────────────────────────────────────────────────────────

export function createTraceReader(config: TraceConfig): TraceReader {
  return new TraceReader(config);
}
