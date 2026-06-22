# Tripp.OS Trace Bus Adapter — Limited Production Rollout Plan Summary

**Date:** 2026-06-07
**Package:** @tripp-os/runtime-trace v0.1.0
**Classification:** internal-tripp-os-runtime-trace
**Operator Decision:** APPROVE_LIMITED_PRODUCTION_TRACED_QUEUE

---

## Constraint Statement

**Production rollout remains limited and opt-in only.** Traced queue mode:
- Requires explicit operator approval per instance
- Requires explicit adapter construction per instance
- Defaults to untraced globally
- Has no env-var activation
- Has automatic activation disabled
- Requires rollback availability
- Requires health review after initial run
- Requires separate post-rollout audit

## 8 Plan Sections

### 1. Production Eligibility
- Dedicated isolated traceRoot (no shared-agent-bus/Control/Reason paths)
- Minimum 500 MB free disk, alert at 80%, stop at 95%
- actorType, actorId, runId all required and unique
- checksumEnabled=true, rotationEnabled=true, fsyncOnAppend=true
- fallbackSinks with stderr + memory required
- Operator approval record documented before enablement

### 2. Enablement Procedure
- Validate config via `validateTraceConfig()`
- Construct `TraceBusAdapter` explicitly with identity
- Construct traced queue via `createTracedQueue({ adapter, workdir })`
- Confirm `queue.mode === "traced"`
- Confirm default untraced mode on other instances
- Confirm rollback available

### 3. Initial Run Protocol
- Max 1,000 events or 24 hours
- Observe all 7 lifecycle event types
- Health checks every 4 hours
- End validation: 0 malformed, checksums valid, IDs unique, handoff generated

### 4. Monitoring and Health Review
- Degraded ≥ 5 minutes → Critical → initiate rollback review
- Fallback ≥ 10/hour → Critical → primary sink failure
- Disk ≥ 95% → Critical → stop traced mode
- Disk 80-94% → Warning → plan cleanup

### 5. Rollback Protocol
- 6-step manual procedure with evidence preservation
- Operator notification template provided
- Must NOT delete trace files or modify packet files
- Post-rollback verification checklist (6 items)

### 6. Stop Conditions
- 6 automatic stops (disk, degraded, fallback, checksum, events, boundaries)
- 4 warnings, 2 info conditions
- All with defined thresholds

### 7. Post-Rollout Audit
- 10 checks within 48 hours
- Weekly for first month, then monthly
- JSON audit schema defined

### 8. Decision Options After Rollout

| Option | When | Next Marker |
|---|---|---|
| **KEEP_LIMITED** | All checks pass, stable ≥ 1 week | `LIMITED_PRODUCTION_MAINTAINED` |
| **EXPAND** | ≥ 2 instances with KEEP status | `EXPANDED_PRODUCTION_APPROVAL` |
| **ROLLBACK** | Stop condition triggered | `PRODUCTION_TRACED_QUEUE_ROLLED_BACK` |
| **REQUEST_FIXES** | Issues requiring code changes | `PRODUCTION_FIXES` |

## Decision

```
TRIPP_OS_TRACE_BUS_ADAPTER_LIMITED_PRODUCTION_ROLLOUT_PLAN_PASS_READY_FOR_INITIAL_ROLLOUT
```
