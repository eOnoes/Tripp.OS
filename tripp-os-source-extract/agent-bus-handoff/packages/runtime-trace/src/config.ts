/**
 * @tripp-os/runtime-trace — Trace Config
 *
 * Configuration schema and validation for the runtime trace package.
 */
import { z } from "zod";

// ── Fallback Sink Config Schemas ──────────────────────────────────────

export const StderrSinkConfigSchema = z.object({
  type: z.literal("stderr"),
  prefix: z.string().optional(),
});

export const MemorySinkConfigSchema = z.object({
  type: z.literal("memory"),
  maxEvents: z.number().int().positive().optional(),
});

export const FileSinkConfigSchema = z.object({
  type: z.literal("file"),
  path: z.string().min(1),
});

export const NoopSinkConfigSchema = z.object({
  type: z.literal("noop"),
});

export const FallbackSinkConfigSchema = z.union([
  StderrSinkConfigSchema,
  MemorySinkConfigSchema,
  FileSinkConfigSchema,
  NoopSinkConfigSchema,
]);

export type FallbackSinkConfig = z.infer<typeof FallbackSinkConfigSchema>;

// ── Trace Config Schema ───────────────────────────────────────────────

export const TraceConfigSchema = z.object({
  // Root directory for all trace files
  traceRoot: z.string().min(1).default(".tripp/agents/trace"),

  // Ledger file naming
  ledgerFileName: z.string().min(1).default("agent-bus-trace.jsonl"),

  // Rotation
  rotationEnabled: z.boolean().default(true),
  rotationInterval: z.enum(["daily", "hourly"]).default("daily"),
  maxLedgerBytes: z.number().int().positive().default(100_000_000), // 100 MiB
  maxLedgerFiles: z.number().int().positive().default(30),

  // Durability
  fsyncOnAppend: z.boolean().default(true),
  checksumEnabled: z.boolean().default(true),

  // Fallback sinks (ordered priority)
  fallbackSinks: z.array(FallbackSinkConfigSchema).default([
    { type: "stderr" },
    { type: "memory", maxEvents: 1000 },
  ]),

  // Health
  maxMalformedRatio: z.number().min(0).max(1).default(0.01),
  alertOnFallback: z.boolean().default(true),
});

export type TraceConfig = z.infer<typeof TraceConfigSchema>;

// ── Validation ────────────────────────────────────────────────────────

export function validateTraceConfig(raw: unknown): TraceConfig {
  return TraceConfigSchema.parse(raw);
}

// ── Defaults ──────────────────────────────────────────────────────────

export function getDefaultTraceConfig(): TraceConfig {
  return TraceConfigSchema.parse({});
}
