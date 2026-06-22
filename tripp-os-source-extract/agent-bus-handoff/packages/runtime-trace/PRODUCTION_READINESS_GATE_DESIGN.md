# Tripp.OS Trace Bus Adapter — Production Readiness Gate Design

**Date:** 2026-06-07
**Package:** @tripp-os/runtime-trace v0.1.0
**Classification:** internal-tripp-os-runtime-trace
**Staging Status:** APPROVED for controlled staging deployment
**Production Status:** NOT APPROVED — requires this gate

---

## Overview

This document designs the production readiness gate for traced queue mode. It defines 8 fixture scenarios, each with required evidence, pass/fail criteria, safety boundaries, and rollback requirements. Upon completion of all fixtures, the operator selects one of 4 production decision options.

**Default mode remains untraced.** Traced mode remains explicit opt-in only. No env-var activation. All tests use isolated temp directories.

---

## Production Readiness Fixture Matrix

| # | Fixture | Risk Addressed | Isolation Strategy |
|---|---|---|---|
| 1 | Disk-full simulation | Trace loss when filesystem full | Temp mount with size limit or mocked fs.writeFile |
| 2 | High-volume long-run | Degradation under sustained load | Isolated temp traceRoot, 1000+ synthetic events |
| 3 | Permission failure recovery | Mid-run permission changes | chmod on isolated traceRoot mid-test |
| 4 | Restart recovery | Process restart continuity | New TraceReader on existing ledger files |
| 5 | Operator rollback drill | Manual rollback verification | Full end-to-end rollback with checklist |
| 6 | Rotation under load | Event loss across rotation | Force rotation mid-append sequence |
| 7 | Compression integration | Data loss during compression | Compress rotated, verify active untouched |
| 8 | Dashboard accuracy | Stale/misleading operator view | Generate dashboard, compare to ledger |

---

## Fixture 1: Disk-Full Simulation

### Scenario
The traceRoot filesystem has reached capacity. New trace writes cannot be persisted to the primary sink.

### Test Steps
1. Create isolated traceRoot on a small tmpfs mount (e.g., 64KB) or use a mock that injects `ENOSPC` errors on `fs.appendFile`.
2. Fill the traceRoot with trace events until the primary sink fails with `ENOSPC`.
3. Continue issuing packet operations through the traced queue.
4. Verify fallback sink activates and captures events.
5. Verify health reflects degraded state.
6. Free disk space (remove non-trace files or unmount/remount).
7. Verify primary sink resumes writing on next append.
8. Verify no trace events were silently lost (check fallback sink buffer contents).

### Required Evidence
- [ ] Primary sink failure is detected (not silently swallowed)
- [ ] Fallback sink activates within 1 append cycle
- [ ] Packet operations continue succeeding (non-blocking)
- [ ] Health reports `degraded: true` with `fallbackSink` populated
- [ ] State counter `fallbackAppends` increments
- [ ] After disk space freed, primary sink resumes automatically
- [ ] No events lost: fallback buffer contains events written during outage
- [ ] No exceptions escape the queue API

### Pass Criteria
All evidence items verified. Primary → fallback → primary transition is seamless.

### Fail Criteria
- Any packet operation throws
- Events silently lost during disk-full period
- Primary sink never recovers after disk space freed
- Health does not reflect degraded state

### Safety Boundaries
- Uses isolated tmpfs mount or mock, never touches live filesystem
- No disk space manipulation outside the test traceRoot
- Cleanup: unmount tmpfs, remove all temp files

---

## Fixture 2: High-Volume Long-Run

### Scenario
Sustained operation at production-like event volume (1000+ events) to validate memory stability, ordering correctness, ID uniqueness, and search/tail performance.

### Test Steps
1. Create isolated traceRoot with production-like config:
   - `maxLedgerBytes: 50 * 1024 * 1024` (50 MiB)
   - `maxLedgerFiles: 30`
   - `fsyncOnAppend: true`
   - `checksumEnabled: true`
   - `rotationEnabled: true`
2. Emit 1000 trace events across all 7 event types in realistic proportions:
   - 400 `packet_created`
   - 200 `packet_read`
   - 100 `packet_claimed`
   - 100 `result_written`
   - 100 `warden_verdict_recorded`
   - 50 `packet_archived`
   - 50 `packet_rejected`
