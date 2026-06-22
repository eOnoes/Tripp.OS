# Tripp.OS Trace Bus Adapter — Limited Production Rollout Plan

**Date:** 2026-06-07
**Package:** @tripp-os/runtime-trace v0.1.0
**Classification:** internal-tripp-os-runtime-trace
**Operator Decision:** APPROVE_LIMITED_PRODUCTION_TRACED_QUEUE

---

## 1. Production Eligibility

### Approved Instance Profile

| Requirement | Value | Rationale |
|---|---|---|
| **traceRoot** | Dedicated directory, isolated from shared-agent-bus, Tripp.Control, and Tripp.Reason paths | Prevents cross-system contamination |
| **Disk capacity** | Minimum 500 MB free at startup; alert at 80% full; stop at 95% full | Accommodates rotation with headroom |
| **actorType** | Must be set to a specific role (e.g., `openclaw_tripp`) | Identifies the traced agent in all events |
| **actorId** | Must be a unique, non-empty identifier per instance | Distinguishes instances in shared traceRoot |
| **runId** | Must be set per production run | Enables correlation across a single run |
| **checksumEnabled** | Must be `true` | Guarantees ledger integrity |
| **rotationEnabled** | Must be `true` | Prevents unbounded ledger growth |
| **maxLedgerBytes** | Recommended 50 MB (52428800) | Balances rotation frequency with file size |
| **maxLedgerFiles** | Recommended 30 | Retains ~1.5 GB of rotated history |
| **fsyncOnAppend** | Recommended `true` for production | Durability over speed |
| **fallbackSinks** | Must include at least `stderr` and `memory` (maxEvents ≥ 1000) | Ensures trace events survive primary sink failure |

### Operator Approval Record

Before any production instance enables traced queue mode, the operator must document:

```json
{
  "$schema": "internal/tripp-os-trace-queue-production-approval-v1",
  "approved_at": "<ISO timestamp>",
  "approved_by": "<operator identifier>",
  "instance_id": "<unique instance identifier>",
  "trace_root": "<absolute path>",
  "actor_type": "<role>",
  "actor_id": "<instance identifier>",
  "max_events_first_run": 1000,
  "max_duration_first_run_hours": 24,
  "rollback_contact": "<operator contact>",
  "health_review_interval_hours": 4,
  "stop_conditions_acknowledged": true
}
```

### Instances That May NOT Enable Traced Queue Mode

- Any instance sharing a traceRoot with another active traced queue
- Any instance without a dedicated, writable traceRoot directory
- Any instance where the operator has not executed a rollback drill
- Any instance with `fsyncOnAppend: false` and no documented reason
- Any instance where Tripp.Control or Tripp.Reason paths could be reached

---

## 2. Enablement Procedure

### Prerequisites Checklist

- [ ] Operator approval record documented (Section 1)
- [ ] Rollback drill completed in staging (Fixture 5 validated)
- [ ] traceRoot directory created with correct permissions (755)
- [ ] Disk space verified ≥ 500 MB free
- [ ] `validateTraceConfig()` passes with proposed config
- [ ] `generateQueueHandoff()` produces valid bundle from staging test

### Enablement Steps

```typescript
// Step 1: Validate configuration
const config = validateTraceConfig({
  traceRoot: "/var/tripp/trace/openclaw-prod-001",  // ISOLATED PATH
  ledgerFileName: "agent-bus-trace.jsonl",
  fsyncOnAppend: true,
  checksumEnabled: true,
  rotationEnabled: true,
  maxLedgerBytes: 50 * 1024 * 1024,
  maxLedgerFiles: 30,
  fallbackSinks: [
    { type: "stderr" },
    { type: "memory", maxEvents: 1000 },
  ],
});

// Step 2: Create adapter with explicit identity
const adapter = createTraceBusAdapter({
  traceConfig: config,
  actorType: "openclaw_tripp",
  actorId: "openclaw-prod-001",
  runId: "prod-run-2026-06-07-001",
  tags: ["production", "limited-rollout"],
});

// Step 3: Create traced queue (explicit opt-in)
const queue = createTracedQueue({ adapter, workdir });

// Step 4: Verify mode
console.assert(queue.mode === "traced");
console.assert(isTracedQueue(queue) === true);

// Step 5: Confirm default untraced mode globally
// Other queues on other instances must still default to untraced.
// This is enforced by API: createUntracedQueue() is the default factory.

// Step 6: Confirm rollback available
console.assert(typeof queue.rollbackToUntracedQueue === "undefined");
// rollbackToUntracedQueue is a top-level import, always available.
```

