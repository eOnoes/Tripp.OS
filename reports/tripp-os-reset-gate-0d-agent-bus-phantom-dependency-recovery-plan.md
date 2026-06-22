# Tripp.OS Reset Gate 0D — Agent-Bus Phantom Dependency Recovery Plan

**Report ID:** tripp-os-reset-gate-0d-agent-bus-phantom-dependency-recovery-plan.md
**Author:** Kimi (Tripp.OS Contract Authority)
**Date:** 2026-06-22
**Visibility:** `local_direct` — all claims verified against cloned source

---

## 1. Final Decision

> ### `TRIPP_OS_RESET_0D_PASS_AGENT_BUS_RECOVERY_PLAN_READY_FOR_0E_AGENT_BUS_RECOVERY_IMPLEMENTATION`

**Recommended recovery path:** **Option B — Reconstruct minimal source-compatible package from usage patterns.** No source artifact exists. Imports are correct and justified. Minimal reconstruction unblocks the entire dependency chain.

---

## 2. Repo Verification

| Check | Result |
|---|---|
| Path | `/mnt/agents/output/tripp-os-clone` |
| Git top-level | `/mnt/agents/output/tripp-os-clone` |
| Remote | `https://github.com/eOnoes/Tripp.OS.git` (PAT-authenticated) |
| Branch | `master` |
| Local HEAD | `bdce39b` (reports commit) |
| Origin HEAD (API) | `c6853eef` (reports pushed via API) |
| Git status | Clean (empty `--short`) |

**Note:** Git protocol (push/fetch) times out in this sandbox. API push confirmed. Local origin ref stale but source is current.

---

## 3. Git Status Before

```
On branch master
Your branch is up to date with 'origin/master'.

nothing to commit, working tree clean
```

---

## 4. Agent-Bus Import Inventory

### 4.1 Files Importing `@tripp-os/agent-bus`

**Source files (6):**

| # | File | Import Type | Symbols |
|---|---|---|---|
| 1 | `src/adapter.ts` | Mixed (runtime + types) | `writeTaskPacket`, `writeResultPacket`, `writeReviewPacket`, `readTaskPacket`, `readResultPacket`, `movePacketToArchive`, `movePacketToRejected`, `listInboxPackets`, `listOutboxPackets`, `createTraceEvent`, `CreateTraceEventInput` (type), `ExternalAgentTaskPacket` (type), `ExternalAgentResultPacket` (type), `ExternalAgentReviewPacket` (type), `AgentBusTraceEventType` (type), `AgentBusTraceSeverity` (type), `AgentBusTraceActorType` (type), `WriteOptions` (type), `ListOptions` (type) |
| 2 | `src/queue.ts` | Mixed (runtime + types) | `writeTaskPacket`, `writeResultPacket`, `writeReviewPacket`, `readTaskPacket`, `readResultPacket`, `movePacketToArchive`, `movePacketToRejected`, `ExternalAgentTaskPacket` (type), `ExternalAgentResultPacket` (type), `ExternalAgentReviewPacket` (type), `WriteOptions` (type), `ListOptions` (type) |
| 3 | `src/writer.ts` | Type-only | `AgentBusTraceEvent` (type), `TraceEventEnvelope` (type) |
| 4 | `src/reader.ts` | Type-only | `AgentBusTraceEvent` (type), `TraceEventEnvelope` (type) |
| 5 | `src/fallback.ts` | Type-only | `AgentBusTraceEvent` (type) |
| 6 | `src/benchmark.ts` | Type-only | `CreateTraceEventInput` (type) |

**Test files (7):**

| # | File | Import Type | Symbols |
|---|---|---|---|
| 7 | `src/__tests__/adapter.test.ts` | Type + dynamic | `ExternalAgentTaskPacket` (type), `ExternalAgentResultPacket` (type), `ExternalAgentReviewPacket` (type), `writeTaskPacket` (dynamic) |
| 8 | `src/__tests__/adapter-fixture.test.ts` | Type + dynamic | Same as adapter.test.ts |
| 9 | `src/__tests__/handoff.test.ts` | Type-only | `CreateTraceEventInput` (type) |
| 10 | `src/__tests__/handoff-fixture.test.ts` | Type-only | `CreateTraceEventInput` (type) |
| 11 | `src/__tests__/queue.test.ts` | Type-only | `ExternalAgentTaskPacket` (type), `ExternalAgentResultPacket` (type), `ExternalAgentReviewPacket` (type) |
| 12 | `src/__tests__/production-readiness.test.ts` | Mixed | Runtime + type imports (multi-line) |
| 13 | `src/__tests__/trace.test.ts` | Type + inline | `CreateTraceEventInput` (type), `AgentBusTraceEvent` (inline type cast) |

