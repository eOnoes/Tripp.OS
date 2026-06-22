# Tripp.OS Reset Gate 0B — Package Stabilization and Remote Ops Contract Plan

**Report ID:** tripp-os-reset-gate-0b-package-stabilization-and-remote-ops-contract-plan.md
**Author:** Kimi (Tripp.OS Contract Authority)
**Date:** 2026-06-22
**Based on:** Direct source inspection of `cff4afe25b0443ff652f76d4f14907cbe67190a7`

---

## Decision

> ### `TRIPP_OS_RESET_0B_PASS_PACKAGE_STABILIZATION_PLAN_READY_FOR_REMOTE_OPS_SCHEMA_SPEC`

**Rationale:** Package state is fully mapped. Current runtime-trace patterns provide a solid foundation. Remote-ops contract builds on existing queue semantics. Agent-bus recovery is the critical path blocker but does not block contract planning. Proceed to 0C.

---

## 1. Current Package/Workspace State

### Actual Structure (Verified)

```
Tripp.OS/
├── .gitignore
├── README.md
├── tripp-os-full-package.zip          ← Full archive (157 KB)
├── tripp-os-source-extract/
│   └── agent-bus-handoff/
│       └── packages/
│           └── runtime-trace/         ← ONLY package present
│               ├── package.json       ← @tripp-os/runtime-trace v0.1.0
│               ├── tsconfig.json
│               └── src/
│                   ├── index.ts       ← Public API exports
│                   ├── config.ts      ← Zod schemas + validation
│                   ├── writer.ts      ← TraceWriter
│                   ├── reader.ts      ← TraceReader
│                   ├── adapter.ts     ← TraceBusAdapter
│                   ├── queue.ts       ← TracedQueue/UntracedQueue
│                   ├── queue-handoff.ts
│                   ├── handoff.ts
│                   ├── fallback.ts    ← Sink chain (stderr, memory, file, noop)
│                   ├── compress.ts
│                   ├── diff.ts
│                   ├── health.ts
│                   ├── dashboard.ts
│                   ├── benchmark.ts
│                   ├── cli.ts
│                   └── __tests__/     ← 9 test files
└── tripp-os-static-evidence-package/  ← 17 evidence files + MANIFEST.sha256
```

### Key Facts

| Property | Value |
|---|---|
| **Package count** | 1 (`runtime-trace`) |
| **Package location** | Nested: `tripp-os-source-extract/agent-bus-handoff/packages/runtime-trace/` |
| **Workspace** | None — not a monorepo |
| **Root package.json** | None |
| **Lockfile** | None |
| **Package manager** | npm implied (no pnpm, no yarn) |
| **agent-bus source** | **MISSING** — only referenced via imports |
| **agent-bus in zip** | **NOT FOUND** — zip contains only runtime-trace files |

---

## 2. Package Boundary Plan

### 2.1 Target Monorepo Structure

```
Tripp.OS/
├── package.json                       ← Root workspace manifest
├── pnpm-workspace.yaml               ← pnpm workspace definition
├── pnpm-lock.yaml                    ← Lockfile (generated at implementation)
├── .gitattributes                    ← LF enforcement
├── .editorconfig                     ← Editor consistency
├── tsconfig.base.json                ← Shared TypeScript config
├── README.md                         ← Updated to reflect actual structure
├── packages/
│   ├── shared-schemas/               ← NEW
│   │   ├── package.json
│   │   └── src/
│   │       └── index.ts              ← All cross-package types + Zod schemas
│   ├── agent-bus/                    ← RECOVERY TARGET (missing)
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts              ← Packet I/O, trace events, types
│   │       ├── packet.ts             ← Task/Result/Review packet types
│   │       ├── trace-event.ts        ← AgentBusTraceEvent types
│   │       ├── transport.ts          ← File-based transport
│   │       └── ...
│   ├── runtime-trace/                ← MIGRATE from nested path
│   │   ├── package.json              ← @tripp-os/runtime-trace
│   │   ├── tsconfig.json             ← Uses shared-schemas types
│   │   └── src/
│   │       └── (existing 15 files + 9 tests)
│   ├── governance-pipeline/          ← NEW (future)
│   │   └── (placeholder only at this stage)
│   └── remote-ops/                   ← NEW (future)
│       └── (placeholder only at this stage)
├── evidence/                         ← Renamed from tripp-os-static-evidence-package
│   └── ...
└── scripts/
    └── (verification scripts)
```