### What Must NOT Happen During Enablement

- `createTracedQueue()` must NOT be called without explicit `TraceBusAdapter`
- `process.env.TRACED_QUEUE_MODE` must NOT be used (there is no such env var)
- `traceRoot` must NOT be a shared or system directory
- `actorId` must NOT be empty or generic (e.g., `"default"`)
- `fsyncOnAppend` must NOT be `false` without documented exception

---

## 3. Initial Run Protocol

### Scope Limits

| Limit | Value | Purpose |
|---|---|---|
| Max events (first run) | 1,000 | Bounded exposure |
| Max duration (first run) | 24 hours | Time-boxed validation |
| Max ledger size | 50 MB per file | Predictable rotation |
| Max rotated files | 30 | Predictable disk usage |

### Required Lifecycle Operations

During the initial run, the operator must observe all 7 lifecycle event types:

1. `packet_created` — via `enqueueTask()`
2. `packet_read` — via `readPendingTask()`
3. `packet_claimed` — via `claimTask()`
4. `result_written` — via `writeResult()`
5. `warden_verdict_recorded` — via `writeReview()`
6. `packet_archived` — via `archivePacket()`
7. `packet_rejected` — via `rejectPacket()`

### Required Health Checks (every 4 hours)

```typescript
const health = adapter.health();
```

| Check | Pass Criteria | Action if Fail |
|---|---|---|
| `health.writable` | `true` | Investigate disk/permissions |
| `health.degraded` | `false` | Investigate fallback frequency |
| `health.fallbackAppends` | `< 10` since last check | If ≥ 10, primary sink may be failing |
| `health.totalAppends` | Monotonically increasing | If stale, writer may be stuck |

### Required Validation (end of initial run)

1. **Trace validation**: `reader.validate()` must report `malformedLines: 0`
2. **Checksum verification**: `reader.verifyChecksum()` must return `true`
3. **Event count**: Actual events must match expected count ± 0
4. **Event ID uniqueness**: All event IDs must be unique
5. **Handoff bundle**: `generateQueueHandoff()` must produce valid bundle
6. **Dashboard**: `generateDashboard()` must produce accurate HTML (if supported)

---

## 4. Monitoring and Health Review

### Trace Writer Health Fields

```typescript
interface TraceHealthStatus {
  writable: boolean;          // Primary sink accepting writes
  degraded: boolean;          // Fallback sink active
  fallbackAppends: number;    // Events written to fallback since start
  totalAppends: number;       // Total events written
  currentLedgerFile: string;  // Active ledger path
  currentLedgerBytes: number; // Active ledger size
}
```

### Degraded/Fallback Criteria

| Condition | Severity | Response |
|---|---|---|
| `degraded: true` for < 5 minutes | Warning | Monitor, check disk/permissions |
| `degraded: true` for ≥ 5 minutes | Critical | Initiate rollback review |
| `fallbackAppends` increases by ≥ 10 in 1 hour | Critical | Primary sink failure, investigate immediately |
| `fallbackAppends` increases by 1-9 in 1 hour | Warning | Intermittent primary sink issues |

### Disk Usage Criteria

| Usage | Severity | Response |
|---|---|---|
| < 50% | Normal | Continue |
| 50-79% | Info | Plan cleanup or expansion |
| 80-94% | Warning | Reduce retention or expand disk |
| ≥ 95% | Critical | Stop traced mode, initiate rollback |

### Rotation/Checksum Criteria

| Check | Pass | Fail |
|---|---|---|
| Rotated files have `.sha256` sidecars | All rotated files | Missing checksums = integrity risk |
| Active ledger has no checksum sidecar (by design) | No `.sha256` for active | Unexpected sidecar = naming bug |
| `verifyChecksum()` on rotated files | All return `true` | Any `false` = corruption detected |
| No duplicate rotated filenames | All unique | Duplicate = collision-safe naming bug |

---

## 5. Rollback Protocol

### When to Rollback

- Degraded health persists ≥ 5 minutes
- Disk usage ≥ 95%
- Checksum validation fails
- Unexpected event count mismatch
- Any boundary violation detected
- Operator discretion

### Manual Rollback Steps