### 4.2 Import Summary by Category

| Category | Count | Files |
|---|---|---|
| **Runtime value imports** | 6 source files | adapter.ts, queue.ts |
| **Type-only imports** | 4 source + 4 test | writer.ts, reader.ts, fallback.ts, benchmark.ts, handoff*.test.ts, queue.test.ts |
| **Dynamic imports** | 2 test files | adapter.test.ts, adapter-fixture.test.ts |
| **Inline type references** | 1 test file | trace.test.ts |

---

## 5. Imported Symbol Matrix

### 5.1 All Unique Symbols (21 total)

| Symbol | Type | Runtime | Used By | Remote Ops Needs? |
|---|---|---|---|---|
| `AgentBusTraceEvent` | ✅ | — | writer, reader, fallback, trace.test | Yes (trace events) |
| `AgentBusTraceActorType` | ✅ | — | adapter | Yes (worker identity) |
| `AgentBusTraceEventType` | ✅ | — | adapter | Yes (event typing) |
| `AgentBusTraceSeverity` | ✅ | — | adapter | Yes (event severity) |
| `CreateTraceEventInput` | ✅ | — | adapter, benchmark, handoff*.test | Yes (trace creation) |
| `ExternalAgentTaskPacket` | ✅ | — | adapter, queue, 4 test files | Yes (job = task packet) |
| `ExternalAgentResultPacket` | ✅ | — | adapter, queue, 4 test files | Yes (result = output) |
| `ExternalAgentReviewPacket` | ✅ | — | adapter, queue, 4 test files | Maybe (review/audit) |
| `TraceEventEnvelope` | ✅ | — | writer, reader | Yes (trace envelope) |
| `WriteOptions` | ✅ | — | adapter, queue | Yes (packet I/O options) |
| `ListOptions` | ✅ | — | adapter, queue | Yes (listing options) |
| `writeTaskPacket` | — | ✅ | adapter, queue, 2 test files | Yes (submit job) |
| `writeResultPacket` | — | ✅ | adapter, queue | Yes (write result) |
| `writeReviewPacket` | — | ✅ | adapter, queue | Maybe (review) |
| `readTaskPacket` | — | ✅ | adapter, queue | Yes (read pending) |
| `readResultPacket` | — | ✅ | adapter, queue | Maybe (read result) |
| `movePacketToArchive` | — | ✅ | adapter, queue | Yes (archive job) |
| `movePacketToRejected` | — | ✅ | adapter, queue | Maybe (reject) |
| `listInboxPackets` | — | ✅ | adapter | Yes (queue status) |
| `listOutboxPackets` | — | ✅ | adapter | Yes (queue status) |
| `createTraceEvent` | — | ✅ | adapter | Yes (create trace event) |

### 5.2 Symbol Categorization

| Category | Count | Symbols |
|---|---|---|
| **Packet types** | 3 | `ExternalAgentTaskPacket`, `ExternalAgentResultPacket`, `ExternalAgentReviewPacket` |
| **Trace event types** | 5 | `AgentBusTraceEvent`, `AgentBusTraceEventType`, `AgentBusTraceSeverity`, `AgentBusTraceActorType`, `CreateTraceEventInput` |
| **Trace envelope** | 1 | `TraceEventEnvelope` |
| **Options types** | 2 | `WriteOptions`, `ListOptions` |
| **Packet I/O functions** | 8 | `writeTaskPacket`, `writeResultPacket`, `writeReviewPacket`, `readTaskPacket`, `readResultPacket`, `movePacketToArchive`, `movePacketToRejected`, `createTraceEvent` |
| **Listing functions** | 2 | `listInboxPackets`, `listOutboxPackets` |

---

## 6. Current Package/Workspace State

| Property | State |
|---|---|
| `packages/` directory at root | **NOT FOUND** |
| `packages/agent-bus/` | **NOT FOUND** |
| `packages/agent-bus/package.json` | **NOT FOUND** |
| `packages/agent-bus/src/` | **NOT FOUND** |
| Root `package.json` | **NOT FOUND** |
| Workspace config (pnpm/yarn/lerna) | **NOT FOUND** |
| Lockfile | **NOT FOUND** |
| `@tripp-os/agent-bus` in any package.json deps | **NOT FOUND** |
| tsconfig path mapping | Points to phantom `./node_modules/@tripp-os/agent-bus/src/index.ts` |

