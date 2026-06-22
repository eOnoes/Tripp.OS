# Tripp.OS Reset Gate 0C — Remote Ops Schema Specification

**Report ID:** tripp-os-reset-gate-0c-remote-ops-schema-spec.md
**Author:** Kimi (Tripp.OS Contract Authority)
**Date:** 2026-06-22
**Classification:** Schema Specification — Consumable by Codex and other builders
**Based on:** `runtime-trace` source patterns + `handoff_bundle_schemas.json` evidence

---

## Decision

> ### `TRIPP_OS_RESET_0C_PASS_REMOTE_OPS_SCHEMA_SPEC_READY_FOR_CONTROL_CONSUMPTION`

---

## 1. Design Principles

| Principle | Rationale |
|---|---|
| **Zod for runtime validation** | `runtime-trace` already uses Zod extensively (`config.ts`). Consistency. |
| **ULID for identifiers** | Lexicographically sortable, time-embedded, collision-resistant. |
| **ISO 8601 timestamps** | Universal, sortable, timezone-aware. |
| **Marker pattern** | Each state transition creates an immutable marker file. Audit trail built-in. |
| **Explicit versioning** | `envelopeVersion` field enables schema evolution without breaking changes. |
| **Type-safe by default** | TypeScript interfaces exported alongside Zod schemas for compile-time safety. |

---

## 2. Core Schemas

### 2.1 Shared Primitives

```typescript
// ── Primitive Schemas ──────────────────────────────────────────────────

import { z } from "zod";

export const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export type Ulid = z.infer<typeof UlidSchema>;

export const IsoTimestampSchema = z.string().datetime();
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

export const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+/);
export type Semver = z.infer<typeof SemverSchema>;

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export type Sha256 = z.infer<typeof Sha256Schema>;

export const EnvelopeVersionSchema = z.literal("tripp-os-remote-ops/1.0");
export type EnvelopeVersion = z.infer<typeof EnvelopeVersionSchema>;
```

### 2.2 Worker Identity

```typescript
// ── WorkerIdentity ─────────────────────────────────────────────────────

export const WorkerTypeSchema = z.enum([
  "codex",
  "hermes-bridge",
  "echo-local",
  "control-operator",
  "custom",
]);
export type WorkerType = z.infer<typeof WorkerTypeSchema>;

export const WorkerIdentitySchema = z.object({
  workerId: z.string().uuid(),         // Persistent across restarts
  workerType: WorkerTypeSchema,
  version: SemverSchema,               // Semver of worker software
  capabilities: z.array(z.string()),   // Task types this worker can process
  registeredAt: IsoTimestampSchema,
  hostInfo: z.object({
    platform: z.string(),
    hostname: z.string(),
    pid: z.number().int().positive(),
  }),
});
export type WorkerIdentity = z.infer<typeof WorkerIdentitySchema>;
```

### 2.3 Job Packet

```typescript
// ── JobPacket ──────────────────────────────────────────────────────────

export const JobSourceSchema = z.enum([
  "hermes",
  "codex",
  "api",
  "retry",
  "schedule",
]);
export type JobSource = z.infer<typeof JobSourceSchema>;

export const JobPacketSchema = z.object({
  // Identity
  jobId: UlidSchema,
  envelopeVersion: EnvelopeVersionSchema,

  // Task specification
  taskType: z.string().min(1),         // Registered task type identifier
  payload: z.unknown(),                // Task-specific payload (validated by task schema)
  payloadSchemaHash: Sha256Schema,     // SHA-256 of the Zod schema that validates payload

  // Provenance
  createdAt: IsoTimestampSchema,
  createdBy: z.string().uuid(),        // Worker identity that submitted
  source: JobSourceSchema,

  // Scheduling
  priority: z.number().int().min(0).default(100),
  queueName: z.string().min(1).default("default"),
  scheduledFor: IsoTimestampSchema.optional(),

  // Resilience
  maxRetries: z.number().int().min(0).max(10).default(3),
  timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
  tags: z.array(z.string()).default([]),
});
export type JobPacket = z.infer<typeof JobPacketSchema>;
```

