# Rollback Plan

## Triggers
| Severity | Condition |
|---|---|
| Critical | Disk usage >= 95% |
| Critical | Checksum validation failure |
| Critical | Degraded health >= 5 minutes |
| Warning | Disk usage 80-94% |
| Warning | Degraded health < 5 minutes |

## Steps
1. Stop accepting new traced operations
2. Flush pending queue operations
3. Call rollbackToUntracedQueue(queue, reason)
4. Verify mode === "untraced"
5. Verify getState() === null
6. Verify 0 new trace events after rollback
7. Log rollbackInfo with timestamp
8. Archive traceRoot and handoff bundle

## Post-Rollback State
| Property | Value |
|---|---|
| Queue mode | "untraced" |
| getState() | null |
| New trace events | 0 |
| Pre-rollback trace files | Preserved |
| Pre-rollback trace events | Readable |
| Packet files | Unchanged |

## Must NOT Happen
- Do NOT delete trace files during rollback
- Do NOT delete or modify packet files during rollback
- Do NOT call createTracedQueue again without new approval

## Evidence to Preserve
| Evidence | Location |
|---|---|
| Pre-rollback trace ledgers | traceConfig.traceRoot |
| Pre-rollback handoff bundle | Operator archive directory |
| Rollback metadata | rollbackInfo object |
| Rollback timestamp | rollbackInfo.rolledBackAt |