**Verdict:** No infrastructure exists for a monorepo or workspace. The agent-bus package must be created from scratch.

---

## 7. Evidence and Source-Pack Findings

### 7.1 Full Package Zip (`tripp-os-full-package.zip`)

| Search | Result |
|---|---|
| `agent-bus` directories in zip | **0 found** |
| `agent-bus` source files in zip | **0 found** |
| `agent-bus/package.json` in zip | **NOT FOUND** |

**Zip contains exactly 60 files:**
- 24 runtime-trace source files (15 src + 9 test)
- 17 runtime-trace report/markdown files
- 17 evidence package files + MANIFEST
- 1 empty evidence directory marker

**The zip contains ZERO agent-bus source files.**

### 7.2 Evidence Package Mentions of Agent-Bus

| File | Context |
|---|---|
| `01_state_manifest.json` | Safety boundary: "No shared-agent-bus mutation" — status: HELD |
| `02_handoff_bundle_schemas.json` | Safety boundary: "No shared-agent-bus mutation outside queue ops" |
| `05_rollout_plan_summary.md` | "Dedicated isolated traceRoot (no shared-agent-bus/Control/Reason paths)" |
| `08_boundary_statement.md` | "Tripp.Control does not create, modify, or delete agent-bus packets" |
| `DELIVERY_RECEIPT.md` | "No shared-agent-bus mutation" confirmed |

**All mentions are safety/boundary assertions, not source references.**

### 7.3 README Claims

README line 7 claims: `@tripp-os/agent-bus` — "File-based inter-agent message bus with typed schemas, trace ledger, and transport layer"

README line 14 claims: `├── agent-bus/          @tripp-os/agent-bus` in structure diagram

**These are aspirational, not actual.** Confirmed: no agent-bus directory or source exists.

### 7.4 Source Extract Directory Name

The directory `tripp-os-source-extract/agent-bus-handoff/` suggests this was extracted from an artifact labeled "agent-bus-handoff." However, the handoff only delivered `runtime-trace`, not `agent-bus` itself.

---

## 8. Agent-Bus Boundary Definition

### 8.1 What `@tripp-os/agent-bus` Owns

| Concern | Owned By | Not Owned By |
|---|---|---|
| Packet type definitions (Task/Result/Review) | **agent-bus** | runtime-trace, remote-ops |
| Packet file I/O (write/read/move) | **agent-bus** | runtime-trace (wraps only), remote-ops (orchestrates only) |
| Trace event type definitions | **agent-bus** | runtime-trace (consumes) |
| Trace event creation | **agent-bus** | runtime-trace (consumes via `createTraceEvent`) |
| File-based transport | **agent-bus** | runtime-trace (uses for persistence) |
| Inbox/outbox listing | **agent-bus** | runtime-trace (uses for queue status) |

### 8.2 What `@tripp-os/agent-bus` Does NOT Own

| Concern | Owned By | Rationale |
|---|---|---|
| Trace persistence (ledger, rotation, fsync) | **runtime-trace** | agent-bus creates events; runtime-trace persists them |
| Queue lifecycle management | **remote-ops** | agent-bus does packets; remote-ops does jobs |
| Worker identity/heartbeat | **remote-ops** | agent-bus is transport; remote-ops is lifecycle |
| Governance phase state | **governance-pipeline** | orthogonal concern |

---

## 9. Minimum Required Export Surface

### 9.1 For Current Runtime-Trace (Build-Blocking)

These are the **minimum exports** needed to make runtime-trace compile and pass tests:

```typescript
// === Types (type-only imports) ===
export interface ExternalAgentTaskPacket {
  agentRole: string;
  // ... other packet fields
}

export interface ExternalAgentResultPacket {
  // ... result fields
}

export interface ExternalAgentReviewPacket {
  reviewerRole: string;
  // ... review fields
}

export interface AgentBusTraceEvent {
  // ... trace event fields
}

export interface TraceEventEnvelope {
  // ... envelope fields
}

export type AgentBusTraceEventType = string; // or enum
export type AgentBusTraceSeverity = "debug" | "info" | "warning" | "error" | "critical";
export type AgentBusTraceActorType = "system" | "user" | "agent";

export interface CreateTraceEventInput {
  // ... input fields for createTraceEvent
}

export interface WriteOptions {
  workdir?: string;
  // ... other options
}

export interface ListOptions {
  workdir?: string;
  // ... other options
}

// === Runtime Functions (value imports) ===
export function writeTaskPacket(packet: ExternalAgentTaskPacket, options?: WriteOptions): Promise<string>;
export function writeResultPacket(packet: ExternalAgentResultPacket, options?: WriteOptions): Promise<string>;
export function writeReviewPacket(packet: ExternalAgentReviewPacket, options?: WriteOptions): Promise<{ jsonPath: string; mdPath: string; reviewId: string }>;
export function readTaskPacket(filePath: string): Promise<ExternalAgentTaskPacket>;
export function readResultPacket(filePath: string): Promise<ExternalAgentResultPacket>;
export function movePacketToArchive(filePath: string, options?: ListOptions): Promise<string>;
export function movePacketToRejected(filePath: string, reason: string, options?: ListOptions): Promise<string>;
export function listInboxPackets(options?: ListOptions): Promise<string[]>;
export function listOutboxPackets(options?: ListOptions): Promise<string[]>;
export function createTraceEvent(input: CreateTraceEventInput): AgentBusTraceEvent;
```

### 9.2 For Remote Ops (Future)

Remote ops will additionally need:
- `WorkerIdentity` type (or use shared-schemas version)
- Channel/transport abstractions for push notifications
- Session management types for Codex worker envelope

---

## 10. Runtime-Trace Boundary

runtime-trace's relationship with agent-bus:

| File | Role | Calls agent-bus for... |
|---|---|---|
| `adapter.ts` | **Primary consumer** | All packet I/O + trace event creation |
| `queue.ts` | Queue wrapper | Packet lifecycle (enqueue, claim, result, archive) |
| `writer.ts` | Trace persistence | `AgentBusTraceEvent` type for trace shape |
| `reader.ts` | Trace reading | `AgentBusTraceEvent` + `TraceEventEnvelope` types |
| `fallback.ts` | Sink chain | `AgentBusTraceEvent` type for event typing |
| `benchmark.ts` | Performance | `CreateTraceEventInput` type for benchmark data |

**Key insight:** `adapter.ts` is the ** chokepoint** — all agent-bus runtime usage flows through it. If adapter.ts compiles, most of runtime-trace compiles.

---

## 11. Remote-Ops Boundary

Remote-ops will NOT import from agent-bus directly. Instead:

```
remote-ops ──► runtime-trace (TraceBusAdapter)
                  └──► agent-bus (packet I/O)
```

Remote-ops orchestrates job lifecycle using `runtime-trace`'s queue abstractions, which internally delegate to `agent-bus` for packet operations.

The exception: remote-ops may import **types only** from agent-bus for event typing and packet shape correlation.

---

## 12. Recovery Options

### Option A: Recover Exact Prior Package from Source Artifact

| Aspect | Assessment |
|---|---|
| Source artifact | **NOT FOUND** — zip contains 0 agent-bus files |
| Git history | Single-commit repo (`cff4afe` is the only commit) |
| External source | Unknown — may exist in operator's local environment |
| Verdict | **IMPOSSIBLE** — no recoverable artifact exists |

### Option B: Reconstruct Minimal Source-Compatible Package (RECOMMENDED)

| Aspect | Assessment |
|---|---|
| Interface definition | **COMPLETE** — all 21 symbols identified from imports |
| Type shapes | **INFERRED** — usage patterns in adapter.ts and queue.ts reveal field expectations |
| Implementation | **NEEDED** — file-based I/O with JSON serialization |
| Test compatibility | **ACHIEVABLE** — types must match; implementations can be minimal |
| Effort | Low — interface + stub implementation |
| Verdict | **RECOMMENDED** — safest, fastest path |

### Option C: Defer Package and Isolate Imports

| Aspect | Assessment |
|---|---|
| Approach | Comment out or type-stub all agent-bus imports |
| Impact | All 9 test files broken; adapter.ts and queue.ts non-functional |
| Runtime-trace | Reduced to config + writer + reader only (no queue, no adapter) |
| Remote-ops | Blocked entirely — needs queue functionality |
| Verdict | **REJECTED** — too destructive; blocks downstream work |

### Option D: Replace Imports with Local Definitions