**Validation:**
```typescript
const job = JobPacketSchema.parse({
  jobId: "01J5X2Y3Z4A5B6C7D8E9F0G1H2",
  envelopeVersion: "tripp-os-remote-ops/1.0",
  taskType: "codex-build",
  payload: { repo: "eOnoes/Tripp.OS", branch: "main" },
  payloadSchemaHash: "abc123...", // SHA-256
  createdAt: "2026-06-22T12:00:00Z",
  createdBy: "550e8400-e29b-41d4-a716-446655440000",
  source: "hermes",
  priority: 50,
  queueName: "build-queue",
  maxRetries: 3,
  timeoutMs: 300_000,
  tags: ["urgent", "os-build"],
});
```

---

## 3. Marker Schemas

### 3.1 Ready Marker

```typescript
// ── ReadyMarker ────────────────────────────────────────────────────────

export const ReadyMarkerSchema = z.object({
  markerType: z.literal("READY"),
  jobId: UlidSchema,
  queueName: z.string(),
  readyAt: IsoTimestampSchema,
  priority: z.number().int(),
});
export type ReadyMarker = z.infer<typeof ReadyMarkerSchema>;
```

### 3.2 Wake Marker

```typescript
// ── WakeMarker ─────────────────────────────────────────────────────────

export const WakeReasonSchema = z.enum([
  "scheduled",
  "lease-expired",
  "retry",
  "dependency-met",
]);
export type WakeReason = z.infer<typeof WakeReasonSchema>;

export const WakeMarkerSchema = z.object({
  markerType: z.literal("WAKE"),
  jobId: UlidSchema,
  wakeAt: IsoTimestampSchema,
  queueName: z.string(),
  reason: WakeReasonSchema,
});
export type WakeMarker = z.infer<typeof WakeMarkerSchema>;
```

### 3.3 Claim File

```typescript
// ── ClaimFile ──────────────────────────────────────────────────────────

export const ClaimFileSchema = z.object({
  markerType: z.literal("CLAIM"),
  jobId: UlidSchema,
  claimedBy: z.string().uuid(),        // Worker identity
  claimedAt: IsoTimestampSchema,
  leaseExpiry: IsoTimestampSchema,
  attemptNumber: z.number().int().positive(),
  workerVersion: SemverSchema,
});
export type ClaimFile = z.infer<typeof ClaimFileSchema>;
```

**Lease defaults:**
```typescript
export const DEFAULT_LEASE_SECONDS = 60;
export const MAX_LEASE_SECONDS = 300;

export function computeLeaseExpiry(
  claimedAt: string,
  leaseSeconds: number = DEFAULT_LEASE_SECONDS
): string {
  const capped = Math.min(leaseSeconds, MAX_LEASE_SECONDS);
  const expiry = new Date(claimedAt);
  expiry.setSeconds(expiry.getSeconds() + capped);
  return expiry.toISOString();
}
```

### 3.4 Heartbeat

```typescript
// ── Heartbeat ──────────────────────────────────────────────────────────

export const WorkerStatusSchema = z.enum([
  "idle",
  "working",
  "shutting-down",
]);
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export const HeartbeatMetricsSchema = z.object({
  jobsProcessed: z.number().int().nonnegative(),
  jobsFailed: z.number().int().nonnegative(),
  averageProcessingTimeMs: z.number().nonnegative(),
});
export type HeartbeatMetrics = z.infer<typeof HeartbeatMetricsSchema>;

export const HeartbeatSchema = z.object({
  markerType: z.literal("HEARTBEAT"),
  workerId: z.string().uuid(),
  jobId: UlidSchema.nullable(),        // null if idle
  timestamp: IsoTimestampSchema,
  status: WorkerStatusSchema,
  queueName: z.string(),
  metrics: HeartbeatMetricsSchema,
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
```

**Heartbeat constants:**
```typescript
export const HEARTBEAT_INTERVAL_MS = 15_000;     // 15 seconds
export const HEARTBEAT_MISS_THRESHOLD = 3;         // 3 consecutive misses
export const WORKER_DEAD_DETECTION_MS = HEARTBEAT_INTERVAL_MS * HEARTBEAT_MISS_THRESHOLD;
```

---

## 4. Result and Failure Schemas

### 4.1 Result Packet

