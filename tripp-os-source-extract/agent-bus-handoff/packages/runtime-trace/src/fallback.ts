/**
 * @tripp-os/runtime-trace — Fallback Sinks
 *
 * Ordered fallback sink chain for trace write failures.
 * When the primary trace sink fails, the writer tries each fallback
 * in order until one succeeds.
 */
import type { AgentBusTraceEvent } from "@tripp-os/agent-bus";
import type { FallbackSinkConfig } from "./config.js";

// ── Sink Result ───────────────────────────────────────────────────────

export interface SinkResult {
  readonly success: boolean;
  readonly sinkName: string;
}

// ── Sink Interface ────────────────────────────────────────────────────

export interface TraceSink {
  readonly name: string;
  write(event: AgentBusTraceEvent): Promise<SinkResult>;
}

// ── Stderr Sink ───────────────────────────────────────────────────────

export class StderrSink implements TraceSink {
  readonly name = "fallback:stderr";
  private prefix: string;

  constructor(prefix = "TRACE_FALLBACK") {
    this.prefix = prefix;
  }

  async write(event: AgentBusTraceEvent): Promise<SinkResult> {
    try {
      const line = JSON.stringify({
        _sink: this.name,
        _timestamp: new Date().toISOString(),
        ...event,
      });
      console.error(`[${this.prefix}] ${line}`);
      return { success: true, sinkName: this.name };
    } catch {
      return { success: false, sinkName: this.name };
    }
  }
}

// ── Memory Sink ───────────────────────────────────────────────────────

export class MemorySink implements TraceSink {
  readonly name = "fallback:memory";
  private maxEvents: number;
  private buffer: AgentBusTraceEvent[] = [];

  constructor(maxEvents = 1000) {
    this.maxEvents = maxEvents;
  }

  async write(event: AgentBusTraceEvent): Promise<SinkResult> {
    try {
      this.buffer.push(event);
      if (this.buffer.length > this.maxEvents) {
        this.buffer = this.buffer.slice(-this.maxEvents);
      }
      return { success: true, sinkName: this.name };
    } catch {
      return { success: false, sinkName: this.name };
    }
  }

  getEvents(): readonly AgentBusTraceEvent[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }
}

// ── File Sink ─────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as path from "node:path";

export class FileSink implements TraceSink {
  readonly name = "fallback:file";
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  async write(event: AgentBusTraceEvent): Promise<SinkResult> {
    try {
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      const line = JSON.stringify(event) + "\n";
      await fs.appendFile(this.filePath, line, "utf-8");
      return { success: true, sinkName: this.name };
    } catch {
      return { success: false, sinkName: this.name };
    }
  }
}

// ── Noop Sink ─────────────────────────────────────────────────────────

export class NoopSink implements TraceSink {
  readonly name = "fallback:noop";

  async write(_event: AgentBusTraceEvent): Promise<SinkResult> {
    // Intentionally drops the event
    return { success: true, sinkName: this.name };
  }
}

// ── Sink Factory ──────────────────────────────────────────────────────

export function createSink(config: FallbackSinkConfig): TraceSink {
  switch (config.type) {
    case "stderr":
      return new StderrSink(config.prefix);
    case "memory":
      return new MemorySink(config.maxEvents);
    case "file":
      return new FileSink(config.path);
    case "noop":
      return new NoopSink();
    default: {
      // Exhaustiveness check
      const _exhaustive: never = config;
      throw new Error(`Unknown sink type: ${_exhaustive}`);
    }
  }
}

// ── Fallback Chain ────────────────────────────────────────────────────

export class FallbackChain {
  private sinks: TraceSink[];

  constructor(configs: FallbackSinkConfig[]) {
    this.sinks = configs.map(createSink);
  }

  async write(event: AgentBusTraceEvent): Promise<SinkResult> {
    for (const sink of this.sinks) {
      const result = await sink.write(event);
      if (result.success) {
        return result;
      }
    }
    return { success: false, sinkName: "all_sinks_failed" };
  }

  getSinkNames(): string[] {
    return this.sinks.map((s) => s.name);
  }

  getMemorySink(): MemorySink | undefined {
    return this.sinks.find((s): s is MemorySink => s instanceof MemorySink);
  }
}