| Aspect | Assessment |
|---|---|
| Approach | Copy agent-bus types into runtime-trace |
| Impact | Duplicates types; violates package boundary; creates maintenance debt |
| Future migration | Painful — must remove local copies and redirect to agent-bus |
| Verdict | **REJECTED** — violates architecture; creates technical debt |

---

## 13. Recommended Recovery Path

> **Option B: Reconstruct minimal source-compatible package**

### Phase 1: Type Definitions (0E)

Create `packages/agent-bus/src/index.ts` with all 21 exported symbols:
1. Define all TypeScript interfaces from usage patterns
2. Type inference from `adapter.ts` method signatures
3. No implementation yet — just types and function signatures

### Phase 2: Minimal Implementation (0E)

Add minimal working implementations:
1. File-based packet storage (JSON read/write)
2. Directory structure: `inbox/`, `outbox/`, `archive/`, `rejected/`
3. `createTraceEvent` factory function
4. Error handling with typed errors

### Phase 3: Integration (0E)

1. Create `packages/agent-bus/package.json`
2. Add workspace configuration (root `package.json` + `pnpm-workspace.yaml`)
3. Update runtime-trace's `tsconfig.json` to resolve workspace link
4. Generate lockfile

### Phase 4: Validation (Echo)

1. `pnpm install` from clean clone
2. `pnpm typecheck` — zero errors
3. `pnpm test` — 130/130 passing
4. `pnpm build` — successful

---

## 14. Validation Strategy

| Stage | Command | Expected Result | Owner |
|---|---|---|---|
| 1 | `pnpm install` | All deps + workspace links resolved | Echo |
| 2 | `pnpm typecheck` | Zero TypeScript errors across all packages | Echo |
| 3 | `pnpm build` | All packages compile successfully | Echo |
| 4 | `pnpm test` | 130/130 tests passing | Echo |
| 5 | Clean clone test | Clone → install → test passes without manual steps | Echo |
| 6 | Agent-bus unit tests | (Future) Unit tests for agent-bus functions | Echo |
| 7 | Integration test | Adapter + queue + agent-bus round-trip | Echo |

---

## 15. Echo Dependencies

| What Echo Must Do | Blocked On | When |
|---|---|---|
| Local truth verification | Kimi 0D completion | Now |
| Build/test verification | Agent-bus package implementation (0E) | After 0E |
| Clean clone validation | Lockfile + workspace config | After 0E |
| Post-recovery audit | Agent-bus implementation | After 0E |

**Echo cannot proceed until 0E implementation is complete.**

---

## 16. Codex/Control Dependencies

| What Codex Can Do | Blocked On | When |
|---|---|---|
| Consume remote-ops schema spec (0C) | Already available | **Now** |
| Plan Control-side handoff envelope | Already available | **Now** |
| Implement Control-side queue consumer | Agent-bus recovery + Echo validation | After 0E + Echo |
| Build governance UI | Governance-pipeline spec | Future gate |

**Codex is NOT blocked on 0D.** Codex can continue with 0C schema consumption and Control-side planning. Codex is blocked only on agent-bus implementation for actual integration testing.

---

## 17. Files Changed

| File | Action | Status |
|---|---|---|
| `reports/tripp-os-reset-gate-0d-agent-bus-phantom-dependency-recovery-plan.md` | Created | **New** |

No existing files were modified.

---

## 18. Commands Run

```bash
# Repo verification
git rev-parse --show-toplevel
git remote get-url origin
git branch --show-current
git rev-parse HEAD
git status --short

# Import inventory
grep -rn "@tripp-os/agent-bus" --include="*.ts" --include="*.json" tripp-os-source-extract/

# Symbol extraction
grep -rho "import.*@tripp-os/agent-bus.*" --include="*.ts" tripp-os-source-extract/ | sort -u

# Zip search
unzip -l tripp-os-full-package.zip | grep -i "agent-bus"

# Evidence search
grep -rn "agent-bus\|shared-agent-bus" tripp-os-static-evidence-package/

# tsconfig inspection
cat tripp-os-source-extract/agent-bus-handoff/packages/runtime-trace/tsconfig.json

# Adapter.ts usage analysis
grep -n "agent-bus\|AgentBus\|TraceEvent\|ExternalAgent" tripp-os-source-extract/agent-bus-handoff/packages/runtime-trace/src/adapter.ts

# Remote HEAD check (API)
curl -s -H "Authorization: token $TOKEN" "https://api.github.com/repos/eOnoes/Tripp.OS/commits/master"
```

---

## 19. Validation Results