### 2.2 Migration Path

| Step | Action | Owner | Gate |
|---|---|---|---|
| 1 | Create root `package.json` + `pnpm-workspace.yaml` | Echo | RESET-0B-IMPL |
| 2 | Create `packages/shared-schemas/` with extracted types | Kimi | RESET-0B-IMPL |
| 3 | **Recover `packages/agent-bus/`** | Kimi/Echo | AGENT-BUS-RECOVERY |
| 4 | Migrate `runtime-trace` to `packages/runtime-trace/` | Echo | RESET-0B-IMPL |
| 5 | Update runtime-trace imports to use workspace packages | Echo | RESET-0B-IMPL |
| 6 | Generate `pnpm-lock.yaml` | Echo | RESET-0B-IMPL |
| 7 | Add `.gitattributes` + `.editorconfig` | Echo | RESET-0B-IMPL |
| 8 | Run tests from clean clone | Echo | RESET-0B-VALIDATION |

### 2.3 Package Ownership

| Package | Owns | Consumes From | Status |
|---|---|---|---|
| `shared-schemas` | All Zod schemas, TypeScript interfaces, constants | Nothing (leaf) | **NEW** |
| `agent-bus` | Packet I/O (`writeTaskPacket`, `readTaskPacket`, etc.), trace events, file transport | `shared-schemas` | **MISSING — recovery required** |
| `runtime-trace` | TraceWriter, TraceReader, TraceBusAdapter, queue wrappers, handoff, compression | `shared-schemas`, `agent-bus` | ✅ Exists, needs migration |
| `governance-pipeline` | Governance phase state machine, plan versioning, approval workflows | `shared-schemas` | **NEW — placeholder only** |
| `remote-ops` | Durable job queue, worker lifecycle, claim/lease, heartbeat, dead-letter, archive | `shared-schemas`, `agent-bus`, `runtime-trace` | **NEW — contract only** |

### 2.4 Dependency Graph

```
shared-schemas (leaf — no internal deps)
    ↑
agent-bus
    ↑       ↘
runtime-trace    governance-pipeline
    ↑              ↑
    └──────┬───────┘
           ↓
      remote-ops (depends on all above)
```

---

## 3. Remote Ops Queue Contract

### 3.1 Design Foundation

The existing `runtime-trace/src/queue.ts` already defines queue semantics:

```typescript
// Existing patterns (from queue.ts):
interface TrippQueue {
  enqueueTask(packet, options?): Promise<string>     // → file path
  readPendingTask(filePath): Promise<ExternalAgentTaskPacket>
  claimTask(packetId, agentId, agentRole?): Promise<void>
  writeResult(packet, options?): Promise<string>
  writeReview(packet, options?): Promise<{ jsonPath, mdPath, reviewId }>
  archivePacket(filePath, options?): Promise<string>
  rejectPacket(filePath, reason, options?): Promise<string>
  health(): QueueHealth
}
```

**The Remote Ops Queue contract extends these patterns** with:
- Durable persistence (survives crashes)
- Worker identity and lease management
- Heartbeat-based liveness detection
- Dead-letter handling for failed jobs
- Archive and retention policies
- No-polling default (push-based notification)

### 3.2 Contract: Remote Ops Queue

```
┌─────────────────────────────────────────────────────────────────┐
│                    Remote Ops Queue Contract                     │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │  SUBMIT     │───►│    READY    │───►│      CLAIMED        │ │
│  │  (JobPacket)│    │  (ReadyMarker│    │   (ClaimFile)       │ │
│  └─────────────┘    └─────────────┘    └─────────────────────┘ │
│                                                │                │
│                         ┌──────────────────────┘                │
│                         ▼                                       │
│                ┌─────────────────┐    ┌─────────────────────┐   │
│                │    ACTIVE       │───►│     COMPLETED       │   │
│                │  (heartbeat)    │    │   (ResultPacket)    │   │
│                └─────────────────┘    └─────────────────────┘   │
│                         │                      │                │
│                         ▼                      ▼                │
│                ┌─────────────────┐    ┌─────────────────────┐   │
│                │   TIMED OUT     │    │      ARCHIVED       │   │
│                │  (lease expiry) │    │   (ArchiveEntry)    │   │
│                └─────────────────┘    └─────────────────────┘   │
│                         │                                       │
│                         ▼                                       │
│                ┌─────────────────┐    ┌─────────────────────┐   │
│                │    RETRY        │    │     DEAD LETTER     │   │
│                │  (WakeMarker)   │    │  (DeadLetterPacket) │   │
│                └─────────────────┘    └─────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Schema Families

#### Job Packet

```typescript
interface JobPacket {
  jobId: string;                    // ULID — lexicographically sortable
  envelopeVersion: "tripp-os-remote-ops/1.0";