```typescript
// ── ResultPacket ───────────────────────────────────────────────────────

export const ResultStatusSchema = z.enum([
  "success",
  "failure",
  "cancelled",
  "timeout",
]);
export type ResultStatus = z.infer<typeof ResultStatusSchema>;

export const ResultPacketSchema = z.object({
  markerType: z.literal("RESULT"),
  jobId: UlidSchema,
  workerId: z.string().uuid(),
  completedAt: IsoTimestampSchema,
  status: ResultStatusSchema,

  // Success path
  output: z.unknown().optional(),
  outputSchemaHash: Sha256Schema.optional(),

  // Failure path
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  isRetryable: z.boolean().optional(),

  // Evidence
  traceId: z.string(),                 // Links to runtime-trace ledger
  processingTimeMs: z.number().nonnegative(),
});
export type ResultPacket = z.infer<typeof ResultPacketSchema>;
```

### 4.2 Failure Packet

```typescript
// ── FailurePacket ──────────────────────────────────────────────────────

export const FailurePacketSchema = z.object({
  markerType: z.literal("FAILURE"),
  result: ResultPacketSchema,
  categorized: z.boolean(),
  escalationRequired: z.boolean(),
});
export type FailurePacket = z.infer<typeof FailurePacketSchema>;
```

### 4.3 Dead-Letter Packet

```typescript
// ── DeadLetterReason ───────────────────────────────────────────────────

export const DeadLetterReasonSchema = z.enum([
  "max-retries-exceeded",
  "non-retryable-error",
  "schema-validation-failed",
  "expired",
]);
export type DeadLetterReason = z.infer<typeof DeadLetterReasonSchema>;

// ── DeadLetterPacket ───────────────────────────────────────────────────

export const DeadLetterPacketSchema = z.object({
  markerType: z.literal("DEAD_LETTER"),
  jobId: UlidSchema,
  finalFailureAt: IsoTimestampSchema,
  reason: DeadLetterReasonSchema,
  originalJob: JobPacketSchema,
  finalResult: ResultPacketSchema,
  failureHistory: z.array(ResultPacketSchema), // All failed attempts
});
export type DeadLetterPacket = z.infer<typeof DeadLetterPacketSchema>;
```

**Dead-letter constants:**
```typescript
export const DEAD_LETTER_RETENTION_DAYS = 30;
export const DEAD_LETTER_MAX_HISTORY = 50;
```

### 4.4 Archive Policy

```typescript
// ── ArchivePolicy ──────────────────────────────────────────────────────

export const ArchivePolicySchema = z.object({
  markerType: z.literal("ARCHIVE"),
  jobId: UlidSchema,
  archivedAt: IsoTimestampSchema,
  retentionDays: z.number().int().positive().default(90),
  hotStorageDays: z.number().int().positive().default(7),
  compressionEnabled: z.boolean().default(true),
});
export type ArchivePolicy = z.infer<typeof ArchivePolicySchema>;
```

---

## 5. Retry and Backoff

### 5.1 Backoff Function

```typescript
// ── Backoff ────────────────────────────────────────────────────────────

export const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 300_000;    // 5 minutes

export function computeBackoff(attemptNumber: number): number {
  const exponential = Math.pow(2, attemptNumber) * BASE_BACKOFF_MS;
  return Math.min(exponential, MAX_BACKOFF_MS);
}

// Examples:
// attempt 1 → 2,000 ms
// attempt 2 → 4,000 ms
// attempt 3 → 8,000 ms
// attempt 5 → 32,000 ms
// attempt 8 → 256,000 ms
// attempt 9 → 300,000 ms (capped)
```

### 5.2 Retry Decision

```typescript
export function shouldRetry(
  result: ResultPacket,
  attemptNumber: number,
  maxRetries: number
): boolean {
  if (attemptNumber >= maxRetries) return false;
  if (result.status === "success") return false;
  if (result.status === "cancelled") return false;
  if (result.isRetryable === false) return false;
  return true;
}
```

---

## 6. Codex Worker Envelope

### 6.1 Envelope Schema