3. Every 100 events: verify search, tail, and health return within 100ms.
4. After 1000 events: generate handoff bundle.
5. Validate all event IDs are unique.
6. Validate ordering is preserved (timestamps monotonic within tolerance).
7. Validate ledger validation reports 0 malformed lines.
8. Validate checksums for all non-rotated ledgers.

### Required Evidence
- [ ] 1000 events written successfully
- [ ] All 1000 event IDs unique (no collision)
- [ ] Timestamps monotonic (no out-of-order events)
- [ ] Search returns within 100ms for 1000 events
- [ ] Tail returns within 100ms for 1000 events
- [ ] Health reports writable and not degraded
- [ ] Ledger validation: 0 malformed lines
- [ ] Checksums verified for active ledger(s)
- [ ] Handoff bundle generated with accurate counts
- [ ] Memory usage stable (no unbounded growth)

### Pass Criteria
All evidence items verified. Performance within thresholds.

### Fail Criteria
- Event ID collision detected
- Out-of-order timestamps
- Search or tail exceeds 100ms
- Malformed lines in ledger
- Memory usage grows without bound
- Health reports degraded during normal operation

### Safety Boundaries
- Isolated temp traceRoot only
- Events are synthetic (no real packet data)
- Cleanup: remove all temp trace files after test

---

## Fixture 3: Permission Failure Recovery

### Scenario
The traceRoot directory becomes read-only mid-run (e.g., permissions changed, filesystem remounted read-only). The system must activate fallback, continue packet operations, and recover when permissions are restored.

### Test Steps
1. Create isolated traceRoot with full write permissions.
2. Start traced queue, emit 10 events (warm-up).
3. `chmod 555` on traceRoot (remove write permission).
4. Emit 5 more events — verify fallback activates.
5. Verify packet operations still succeed.
6. `chmod 755` on traceRoot (restore write permission).
7. Emit 5 more events — verify primary sink resumes.
8. Read full ledger — verify all 20 events present (10 primary + 5 fallback + 5 primary).

### Required Evidence
- [ ] Pre-permission-change events written to primary sink
- [ ] Post-permission-change events written to fallback sink
- [ ] Packet operations continue during permission failure
- [ ] Health reports degraded during permission failure
- [ ] State counter `fallbackAppends` increments during outage
- [ ] After permissions restored, primary sink resumes automatically
- [ ] All 20 events accounted for (no loss)
- [ ] No exceptions escape queue API

### Pass Criteria
Seamless fallback → recovery transition. All events accounted for.

### Fail Criteria
- Packet operation throws during permission failure
- Events lost during permission failure
- Primary sink does not recover after permissions restored

### Safety Boundaries
- chmod applied only to isolated temp traceRoot
- Never modifies permissions on live directories
- Cleanup: restore permissions, remove temp files

---

## Fixture 4: Restart Recovery

### Scenario
The process restarts. A new TraceWriter/TraceReader must continue using existing ledger files without corruption, duplicate IDs, or checksum invalidation.

### Test Steps
1. Create isolated traceRoot.
2. Create traced queue, emit 10 events.
3. Record the last event ID and total append count.
4. Create a completely new traced queue instance pointing to the same traceRoot (simulating restart).
5. Emit 5 more events with the new instance.
6. Verify all 15 events are readable via TraceReader.
7. Verify no duplicate event IDs between old and new events.
8. Verify checksums for the active ledger are valid.
9. Verify `totalAppends` counter in new writer state is 5 (starts fresh, not accumulated).

### Required Evidence
- [ ] Old events (10) remain readable after restart
- [ ] New events (5) are written correctly
- [ ] No duplicate event IDs across restart boundary
- [ ] Checksums valid for active ledger
- [ ] Ledger contains exactly 15 valid lines, 0 malformed
- [ ] New writer state correctly starts at 0 (does not carry old state)

### Pass Criteria
All events preserved, no duplicates, checksums valid.

### Fail Criteria
- Old events unreadable after restart
- Duplicate event IDs detected
- Checksum invalidation
- Malformed lines in ledger