```typescript
// Step 1: Record pre-rollback state
const preHealth = adapter.health();
const preEventCount = preHealth.totalAppends;

// Step 2: Execute rollback
const untracedQueue = rollbackToUntracedQueue(queue, "<reason>");

// Step 3: Verify rollback
console.assert(untracedQueue.health().mode === "untraced");
console.assert(untracedQueue.getState() === null);
console.assert(untracedQueue.rollbackInfo !== undefined);
console.assert(untracedQueue.rollbackInfo.reason === "<reason>");
console.assert(untracedQueue.rollbackInfo.preRollbackAppends === preEventCount);

// Step 4: Emit one post-rollback operation
await untracedQueue.enqueueTask(packet, { workdir });

// Step 5: Verify no new trace events
const postEvents = await reader.search({ limit: 10000 });
console.assert(postEvents.length === preEventCount);

// Step 6: Preserve evidence
// Copy traceRoot to archive location
// Copy handoff bundle to archive location
// Log rollbackInfo with timestamp
```

### Evidence Preservation Steps

1. Copy traceRoot directory to archive location
2. Copy handoff bundle to archive location
3. Log `rollbackInfo` (reason, timestamp, preRollbackAppends)
4. Do NOT delete trace files
5. Do NOT delete or modify packet files

### Post-Rollback Verification

- [ ] `untracedQueue.health().mode === "untraced"`
- [ ] `untracedQueue.getState() === null`
- [ ] Post-rollback operation emits 0 new trace events
- [ ] Pre-rollback trace files remain readable
- [ ] Pre-rollback handoff bundle remains valid
- [ ] `rollbackInfo` is complete and logged

### What Must NOT Happen During Rollback

- Do NOT delete trace files
- Do NOT modify packet files
- Do NOT call `createTracedQueue()` again without new operator approval
- Do NOT treat rollback as a failure — it is a controlled safety operation
- Do NOT restart the process and expect traced mode to resume automatically

### Operator Notification Text (Template)

```
TRACED QUEUE MODE ROLLED BACK
Instance: <instance_id>
Reason: <reason>
Timestamp: <ISO timestamp>
Pre-rollback events: <count>
Trace archive: <archive_path>
Handoff bundle: <bundle_path>
Queue mode is now UNTRACED.
New operations will not be traced.
Pre-rollback evidence is preserved.
```

---

## 6. Stop Conditions

### Automatic Stop Conditions (must halt traced mode immediately)

| Condition | Threshold | Detection |
|---|---|---|
| Primary trace write failure rate | ≥ 1% of writes failing | `fallbackAppends / totalAppends > 0.01` |
| Degraded health duration | ≥ 5 minutes continuous | Timer on `health.degraded === true` |
| Disk usage | ≥ 95% | `fs.stat(traceRoot)` or OS metric |
| Checksum validation failure | Any rotated ledger fails `verifyChecksum()` | Periodic checksum scan |
| Event count mismatch | Actual ≠ Expected by > 0 | Post-run validation |
| Boundary violation | Any Control/Reason/shared-agent-bus mutation | Safety monitoring |

### Warning Conditions (operator must investigate within 1 hour)

| Condition | Threshold |
|---|---|
| Degraded health | Any occurrence, even brief |
| Disk usage | 80-94% |
| Fallback appends | 1-9 per hour |
| Rotation frequency | > 10 rotations per hour |

### Info Conditions (log only, no action required)

| Condition | Threshold |
|---|---|
| Disk usage | 50-79% |
| Rotation frequency | 1-10 rotations per hour |
| Fallback appends | 0 per hour |

---

## 7. Post-Rollout Audit Requirements

### Timing

- Initial post-rollout audit: Within 48 hours of first run completion
- Ongoing audits: Weekly for first month, then monthly

### Required Checks

| # | Check | Method | Pass Criteria |
|---|---|---|---|
| 1 | Expected vs actual trace events | `reader.search()` | Count matches, all types present |
| 2 | Handoff bundle validation | `validateQueueHandoffBundle()` | `valid: true`, 0 errors |
| 3 | Checksum verification | `reader.verifyChecksum()` on active + rotated | All `true` |
| 4 | Rollback availability | Verify `rollbackToUntracedQueue` importable | Function exists, documented |
| 5 | Default mode untraced | `createUntracedQueue()` on separate instance | Mode `"untraced"` |
| 6 | No forbidden behavior | Safety search + boundary checklist | All clean |
| 7 | Disk usage trend | `fs.stat(traceRoot)` | Stable or decreasing |
| 8 | Event ID uniqueness | `new Set(eventIds).size === eventIds.length` | 100% unique |
| 9 | Timestamp monotonicity | Compare `createdAt` fields | No out-of-order events |
| 10 | Correlation fields | Check `runId`, `actorType`, `actorId` | Consistent across all events |