```typescript
// ── CodexWorkerEnvelope ────────────────────────────────────────────────

export const CodexWorkerEnvelopeSchema = z.object({
  envelopeVersion: z.literal("tripp-os-codex/1.0"),

  // Session management
  sessionId: z.string().uuid(),        // Persistent across reconnects
  reconnectToken: z.string().min(16),  // Resumes session after disconnect

  // Job context
  jobPacket: JobPacketSchema,
  claimFile: ClaimFileSchema,

  // Execution context
  workspacePath: z.string().min(1),
  env: z.record(z.string()),           // Sanitized environment variables
  secrets: z.record(z.string()),       // Key references only (values resolved at runtime)

  // Endpoints
  traceEndpoint: z.string().url(),     // Where to emit trace events
  resultEndpoint: z.string().url(),    // Where to post result

  // Safety limits
  maxOutputBytes: z.number().int().positive().default(10_485_760), // 10 MiB
  maxFileWrites: z.number().int().positive().default(1_000),
  maxFilesRead: z.number().int().positive().default(10_000),
  allowedPaths: z.array(z.string()).default([]),    // Empty = all paths allowed (dangerous)
  deniedPaths: z.array(z.string()).default([
    "/etc/passwd",
    "/etc/shadow",
    "~/.ssh/",
    ".env",
    ".git-credentials",
  ]),

  // Validation commands (run after Codex completes)
  validationCommands: z.object({
    preRun: z.array(z.string()).default([]),
    postRun: z.array(z.string()).default([]),
    cleanup: z.array(z.string()).default([]),
  }).default({ preRun: [], postRun: [], cleanup: [] }),

  // Operator approval
  operatorApprovalState: z.enum([
    "approved",
    "conditional",
    "auto-routed",
  ]).default("approved"),
  conditions: z.array(z.string()).default([]),
});
export type CodexWorkerEnvelope = z.infer<typeof CodexWorkerEnvelopeSchema>;
```

### 6.2 Forbidden Actions (Codex Worker)

```typescript
export const FORBIDDEN_ACTIONS = [
  "git push",            // No unauthorized code changes
  "git force-push",      // No history rewriting
  "npm publish",         // No unauthorized releases
  "pnpm publish",        // No unauthorized releases
  "rm -rf /",            // System destruction
  "eval(untrusted)",     // Code injection
] as const;

export type ForbiddenAction = typeof FORBIDDEN_ACTIONS[number];
```

---

## 7. Handoff Envelope (Control ←→ OS)

### 7.1 Envelope Schema

```typescript
// ── HandoffEnvelope ────────────────────────────────────────────────────

export const BuildSpecificationSchema = z.object({
  targetPackages: z.array(z.string()),
  targetRepo: z.string(),
  allowedCommands: z.array(z.string()),
  forbiddenActions: z.array(z.string()),
  timeoutMs: z.number().int().positive(),
  validationCommands: z.array(z.string()),
});
export type BuildSpecification = z.infer<typeof BuildSpecificationSchema>;

export const HandoffEnvelopeSchema = z.object({
  handoffId: UlidSchema,
  planId: UlidSchema,
  approvedPlanHash: Sha256Schema,       // Must match governance PlanDraftEnvelope.planHash
  buildSpecification: BuildSpecificationSchema,
  operatorConditions: z.array(z.string()),
  createdAt: IsoTimestampSchema,
});
export type HandoffEnvelope = z.infer<typeof HandoffEnvelopeSchema>;
```

---

## 8. Trace Event Integration

### 8.1 Remote Ops Trace Events

These events are emitted to the runtime-trace ledger:

```typescript
// ── RemoteOpsTraceEventType ────────────────────────────────────────────

export const RemoteOpsTraceEventTypeSchema = z.enum([
  "job_submitted",
  "job_ready",
  "job_claimed",
  "job_started",
  "job_completed",
  "job_failed",
  "job_timed_out",
  "job_cancelled",
  "job_archived",
  "job_dead_lettered",
  "claim_expired",
  "claim_renewed",
  "worker_registered",
  "worker_deregistered",
  "worker_marked_dead",
  "heartbeat_received",
  "heartbeat_missed",
  "recovery_sweep_started",
  "recovery_sweep_completed",
]);
export type RemoteOpsTraceEventType = z.infer<typeof RemoteOpsTraceEventTypeSchema>;
```

### 8.2 Integration with runtime-trace