  // Task specification
  taskType: string;                 // Registered task type (e.g., "codex-build", "audit-review")
  payload: unknown;                 // Task-specific payload
  payloadSchemaHash: string;        // SHA-256 of validating Zod schema

  // Provenance
  createdAt: string;                // ISO 8601
  createdBy: string;                // Worker identity that submitted
  source: "hermes" | "codex" | "api" | "retry" | "schedule";

  // Scheduling
  priority: number;                 // 0 = highest, default = 100
  queueName: string;                // Target queue partition

  // Resilience
  maxRetries: number;               // Default: 3
  timeoutMs: number;                // Default: 300000 (5 min)
  tags: string[];
}
```

#### Ready Marker

Created when:
- Job submitted without `scheduledFor`
- Scheduled job's time arrives
- Retry backoff expires
- Crashed worker's claim released

```typescript
interface ReadyMarker {
  markerType: "READY";
  jobId: string;
  queueName: string;
  readyAt: string;                  // ISO 8601
  priority: number;
}
```

#### Wake Marker

Stored in deferred queue, ordered by `wakeAt`.

```typescript
interface WakeMarker {
  markerType: "WAKE";
  jobId: string;
  wakeAt: string;                   // ISO 8601 — when to promote to READY
  queueName: string;
  reason: "scheduled" | "lease-expired" | "retry" | "dependency-met";
}
```

#### Claim File

Atomic claim. First-writer-wins.

```typescript
interface ClaimFile {
  markerType: "CLAIM";
  jobId: string;
  claimedBy: string;                // Worker identity
  claimedAt: string;                // ISO 8601
  leaseExpiry: string;              // ISO 8601
  attemptNumber: number;            // 1-indexed
  workerVersion: string;            // Semver of worker software
}
```

**Lease Policy:**
- Default lease: 60 seconds
- Maximum lease: 300 seconds
- Renewable: Worker updates `leaseExpiry` before expiration
- On expiry: Job returns to ready queue, `attemptNumber` increments

#### Heartbeat

```typescript
interface Heartbeat {
  markerType: "HEARTBEAT";
  workerId: string;
  jobId: string | null;             // null if idle
  timestamp: string;                // ISO 8601
  status: "idle" | "working" | "shutting-down";
  queueName: string;
  metrics: {
    jobsProcessed: number;
    jobsFailed: number;
    averageProcessingTimeMs: number;
  };
}
```

**Rules:**
- Interval: 15 seconds (1/4 of default lease)
- Miss threshold: 3 consecutive missing → worker marked dead
- Dead worker releases all claims

#### Result Packet

```typescript
interface ResultPacket {
  markerType: "RESULT";
  jobId: string;
  workerId: string;
  completedAt: string;              // ISO 8601
  status: "success" | "failure" | "cancelled" | "timeout";

  // Success path
  output?: unknown;
  outputSchemaHash?: string;

  // Failure path
  errorCode?: string;
  errorMessage?: string;
  isRetryable?: boolean;

  // Evidence
  traceId: string;                  // Links to runtime-trace ledger
  processingTimeMs: number;
}
```

#### Failure Packet

```typescript
interface FailurePacket {
  markerType: "FAILURE";
  result: ResultPacket;
  categorized: boolean;
  escalationRequired: boolean;
}
```

#### Dead-Letter Packet

```typescript
interface DeadLetterPacket {
  markerType: "DEAD_LETTER";
  jobId: string;
  finalFailureAt: string;           // ISO 8601
  reason: "max-retries-exceeded" | "non-retryable-error" | "schema-validation-failed" | "expired";
  originalJob: JobPacket;
  finalResult: ResultPacket;
  failureHistory: ResultPacket[];   // All failed attempts
}
```

**Policy:**
- Created when `attemptNumber >= maxRetries`
- Immutable after creation
- Retained for minimum 30 days
- Manual requeue creates new `JobPacket` with fresh `jobId`

#### Archive Policy

```typescript
interface ArchivePolicy {
  markerType: "ARCHIVE";
  jobId: string;
  archivedAt: string;               // ISO 8601
  retentionDays: number;            // Default: 90
  hotStorageDays: number;           // 7 (success), 30 (failed)
  compressionEnabled: boolean;
}
```

---

## 4. Lifecycle States

### 4.1 State Machine

```
[SUBMITTED] ──► [READY] ──► [CLAIMED] ──► [ACTIVE] ──► [COMPLETED]
                    │            │             │              │
                    │            │             ▼              ▼
                    │            │       [TIMED_OUT]     [ARCHIVED]
                    │            │             │
                    │            ▼             ▼
                    │      [LEASE_EXPIRED]  [RETRY]
                    │            │             │
                    │            └─────────────┘
                    │                  │
                    ▼                  ▼
               [WAKE] ──────────► [DEAD_LETTER]