### Safety Boundaries
- Same isolated traceRoot, new JavaScript instances
- No actual process restart required (simulated via new constructors)
- Cleanup: remove temp files

---

## Fixture 5: Operator Rollback Drill

### Scenario
Full end-to-end manual rollback from traced to untraced mode, including evidence preservation verification.

### Test Steps
1. Create isolated traceRoot and traced queue.
2. Emit 20 events across all event types.
3. Record pre-rollback state: event count, ledger file paths, last event ID.
4. Call `rollbackToUntracedQueue(queue, "production_readiness_drill")`.
5. Verify returned queue mode is `"untraced"`.
6. Verify `getState()` returns `null`.
7. Emit 3 more events via the rolled-back untraced queue.
8. Verify no new trace events were written (trace count unchanged).
9. Verify pre-rollback ledger files are still readable.
10. Verify pre-rollback events are unchanged.
11. Generate queue handoff bundle from pre-rollback state (simulated archive).
12. Verify rollbackInfo contains: reason, timestamp, preRollbackAppends count.

### Required Evidence
- [ ] Rollback returns mode `"untraced"`
- [ ] `getState()` returns `null` after rollback
- [ ] Pre-rollback trace files preserved and readable
- [ ] Pre-rollback events unchanged
- [ ] Post-rollback operations emit 0 new trace events
- [ ] `rollbackInfo` present with all fields
- [ ] Handoff bundle can be generated from pre-rollback state
- [ ] No packet files mutated during rollback

### Pass Criteria
Clean rollback with full evidence preservation.

### Fail Criteria
- Post-rollback events appear in trace ledger
- Pre-rollback trace files deleted or corrupted
- Packet files mutated
- RollbackInfo missing or incomplete

### Safety Boundaries
- Isolated temp directories only
- Rollback is manual operator action (not automatic)
- Cleanup: remove temp files after evidence verified

---

## Fixture 6: Rotation Under Load

### Scenario
Ledger rotation occurs while events are being appended. No events are lost across the rotation boundary.

### Test Steps
1. Create isolated traceRoot with small `maxLedgerBytes: 2048` (2 KiB) to force rapid rotation.
2. Create traced queue with rotation enabled.
3. Emit 50 events (each ~150-200 bytes) to force at least 2-3 rotations.
4. During emission, check that rotation triggers when `currentLedgerBytes > maxLedgerBytes`.
5. After all events: list all ledger files in traceRoot.
6. Verify active ledger is not rotated (no date suffix on current file).
7. Verify rotated ledgers have date suffixes and checksum files.
8. Read all events across all ledgers — verify all 50 events present.
9. Verify no duplicate events across rotation boundaries.

### Required Evidence
- [ ] Multiple rotated ledger files exist (≥2)
- [ ] Active ledger is the most recent, not rotated
- [ ] All 50 events readable across all ledgers
- [ ] No duplicate events at rotation boundaries
- [ ] Checksum files exist for rotated ledgers
- [ ] Event ordering preserved across rotation

### Pass Criteria
All events preserved, no duplicates, rotation boundaries clean.

### Fail Criteria
- Events lost during rotation
- Duplicate events at rotation boundary
- Active ledger incorrectly rotated
- Checksums missing for rotated ledgers

### Safety Boundaries
- Isolated temp traceRoot only
- Small maxLedgerBytes forces rotation quickly
- Cleanup: remove all temp trace files

---

## Fixture 7: Compression Integration

### Scenario
Rotated ledgers are compressed after rotation. The active ledger is never compressed. Decompression works correctly.

### Test Steps
1. Create isolated traceRoot with `maxLedgerBytes: 2048` to force rotation.
2. Create traced queue, emit 50 events to produce rotated ledgers.
3. Identify rotated ledgers (not the active one).
4. Call `compressRotatedLedgers(traceRoot, currentLedgerFileName)`.
5. Verify rotated ledgers are now `.jsonl.gz` files.
6. Verify active ledger is still `.jsonl` (not compressed).
7. Read all events using `readLedgerContent()` — transparently handles `.gz`.
8. Verify all 50 events still readable.
9. Decompress one rotated ledger and verify content matches pre-compression.