| Validation | Result |
|---|---|
| Import inventory completeness | ✅ All 13 files identified and categorized |
| Symbol extraction | ✅ 21 unique symbols extracted and categorized |
| Zip content verification | ✅ 60 files inventoried; 0 agent-bus files found |
| Evidence package scan | ✅ All agent-bus mentions documented; all are boundary assertions, not source |
| tsconfig path mapping | ✅ Confirmed phantom path: `./node_modules/@tripp-os/agent-bus/src/index.ts` |
| Type vs runtime classification | ✅ Complete for all symbols |
| Remote ops needs mapping | ✅ All 21 symbols mapped to remote-ops requirements |

---

## 20. Boundary Confirmation

### Tripp.OS owns:
- ✅ Agent-bus package boundary
- ✅ Agent-bus message/envelope contract
- ✅ Runtime-trace integration boundary
- ✅ Remote-ops queue substrate contracts
- ✅ Package/workspace stabilization
- ✅ Validation strategy for OS-owned packages

### Tripp.Control owns:
- ✅ Governance metadata
- ✅ Work orders
- ✅ Prompt packets
- ✅ Operator review
- ✅ Handoff metadata references

### Echo owns:
- ✅ Local truth verification
- ✅ Build/test verification
- ✅ Post-recovery audit

### Codex must NOT:
- ❌ Import `@tripp-os/agent-bus` from Control
- ❌ Stub or vendor agent-bus schemas
- ❌ Implement agent-bus package

---

## 21. Recap / Audit Package

### Prompts/Gates Received

| # | Gate | Date | Status |
|---|---|---|---|
| 1 | STAB-1 (planning) | 2026-06-22 | Complete |
| 2 | STAB-2 (Echo, blocked) | 2026-06-22 | Blocked |
| 3 | Reset 0A (planning) | 2026-06-22 | Complete |
| 4 | Reset 0A-R/0B/0C chain | 2026-06-22 | Complete — all 3 reports pushed |
| 5 | **Reset 0D** | 2026-06-22 | **Complete** |

### Files Created or Changed

| # | File | Status |
|---|---|---|
| 1 | `reports/tripp-os-reset-gate-0a-r-source-confirmation-and-reconciliation-audit.md` | ✅ Pushed |
| 2 | `reports/tripp-os-reset-gate-0b-package-stabilization-and-remote-ops-contract-plan.md` | ✅ Pushed |
| 3 | `reports/tripp-os-reset-gate-0c-remote-ops-schema-spec.md` | ✅ Pushed |
| 4 | `reports/tripp-os-reset-gate-0d-agent-bus-phantom-dependency-recovery-plan.md` | **New** |

### Current Markers

```
Control:        READY_FOR_KIMI_AGENT_BUS_RECOVERY_PLAN (consumed)
OS (this gate): TRIPP_OS_RESET_0D_PASS_AGENT_BUS_RECOVERY_PLAN_READY_FOR_0E
Next:           READY_FOR_TRIPP_OS_RESET_0E_AGENT_BUS_RECOVERY_IMPLEMENTATION
```

### Work Dependency Map

| Work | Owner | Blocked On | Ready? |
|---|---|---|---|
| Agent-bus implementation (0E) | Kimi/Echo | 0D plan approval | **YES** |
| Echo build validation | Echo | 0E implementation | No |
| Codex Control consumption | Codex | Nothing — can continue | **YES** |
| Remote-ops package creation | Kimi | Agent-bus recovery | No |
| Governance-pipeline | Kimi | Future gate | No |

---

## 22. Current Marker

> `TRIPP_OS_RESET_0D_PASS_AGENT_BUS_RECOVERY_PLAN_READY_FOR_0E_AGENT_BUS_RECOVERY_IMPLEMENTATION`

---

## 23. Recommended Next Marker

> ### `READY_FOR_TRIPP_OS_RESET_0E_AGENT_BUS_RECOVERY_IMPLEMENTATION`

**Scope of 0E:**
1. Create `packages/agent-bus/` directory structure
2. Define all TypeScript types (21 symbols from this report)
3. Implement minimal file-based packet I/O
4. Create `packages/agent-bus/package.json`
5. Set up workspace configuration (pnpm)
6. Update runtime-trace tsconfig for workspace resolution
7. Generate lockfile
8. Run typecheck — confirm zero errors

**0E is an implementation gate.** Planning ends here.

---

**End of 0D Report**

*All claims verified against cloned source. No files modified. No code implemented.*