```

### 4.2 State Transitions

| From | To | Trigger | Action |
|---|---|---|---|
| `SUBMITTED` | `READY` | Job submitted without schedule | Create ReadyMarker |
| `READY` | `CLAIMED` | Worker claims job | Create ClaimFile with lease |
| `CLAIMED` | `ACTIVE` | Worker starts processing | Update heartbeat, emit trace |
| `ACTIVE` | `COMPLETED` | Worker posts result | Create ResultPacket |
| `COMPLETED` | `ARCHIVED` | Retention period passes | Create ArchiveEntry |
| `CLAIMED` | `LEASE_EXPIRED` | Lease expires without renewal | Release claim |
| `LEASE_EXPIRED` | `RETRY` | `attemptNumber < maxRetries` | Create WakeMarker with backoff |
| `RETRY` | `READY` | Backoff expires | Promote WakeMarker → ReadyMarker |
| `RETRY` | `DEAD_LETTER` | `attemptNumber >= maxRetries` | Create DeadLetterPacket |
| `ACTIVE` | `TIMED_OUT` | `timeoutMs` exceeded | SIGTERM → SIGKILL → release |
| `TIMED_OUT` | `RETRY` or `DEAD_LETTER` | Same as LEASE_EXPIRED path | — |

---

## 5. Crash Recovery

### 5.1 Startup Recovery Protocol

```
On remote-ops startup:
  1. Load all CLAIM files from durable storage
  2. Cross-reference with latest worker heartbeats
  3. For claims belonging to dead workers (missed 3+ heartbeats):
     a. Release claim
     b. If attemptNumber < maxRetries:
        - Create WakeMarker with backoff
     c. Else:
        - Create DeadLetterPacket
  4. For WakeMarkers with wakeAt < now():
     a. Promote to ReadyMarker
  5. Scan for orphan jobs (JobPacket with no marker):
     a. Create ReadyMarker
  6. Emit recovery summary trace event
```

### 5.2 Stale Claim Recovery (Background Sweep)

```
Every 30 seconds (±5s jitter):
  1. Find all CLAIM files where leaseExpiry < now()
  2. For each expired claim:
     a. If worker heartbeat still active → soft warning
     b. If worker heartbeat missing → release claim
     c. If attemptNumber < maxRetries → create ReadyMarker
     d. Else → create DeadLetterPacket
  3. Find all WORKING workers with no recent heartbeat → mark dead
  4. Release all claims from dead workers