### Required Evidence
- [ ] Rotated ledgers compressed to `.jsonl.gz`
- [ ] Active ledger remains uncompressed `.jsonl`
- [ ] All events readable via `readLedgerContent()` (transparent decompression)
- [ ] Decompressed content matches original
- [ ] No files deleted except original after successful compression
- [ ] Compression achieved size reduction (compressed < original)

### Pass Criteria
All events accessible, active ledger untouched, compression works.

### Fail Criteria
- Active ledger compressed
- Events unreadable after compression
- Decompressed content differs from original
- Files deleted incorrectly

### Safety Boundaries
- Isolated temp traceRoot only
- Only rotated (non-active) ledgers are compressed
- Cleanup: remove all temp files

---

## Fixture 8: Dashboard Accuracy

### Scenario
The generated HTML dashboard accurately reflects the trace ledger contents. Static-vs-live warnings are present.

### Test Steps
1. Create isolated traceRoot, emit 20 events.
2. Generate base handoff bundle via `generateTraceHandoff()`.
3. Generate dashboard via `generateDashboard(bundleDir)`.
4. Read dashboard HTML content.
5. Verify dashboard contains correct event count (20).
6. Verify dashboard contains correct contract classification.
7. Verify dashboard contains static-vs-live warning language.
8. Verify dashboard contains "not a live monitoring system" or equivalent.
9. Verify dashboard does not claim real-time updates.
10. Verify dashboard does not contain network requests or external scripts.

### Required Evidence
- [ ] Dashboard HTML file generated successfully
- [ ] Event count in dashboard matches actual (20)
- [ ] Contract classification displayed correctly
- [ ] Static-vs-live warning present in HTML
- [ ] No "live monitoring" or "real-time" claims
- [ ] No `<script src=` external references
- [ ] No `fetch()`, `WebSocket`, or `EventSource` usage
- [ ] Self-contained (no external dependencies)

### Pass Criteria
Dashboard accurate, warnings present, no live monitoring claims.

### Fail Criteria
- Event count mismatch between dashboard and ledger
- Missing static-vs-live warning
- Claims of real-time or live monitoring
- External dependencies or network requests

### Safety Boundaries
- Reads from handoff bundle only (already validated)
- No network or filesystem writes beyond output HTML
- Cleanup: remove generated HTML

---

## Safety Boundaries (Global)

| # | Boundary | Status |
|---|---|---|
| 1 | No default tracing (untraced is default) | HELD |
| 2 | No env var activation (explicit config only) | HELD |
| 3 | No live agents spawned | HELD |
| 4 | No remote/server/API behavior | HELD |
| 5 | No Tripp.Control writes | HELD |
| 6 | No Tripp.Reason writes | HELD |
| 7 | No shared-agent-bus mutation outside queue ops | HELD |
| 8 | No command execution | HELD |
| 9 | No watchers/polling/timers | HELD |
| 10 | Internal Tripp.OS contract only | HELD |

---

## Rollback Requirements (Global)

For every production fixture:
1. Rollback must be tested at least once (covered in Fixture 5)
2. All other fixtures must verify rollback does not interfere with their scenario
3. Pre-fixture trace files must be preserved post-fixture
4. No fixture may delete or modify trace files from other fixtures
5. Each fixture uses its own isolated traceRoot

---

## Operator Approval Packet

```json
{
  "$schema": "internal/tripp-os-trace-queue-production-readiness-v1",
  "gate_version": "1.0.0",
  "generated_at": "<timestamp>",
  "fixtures_required": 8,
  "fixtures_designed": 8,
  "staging_status": "APPROVED",
  "production_status": "NOT_APPROVED",
  "required_evidence_summary": [
    "Disk-full: fallback activates, ops continue, no silent loss, primary recovers",
    "High-volume: 1000 events, unique IDs, monotonic timestamps, <100ms search",
    "Permission failure: fallback activates, ops continue, primary recovers on restore",
    "Restart: all events readable, no duplicates, checksums valid, fresh state",
    "Rollback drill: mode→untraced, state→null, 0 new events, evidence preserved",
    "Rotation: all events across ledgers, no duplicates, active ledger untouched",
    "Compression: rotated compressed, active untouched, transparent read, size reduced",
    "Dashboard: accurate counts, static warnings, no live claims, no external deps"
  ],
  "safety_boundaries": "10/10 HELD",
  "rollback_verified": true
}
```