### Audit Documentation

```json
{
  "$schema": "internal/tripp-os-trace-queue-post-rollout-audit-v1",
  "audited_at": "<ISO timestamp>",
  "audited_by": "<operator identifier>",
  "instance_id": "<instance identifier>",
  "run_id": "<run identifier>",
  "event_count_expected": 1000,
  "event_count_actual": 1000,
  "malformed_lines": 0,
  "checksums_valid": true,
  "all_event_ids_unique": true,
  "timestamps_monotonic": true,
  "handoff_bundle_valid": true,
  "default_mode_untraced": true,
  "no_forbidden_behavior": true,
  "recommendation": "<decision option>"
}
```

---

## 8. Decision Options After Rollout

### Option A: KEEP_LIMITED_PRODUCTION_TRACED_QUEUE

**Use when:** Initial run passes all checks, health is stable, operator is satisfied.

**Scope:** Continue traced queue mode on the approved instance(s) with the same constraints.

**Required evidence:**
- Post-rollout audit (Section 7) all checks pass
- Health has been stable for ≥ 1 week
- No stop conditions triggered
- Operator acknowledges ongoing monitoring requirement

**Next marker:** `TRIPP_OS_TRACE_BUS_ADAPTER_LIMITED_PRODUCTION_MAINTAINED`

---

### Option B: EXPAND_PRODUCTION_TRACED_QUEUE

**Use when:** Initial run is successful and operator wants to enable traced queue on additional instances.

**Scope:** Each new instance requires its own:
- Operator approval record (Section 1)
- Enablement procedure (Section 2)
- Initial run protocol (Section 3)
- Post-rollout audit (Section 7)

**Required evidence:**
- ≥ 2 existing instances with KEEP status
- No boundary violations on existing instances
- Operator acknowledges per-instance approval requirement

**Next marker:** `READY_FOR_TRIPP_OS_TRACE_BUS_ADAPTER_EXPANDED_PRODUCTION_APPROVAL`

---

### Option C: ROLLBACK_TO_UNTRACED_PRODUCTION_QUEUE

**Use when:** Any stop condition triggered, or operator decides traced mode is not appropriate.

**Scope:** Rollback the approved instance(s) to untraced mode. Preserve all evidence.

**Required evidence:**
- Rollback protocol (Section 5) fully executed
- Evidence preserved and archived
- `rollbackInfo` logged
- Post-rollback verification complete

**Next marker:** `TRIPP_OS_TRACE_BUS_ADAPTER_PRODUCTION_TRACED_QUEUE_ROLLED_BACK`

---

### Option D: REQUEST_PRODUCTION_FIXES

**Use when:** Issues found that require code changes before traced queue can continue.

**Scope:** Keep traced queue paused (do not rollback yet if evidence is still being collected). Request specific fixes.

**Required evidence:**
- Specific issue documented with reproduction steps
- Trace evidence preserved showing the issue
- Handoff bundle generated at time of issue
- Proposed fix scope defined

**Next marker:** `READY_FOR_TRIPP_OS_TRACE_BUS_ADAPTER_PRODUCTION_FIXES`

---

## Summary

| Item | Status |
|---|---|
| Production eligibility criteria | Defined |
| Enablement procedure | 6 steps, explicit opt-in |
| Initial run protocol | 1000 events / 24 hours / 7 lifecycle types |
| Monitoring intervals | Every 4 hours |
| Stop conditions | 6 automatic, 4 warning, 2 info |
| Rollback protocol | 6 steps, evidence preservation mandatory |
| Post-rollout audit | 10 checks, 48-hour window |
| Decision options | 4 options with clear criteria |

**This plan is designed to be conservative, evidence-heavy, and operator-controlled. Traced queue mode will not activate itself, will not expand without explicit approval, and will always have a clean rollback path.**

---

**Decision:**

```
TRIPP_OS_TRACE_BUS_ADAPTER_LIMITED_PRODUCTION_ROLLOUT_PLAN_PASS_READY_FOR_INITIAL_ROLLOUT
```

**Next Marker:** `READY_FOR_TRIPP_OS_TRACE_BUS_ADAPTER_INITIAL_LIMITED_PRODUCTION_ROLLOUT`