```

---

## 6. No-Polling Default

| Event | Mechanism |
|---|---|
| Job becomes ready | Server pushes notification via agent-bus channel |
| Worker wants work | Worker listens on notification channel |
| Heartbeat | Worker-initiated push |
| Lease renewal | Worker-initiated push before expiry |

**Fallback:** If push channel disconnects, worker may poll every **30 seconds maximum** while attempting to reconnect.

---

## 7. shared-agent-bus Boundaries

### 7.1 What agent-bus Owns (Contract)

- Packet file I/O: `writeTaskPacket`, `readTaskPacket`, `writeResultPacket`, etc.
- Trace event types: `AgentBusTraceEvent`, `CreateTraceEventInput`
- Transport layer: file-based message passing
- Packet types: `ExternalAgentTaskPacket`, `ExternalAgentResultPacket`, `ExternalAgentReviewPacket`

### 7.2 What runtime-trace Owns

- Trace persistence: `TraceWriter`, `TraceReader` — durable append-only ledger
- Trace adapter: `TraceBusAdapter` — wraps agent-bus ops with tracing
- Queue wrappers: `TracedQueue`, `UntracedQueue` — adds queue semantics
- Handoff bundles: evidence packages for Control intake

### 7.3 What remote-ops Owns

- Job lifecycle: JobPacket → ReadyMarker → ClaimFile → ResultPacket → Archive
- Worker management: identity, heartbeat, lease
- Dead-letter: failure categorization, retention
- Queue semantics: durable execution, crash recovery

### 7.4 Read/Write Boundaries

| Operation | agent-bus | runtime-trace | remote-ops |
|---|---|---|---|
| Write packet files | **WRITE** | calls via adapter | calls via queue |
| Read packet files | **WRITE** | calls via adapter | calls via queue |
| Write trace ledger | no-op | **WRITE** | calls via adapter |
| Write claim files | no-op | no-op | **WRITE** |
| Write heartbeat | no-op | no-op | **WRITE** |
| Write result packet | calls agent-bus | calls via adapter | **WRITE** (orchestrates) |
| Move to archive | **WRITE** | calls via adapter | calls via queue |
| Move to rejected | **WRITE** | calls via adapter | calls via queue |

**Rule:** agent-bus is the **primitive I/O layer**. runtime-trace adds **tracing**. remote-ops adds **lifecycle orchestration**. Each layer delegates down; no layer skips layers.

---

## 8. Tripp.Control References (But Does Not Own)

| Contract | Control May... | Control May NOT... |
|---|---|---|
| JobPacket | Submit jobs, read payloads | Define packet structure |
| ReadyMarker | Query queue status | Create ready markers directly |
| ClaimFile | View claims for audit | Write claim files |
| ResultPacket | Consume results, display | Define result structure |
| DeadLetterPacket | View dead letters, request requeue | Create dead letters |
| WorkerIdentity | Register workers, view capabilities | Define identity schema |
| TraceLedger | Query, display | Write trace events |
| Governance Phase | Own UX/policy decisions | Define phase schemas |

---

## 9. What Codex May Build Later

After OS contracts are finalized, Codex may implement:

| Component | Owner | When |
|---|---|---|
| Codex worker adapter | Codex (Control-side) | After worker envelope spec (0C) |
| Job submission API | Codex (Control-side) | After JobPacket schema |
| Result consumption | Codex (Control-side) | After ResultPacket schema |
| Operator dashboard UX | Codex (Control-side) | After trace ledger contract |
| Governance UI | Codex (Control-side) | After governance phase spec |

**Codex must NOT implement:**
- Queue mechanics (remote-ops owns)
- Packet I/O primitives (agent-bus owns)
- Trace persistence (runtime-trace owns)
- Claim/lease/heartbeat logic (remote-ops owns)

---

## 10. What Echo Must Verify Locally

Before worker execution is trusted, Echo must verify:

1. **Clean clone**: `git status --short` is empty
2. **Commit match**: HEAD matches origin/master
3. **Lockfile present**: `pnpm-lock.yaml` exists and installs cleanly
4. **Agent-bus resolved**: `@tripp-os/agent-bus` is present and buildable
5. **Tests pass**: `pnpm test` runs 130+ tests successfully
6. **Typecheck clean**: `pnpm typecheck` has zero errors
7. **No phantom deps**: `pnpm ls -r` shows all workspace links resolved
8. **Evidence fresh**: Evidence regenerated and MANIFEST.sha256 valid
9. **Line endings**: `.gitattributes` enforces LF, no CRLF in source files

---

## 11. Blockers and Risks

| # | Blocker/Risk | Level | Mitigation |
|---|---|---|---|
| 1 | **agent-bus source missing** | **CRITICAL** | Recovery audit: check git history, operator archive, external source |
| 2 | runtime-trace at wrong path | **LOW** | Migration to `packages/runtime-trace/` |
| 3 | No lockfile | **HIGH** | Generate `pnpm-lock.yaml` at implementation |
| 4 | Evidence stale | **MEDIUM** | Regenerate after `.gitattributes` added |
| 5 | No `.gitattributes` | **MEDIUM** | Add at implementation |
| 6 | Unverifiable test claims | **MEDIUM** | Run tests after agent-bus resolved |
| 7 | README/source mismatch | **LOW** | Update README to reflect actual structure |

---

## What Was Not Done

- No code implemented
- No package files created or modified
- No queue/wake/claim/lease/heartbeat/result/dead-letter files created
- No shared-agent-bus mutated
- No Tripp.Control or Tripp.Reason modified
- Tests not run (blocked by phantom deps)

---

## Recommended Next Marker

> ### `READY_FOR_TRIPP_OS_RESET_0C_REMOTE_OPS_SCHEMA_SPEC`

---

**End of 0B Report**