---

## Production Decision Options

### Option 1: APPROVE_LIMITED_PRODUCTION_TRACED_QUEUE
**Required evidence:** All 8 fixtures pass. Safety boundaries 10/10 HELD. Operator has executed rollback drill (Fixture 5) manually and verified evidence preservation.

**Scope:** Traced queue mode approved for limited production environments with:
- Explicit operator opt-in per instance
- Mandatory rollback drill before first enablement
- Monitoring for disk usage and fallback frequency
- Quarterly re-validation of this gate

**Forbidden assumptions:**
- Does NOT approve traced mode as default
- Does NOT approve automatic traced mode activation
- Does NOT remove the explicit opt-in requirement
- Does NOT bypass operator approval

**Next marker:** `READY_FOR_TRIPP_OS_TRACE_BUS_ADAPTER_LIMITED_PRODUCTION_DEPLOYMENT`

---

### Option 2: KEEP_STAGING_ONLY
**Required evidence:** Staging gate passed (already confirmed). No additional evidence required.

**Scope:** Traced queue mode remains staging-only. Production readiness fixtures are deferred.

**Forbidden assumptions:**
- Does NOT mean traced mode is unsafe for production
- Does NOT prevent future production readiness work
- Does NOT require code changes to enable later

**Next marker:** `TRIPP_OS_TRACE_BUS_ADAPTER_STAGING_ONLY_MAINTAINED`

---

### Option 3: REQUEST_MORE_PRODUCTION_FIXTURES
**Required evidence:** Specific gaps identified by operator. Current design preserved as baseline.

**Suggested additional fixtures:**
- Multi-day durability test (fsync under sustained load)
- Ledger corruption detection and recovery
- Concurrent writer safety (multiple processes)
- Backup and restore integration
- Performance under 10,000+ events

**Forbidden assumptions:**
- Does NOT mean current fixtures are insufficient by default
- Does NOT block staging deployment
- Does NOT require redesign of existing fixtures

**Next marker:** `READY_FOR_TRIPP_OS_TRACE_BUS_ADAPTER_ADDITIONAL_PRODUCTION_FIXTURES`

---

### Option 4: BLOCK_PRODUCTION_TRACED_QUEUE
**Required evidence:** Specific blocking concerns documented. Current design preserved for future re-evaluation.

**When to use:** Concrete safety or operational concern that makes production deployment unacceptable.

**Forbidden assumptions:**
- Does NOT mean traced mode is permanently unsafe
- Does NOT prevent staging use
- Does NOT affect untraced mode operation

**Next marker:** `TRIPP_OS_TRACE_BUS_ADAPTER_PRODUCTION_TRACED_QUEUE_BLOCKED`

---

## Implementation Order

Recommended implementation sequence:

| Order | Fixture | Complexity | Dependencies |
|---|---|---|---|
| 1 | Fixture 4: Restart recovery | Low | None |
| 2 | Fixture 6: Rotation under load | Low | None |
| 3 | Fixture 7: Compression integration | Low | Fixture 6 |
| 4 | Fixture 3: Permission failure | Medium | None |
| 5 | Fixture 1: Disk-full simulation | Medium | None |
| 6 | Fixture 5: Operator rollback drill | Medium | None |
| 7 | Fixture 8: Dashboard accuracy | Low | Handoff bundle |
| 8 | Fixture 2: High-volume long-run | High | All above |

---

## Decision

**TRIPP_OS_TRACE_BUS_ADAPTER_PRODUCTION_READINESS_GATE_DESIGN_PASS_READY_FOR_IMPLEMENTATION**

All 8 production readiness fixtures designed with:
- Required evidence (8-10 items per fixture)
- Pass/fail criteria
- Safety boundaries
- Isolation strategies

Operator approval packet designed. 4 production decision options defined.

**Next Marker:** `READY_FOR_TRIPP_OS_TRACE_BUS_ADAPTER_PRODUCTION_READINESS_GATE_IMPLEMENTATION`
