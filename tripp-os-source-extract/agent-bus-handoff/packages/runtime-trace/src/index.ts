/**
 * @tripp-os/runtime-trace
 *
 * Durable append-only trace writer and reader for Tripp.OS runtime events.
 *
 * Public API:
 *   - TraceWriter       — append-only trace writer with fsync, rotation, fallback
 *   - TraceReader       — read-only trace reader: tail, search, chain, validate
 *   - createTraceWriter — factory function
 *   - createTraceReader — factory function
 *   - TraceConfig       — configuration type
 *   - TraceConfigSchema — configuration validation schema
 *   - validateTraceConfig — config validation function
 *   - TraceWriteResult  — write operation result type
 *   - TraceHealthStatus — health snapshot type
 *   - isTraceHealthy    — quick health check
 *   - generateQueueHandoff — queue adapter operator handoff bundle generator
 *   - validateQueueHandoffBundle — queue handoff bundle validator
 */

// Config
export {
  TraceConfigSchema,
  FallbackSinkConfigSchema,
  validateTraceConfig,
  getDefaultTraceConfig,
} from "./config.js";
export type { TraceConfig, FallbackSinkConfig } from "./config.js";

// Writer
export { TraceWriter, createTraceWriter } from "./writer.js";
export type { WriterState } from "./writer.js";

// Reader
export { TraceReader, createTraceReader } from "./reader.js";
export type { TailOptions, SearchCriteria } from "./reader.js";

// Fallback
export {
  FallbackChain,
  StderrSink,
  MemorySink,
  FileSink,
  NoopSink,
  createSink,
} from "./fallback.js";
export type { TraceSink, SinkResult } from "./fallback.js";

// Health
export { isTraceHealthy } from "./health.js";
export type {
  TraceHealthStatus,
  TraceWriteResult,
  LedgerValidationSummary,
} from "./health.js";

// Handoff
export {
  generateTraceHandoff,
  validateHandoffBundle,
} from "./handoff.js";
export type {
  HandoffOptions,
  HandoffResult,
  BundleValidationResult,
} from "./handoff.js";

// Adapter
export { TraceBusAdapter, createTraceBusAdapter } from "./adapter.js";
export type {
  TraceBusAdapterOptions,
  AdapterWriteResult,
} from "./adapter.js";

// Bundle Diff
export { diffHandoffBundles } from "./diff.js";
export type { BundleDiffResult } from "./diff.js";

// Compression
export {
  compressLedgerFile,
  compressRotatedLedgers,
  decompressLedgerFile,
  readLedgerContent,
  listLedgerFiles,
} from "./compress.js";

// Dashboard
export { generateDashboard } from "./dashboard.js";

// Queue
export {
  createUntracedQueue,
  createTracedQueue,
  isTracedQueue,
  rollbackToUntracedQueue,
} from "./queue.js";
export type {
  TrippQueue,
  QueueMode,
  QueueHealth,
  RollbackInfo,
  TracedQueueConfig,
  UntracedQueueConfig,
} from "./queue.js";

// Queue Handoff
export {
  generateQueueHandoff,
  validateQueueHandoffBundle,
} from "./queue-handoff.js";
export type {
  QueueHandoffOptions,
  QueueHandoffResult,
  QueueValidationResults,
} from "./queue-handoff.js";