The remote-ops queue uses `TraceBusAdapter` from `runtime-trace` to emit events:

```typescript
// Pseudocode — implementation detail for builders:
async function emitJobEvent(
  adapter: TraceBusAdapter,
  eventType: RemoteOpsTraceEventType,
  jobId: string,
  details: Record<string, unknown>
): Promise<void> {
  await adapter.trace(eventType, {
    summary: `Job ${jobId}: ${eventType}`,
    severity: "info",
    details: { jobId, ...details },
  });
}
```

---

## 9. Type Guards

```typescript
// ── Marker Type Guards ─────────────────────────────────────────────────

export function isReadyMarker(m: unknown): m is ReadyMarker {
  return ReadyMarkerSchema.safeParse(m).success;
}

export function isWakeMarker(m: unknown): m is WakeMarker {
  return WakeMarkerSchema.safeParse(m).success;
}

export function isClaimFile(m: unknown): m is ClaimFile {
  return ClaimFileSchema.safeParse(m).success;
}

export function isResultPacket(m: unknown): m is ResultPacket {
  return ResultPacketSchema.safeParse(m).success;
}

export function isDeadLetterPacket(m: unknown): m is DeadLetterPacket {
  return DeadLetterPacketSchema.safeParse(m).success;
}

export function isHeartbeat(m: unknown): m is Heartbeat {
  return HeartbeatSchema.safeParse(m).success;
}

// ── State Query Helpers ────────────────────────────────────────────────

export function isClaimExpired(claim: ClaimFile): boolean {
  return new Date(claim.leaseExpiry) < new Date();
}

export function isWorkerDead(
  lastHeartbeat: string,
  now: Date = new Date()
): boolean {
  const last = new Date(lastHeartbeat).getTime();
  return (now.getTime() - last) > WORKER_DEAD_DETECTION_MS;
}

export function canRetry(
  job: JobPacket,
  attemptNumber: number
): boolean {
  return attemptNumber < job.maxRetries;
}
```

---

## 10. File Layout (Implementation Target)

```
packages/remote-ops/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              ← All exports
    ├── schemas/              ← This specification, implemented
    │   ├── primitives.ts     ← Ulid, IsoTimestamp, Semver, Sha256
    │   ├── job.ts            ← JobPacket, JobSource
    │   ├── marker.ts         ← ReadyMarker, WakeMarker, ClaimFile
    │   ├── heartbeat.ts      ← Heartbeat, HeartbeatMetrics
    │   ├── result.ts         ← ResultPacket, ResultStatus
    │   ├── failure.ts        ← FailurePacket
    │   ├── dead-letter.ts    ← DeadLetterPacket, DeadLetterReason
    │   ├── archive.ts        ← ArchivePolicy
    │   ├── worker.ts         ← WorkerIdentity, WorkerType
    │   ├── envelope.ts       ← CodexWorkerEnvelope
    │   ├── handoff.ts        ← HandoffEnvelope, BuildSpecification
    │   └── trace-events.ts   ← RemoteOpsTraceEventType
    ├── queue/                ← Queue implementation (future)
    ├── worker/               ← Worker lifecycle (future)
    └── __tests__/            ← Tests (future)
```

---

## 11. Versioning Strategy

| Version | Status | Changes |
|---|---|---|
| `tripp-os-remote-ops/1.0` | **Current** | Initial spec — all schemas above |
| `tripp-os-remote-ops/1.1` | Planned | Add batch job support |
| `tripp-os-remote-ops/2.0` | Future | Add streaming job support |

**Evolution rule:** New fields are `optional`. Removing fields requires major version bump. `envelopeVersion` field must match the schema version used.

---

## What Was Not Done

- No `.ts` files created in `packages/remote-ops/`
- No runtime code implemented
- No queue mechanics implemented
- No tests written
- No package.json created for remote-ops

---

## Recommended Next Marker

> ### `READY_FOR_CODEX_TRIPP_CONTROL_REMOTE_OPS_CONTRACT_CONSUMPTION_PLAN`

This spec is ready for:
1. **Codex** to consume for Control-side implementation planning
2. **Echo** to validate against local environment
3. **Agent-bus recovery** to proceed (schemas define what agent-bus must provide)

---

**End of 0C Report**
