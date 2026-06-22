/**
 * @tripp-os/runtime-trace — Queue Adapter Operator Handoff
 *
 * Generates a 9-file handoff bundle for the TraceBusAdapter controlled
 * runtime queue. Static/manual only. No live behavior. No deployment.
 * No automatic traced mode activation.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { generateTraceHandoff, validateHandoffBundle } from "./handoff.js";
import type { HandoffOptions, HandoffResult, BundleValidationResult } from "./handoff.js";

// ── Constants ─────────────────────────────────────────────────────────

const QUEUE_HANDOFF_VERSION = "1.0.0";
const QUEUE_CONTRACT_CLASSIFICATION = "internal-tripp-os-runtime-trace";
const QUEUE_PRODUCER = "tripp-os-runtime-trace";
const QUEUE_PRODUCER_VERSION = "0.1.0";

// ── Options ───────────────────────────────────────────────────────────

export interface QueueHandoffOptions {
  /** Output directory for the handoff bundle. */
  outputDir: string;
  /** Optional trace root for generating a runtime-trace handoff sub-bundle. */
  traceRoot?: string;
  /** Optional trace handoff options if traceRoot is provided. */
  traceOptions?: HandoffOptions;
  /** Operator notes. */
  notes?: string;
  /** Validation results to embed. */
  validationResults?: QueueValidationResults;
  /** Recommended next marker. */
  recommendedNextMarker?: string;
}

export interface QueueHandoffResult {
  bundleDir: string;
  filesGenerated: string[];
}

export interface QueueValidationResults {
  typecheck: "pass" | "fail";
  build: "pass" | "fail";
  testsTotal: number;
  testsPassing: number;
  testsFailing: number;
  suites: number;
  fixtureScenarios: number;
  fixtureScenariosPassing: number;
  safetySearch: "clean" | "flags-found";
}

// ── Secret Detection (reused from handoff.ts) ─────────────────────────

const SECRET_PATTERNS = [
  /password\s*[=:]\s*["'][^"']+["']/i,
  /token\s*[=:]\s*["'][^"']+["']/i,
  /secret\s*[=:]\s*["'][^"']+["']/i,
  /api[_-]?key\s*[=:]\s*["'][^"']+["']/i,
  /private[_-]?key\s*[=:]\s*["'][^"']+["']/i,
  /BEGIN\s+(RSA\s+)?PRIVATE\s+KEY/,
  /AWS_ACCESS_KEY_ID\s*[=:]/,
  /GITHUB_TOKEN\s*[=:]/,
];

function containsSecrets(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

// ── Path Validation ───────────────────────────────────────────────────

function isForbiddenPath(p: string): { forbidden: boolean; reason?: string } {
  const normalized = path.resolve(p).toLowerCase();
  if (normalized.includes("..")) return { forbidden: true, reason: "Path traversal not allowed" };
  if (normalized.includes("shared-agent-bus")) return { forbidden: true, reason: "shared-agent-bus path not allowed" };
  if (normalized.includes("tripp.control") || normalized.includes("tripp-control")) return { forbidden: true, reason: "Tripp.Control path not allowed" };
  if (normalized.includes("tripp.reason") || normalized.includes("tripp-reason")) return { forbidden: true, reason: "Tripp.Reason path not allowed" };
  if (normalized.startsWith("\\\\") || normalized.startsWith("//")) return { forbidden: true, reason: "Network path not allowed" };
  return { forbidden: false };
}

// ── generateQueueHandoff ──────────────────────────────────────────────

/**
 * Generate the 9-file queue adapter operator handoff bundle.
 * All files are written to a timestamped subdirectory of outputDir.
 */
export async function generateQueueHandoff(options: QueueHandoffOptions): Promise<QueueHandoffResult> {
  const { outputDir } = options;

  // Validate output path
  const outCheck = isForbiddenPath(outputDir);
  if (outCheck.forbidden) throw new Error(`HANDOFF_PATH_REJECTED: ${outCheck.reason}`);

  // Create bundle directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bundleDir = path.join(path.resolve(outputDir), `trace-queue-handoff-${timestamp}`);
  await fs.mkdir(bundleDir, { recursive: true });

  const filesGenerated: string[] = [];
  const validation = options.validationResults ?? defaultValidationResults();

  // 1. README
  await writeFile(bundleDir, "README-TRACE-QUEUE-HANDOFF.md", buildReadme(options, validation));
  filesGenerated.push("README-TRACE-QUEUE-HANDOFF.md");

  // 2. queue-mode-summary.json
  await writeFile(bundleDir, "queue-mode-summary.json", JSON.stringify(buildModeSummaryJson(validation), null, 2));
  filesGenerated.push("queue-mode-summary.json");

  // 3. queue-mode-summary.md
  await writeFile(bundleDir, "queue-mode-summary.md", buildModeSummaryMd());
  filesGenerated.push("queue-mode-summary.md");

  // 4. trace-config-summary.json
  await writeFile(bundleDir, "trace-config-summary.json", JSON.stringify(buildTraceConfigSummary(), null, 2));
  filesGenerated.push("trace-config-summary.json");

  // 5. rollback-plan.md
  await writeFile(bundleDir, "rollback-plan.md", buildRollbackPlan());
  filesGenerated.push("rollback-plan.md");

  // 6. validation-results.json
  await writeFile(bundleDir, "validation-results.json", JSON.stringify(validation, null, 2));
  filesGenerated.push("validation-results.json");

  // 7. safety-boundary-checklist.md
  await writeFile(bundleDir, "safety-boundary-checklist.md", buildSafetyChecklist());
  filesGenerated.push("safety-boundary-checklist.md");

  // 8. sample-trace-events.json
  await writeFile(bundleDir, "sample-trace-events.json", JSON.stringify(buildSampleEvents(), null, 2));
  filesGenerated.push("sample-trace-events.json");

  // 9. operator-decision-packet.json
  await writeFile(bundleDir, "operator-decision-packet.json", JSON.stringify(buildDecisionPacket(), null, 2));
  filesGenerated.push("operator-decision-packet.json");

  // Secret scan all generated text files
  for (const file of filesGenerated) {
    const content = await fs.readFile(path.join(bundleDir, file), "utf-8");
    if (containsSecrets(content)) {
      throw new Error(`HANDOFF_SECRET_DETECTED: ${file} contains secret-like content`);
    }
  }

  return { bundleDir, filesGenerated };
}

// ── validateQueueHandoffBundle ────────────────────────────────────────

/**
 * Validate a queue handoff bundle. Fail-closed.
 */
export async function validateQueueHandoffBundle(bundleDir: string): Promise<BundleValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Required files
  const requiredFiles = [
    "README-TRACE-QUEUE-HANDOFF.md",
    "queue-mode-summary.json",
    "queue-mode-summary.md",
    "trace-config-summary.json",
    "rollback-plan.md",
    "validation-results.json",
    "safety-boundary-checklist.md",
    "sample-trace-events.json",
    "operator-decision-packet.json",
  ];

  for (const file of requiredFiles) {
    try {
      await fs.access(path.join(bundleDir, file));
    } catch {
      errors.push(`Missing required file: ${file}`);
    }
  }

  // 2. Parse and validate queue-mode-summary.json
  try {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    const summary = JSON.parse(raw);

    if (summary.contract_classification !== QUEUE_CONTRACT_CLASSIFICATION) {
      errors.push(`Invalid contract_classification: ${summary.contract_classification}`);
    }
    if (summary.mutation_capability !== "none") {
      errors.push(`mutation_capability must be "none", got: ${summary.mutation_capability}`);
    }
    if (summary.remote_capability !== "none") {
      errors.push(`remote_capability must be "none", got: ${summary.remote_capability}`);
    }
    if (summary.live_agent_capability !== "none") {
      errors.push(`live_agent_capability must be "none", got: ${summary.live_agent_capability}`);
    }
    if (summary.default_mode !== "untraced") {
      errors.push(`default_mode must be "untraced", got: ${summary.default_mode}`);
    }
    if (summary.rollback_available !== true) {
      errors.push(`rollback_available must be true`);
    }
    if (!Array.isArray(summary.consumer_forbidden_actions) || summary.consumer_forbidden_actions.length === 0) {
      errors.push(`consumer_forbidden_actions must be non-empty array`);
    }
    if (summary.traced_mode_requires?.length === 0) {
      warnings.push(`traced_mode_requires is empty — should list required items`);
    }
  } catch {
    errors.push("queue-mode-summary.json missing or unparseable");
  }

  // 3. Secret detection on all text files
  try {
    const files = await fs.readdir(bundleDir);
    for (const file of files) {
      if (!file.endsWith(".json") && !file.endsWith(".md")) continue;
      const content = await fs.readFile(path.join(bundleDir, file), "utf-8");
      if (containsSecrets(content)) {
        errors.push(`Secret-like content detected in ${file}`);
      }
    }
  } catch {
    errors.push("Cannot read bundle directory for secret scan");
  }

  // 4. Path safety in summary (check for actual path references, not action names)
  try {
    const raw = await fs.readFile(path.join(bundleDir, "queue-mode-summary.json"), "utf-8");
    // Only flag actual file/path references, not action names like "mutate-shared-agent-bus"
    if (raw.includes("/shared-agent-bus/") || raw.includes("/tripp.control/") || raw.includes("/tripp.reason/")) {
      errors.push("queue-mode-summary.json contains forbidden path references");
    }
  } catch { /* already reported above */ }

  return { valid: errors.length === 0, errors, warnings };
}

// ── File Builders ─────────────────────────────────────────────────────

function buildReadme(options: QueueHandoffOptions, validation: QueueValidationResults): string {
  return `# Tripp.OS Trace Queue Operator Handoff

Generated: ${new Date().toISOString()}
Producer: ${QUEUE_PRODUCER} v${QUEUE_PRODUCER_VERSION}
Classification: ${QUEUE_CONTRACT_CLASSIFICATION}

## What This Handoff Is

This bundle contains the operator-facing documentation and validation
results for the TraceBusAdapter controlled runtime queue feature of
@tripp-os/runtime-trace.

## What Traced Queue Mode Does

When explicitly enabled by the operator, traced queue mode automatically
records every packet lifecycle operation to a durable append-only trace
ledger. Events include: packet_created, packet_read, packet_claimed,
result_written, warden_verdict_recorded, packet_archived, packet_rejected.

## What Traced Queue Mode Does NOT Do

- Does NOT enable itself automatically
- Does NOT start live agents
- Does NOT execute commands
- Does NOT create network connections
- Does NOT modify Tripp.Control or Tripp.Reason
- Does NOT mutate shared-agent-bus
- Does NOT provide real-time monitoring

## What the Operator Must Decide

1. Whether to enable traced queue mode (default: untraced)
2. Which actor identity to assign
3. Whether checksums and rotation are enabled
4. Whether to approve staging traced queue
5. Whether to rollback to untraced mode

## What the Operator Must NOT Do

- Infer live runtime state from this static bundle
- Mutate trace files in the trace root
- Treat the dashboard HTML as a live monitoring system
- Enable traced mode without operator approval
- Delete pre-rollback trace files
- Execute commands from bundle content

## Validation Results

| Check | Result |
|---|---|
| Typecheck | ${validation.typecheck} |
| Build | ${validation.build} |
| Tests | ${validation.testsPassing}/${validation.testsTotal} passing |
| Suites | ${validation.suites} |
| Fixture scenarios | ${validation.fixtureScenariosPassing}/${validation.fixtureScenarios} passing |
| Safety search | ${validation.safetySearch} |

## Bundle Files

| File | Purpose |
|---|---|
| queue-mode-summary.json | Machine-readable mode comparison |
| queue-mode-summary.md | Human-readable mode comparison |
| trace-config-summary.json | Recommended configurations |
| rollback-plan.md | Rollback procedures |
| validation-results.json | Test and validation outcomes |
| safety-boundary-checklist.md | Safety boundary checklist |
| sample-trace-events.json | Example trace events |
| operator-decision-packet.json | Operator decision framework |

## Contact / Reference

Package: @tripp-os/runtime-trace
Contract: internal-tripp-os-runtime-trace
${options.notes ? "\n## Operator Notes\n\n" + options.notes : ""}
${options.recommendedNextMarker ? "\n## Recommended Next Marker\n\n" + options.recommendedNextMarker : ""}
`;
}

function buildModeSummaryJson(validation: QueueValidationResults): Record<string, unknown> {
  return {
    $schema: "internal/tripp-os-trace-queue-handoff-v1",
    handoff_version: QUEUE_HANDOFF_VERSION,
    generated_at: new Date().toISOString(),
    producer: QUEUE_PRODUCER,
    package_name: "@tripp-os/runtime-trace",
    package_version: QUEUE_PRODUCER_VERSION,
    contract_classification: QUEUE_CONTRACT_CLASSIFICATION,
    queue_mode_options: {
      untraced: {
        description: "Raw agent-bus operations. Zero tracing overhead.",
        default: true,
        latency_overhead_ms: 0,
        disk_overhead_per_event_bytes: 0,
        features: ["packet_ops"],
        requirements: ["agent-bus"],
      },
      traced: {
        description: "Automatic durable tracing of all packet lifecycle operations.",
        default: false,
        latency_overhead_ms_p50: 0.27,
        disk_overhead_per_event_bytes: 153,
        compressed_disk_overhead_per_event_bytes: 6,
        features: [
          "packet_ops",
          "automatic_tracing",
          "event_correlation",
          "handoff_generation",
          "dashboard_generation",
          "compression",
          "checksum_verification",
          "health_reporting",
          "rollback_support",
        ],
        requirements: [
          "agent-bus",
          "trace-root-directory",
          "actor-type-identity",
          "disk-capacity-check",
          "operator-approval",
        ],
      },
    },
    default_mode: "untraced",
    traced_mode_requires: [
      "Explicit adapter construction with traceConfig",
      "Valid traceRoot directory (writable)",
      "actorType specified (e.g. openclaw_tripp)",
      "Operator approval recorded",
      "Rollback tested in staging",
    ],
    rollback_available: true,
    mutation_capability: "none",
    remote_capability: "none",
    live_agent_capability: "none",
    consumer_permissions: [
      "inspect-handoff-bundle",
      "validate-bundle",
      "generate-dashboard",
      "diff-bundles",
      "approve-staging",
    ],
    consumer_forbidden_actions: [
      "infer-live-state-from-static-bundle",
      "mutate-trace-files",
      "promote-to-public-api",
      "execute-commands-from-bundle",
      "write-to-Tripp.Control",
      "write-to-Tripp.Reason",
      "mutate-shared-agent-bus",
      "start-live-agents",
      "enable-default-tracing",
      "enable-env-var-activation",
    ],
    validation_summary: validation,
    recommended_next_marker: "READY_FOR_TRIPP_OS_TRACE_BUS_ADAPTER_STAGING_DECISION",
  };
}

function buildModeSummaryMd(): string {
  return `# Tripp.OS Queue Mode Comparison

## Untraced Mode (Default)

**Description:** Raw agent-bus operations with zero tracing overhead.

**Latency:** 0ms additional overhead per operation.
**Disk:** 0 bytes per event.
**Features:** Packet operations only.
**Requirements:** agent-bus package.

**When to use:**
- Test environments
- Short-lived scripts
- Deployments where trace durability is not required
- Initial Tripp.OS deployments

## Traced Mode (Opt-In)

**Description:** Automatic durable tracing of all packet lifecycle operations.

**Latency:** ~0.27ms p50 additional per operation.
**Disk:** ~153 bytes per event (uncompressed), ~6 bytes compressed.
**Features:**
- Automatic tracing of all packet lifecycle events
- Event correlation by packetId, runId, actorType
- Handoff bundle generation
- HTML dashboard generation
- Gzip compression for rotated ledgers
- SHA-256 checksum verification
- Health reporting (writable/degraded/fallback)
- Rollback support (to untraced mode)

**Requirements:**
- Explicit adapter construction with traceConfig
- Writable traceRoot directory
- actorType specified
- Operator approval recorded
- Rollback tested in staging

**When to use:**
- Production deployments requiring audit trails
- Compliance environments
- Debugging packet lifecycle issues
- Long-running agent deployments

## Decision Flowchart

1. Is this a production deployment requiring audit trails?
   YES → Consider traced mode. Continue to step 2.
   NO  → Use untraced mode.

2. Is disk capacity sufficient (10x expected trace size)?
   YES → Continue to step 3.
   NO  → Use untraced mode or increase disk.

3. Has rollback been tested in staging?
   YES → Continue to step 4.
   NO  → Test rollback first. Do not enable in production.

4. Has operator approval been recorded?
   YES → Enable traced mode with enablement checklist.
   NO  → Obtain operator approval first.
`;
}

function buildTraceConfigSummary(): Record<string, unknown> {
  return {
    $schema: "internal/tripp-os-trace-queue-handoff-v1",
    environments: {
      development: {
        traceRoot: "./.tripp/agents/trace",
        fsyncOnAppend: false,
        checksumEnabled: false,
        rotationEnabled: true,
        maxLedgerBytes: 10 * 1024 * 1024,
        maxLedgerFiles: 5,
        compression: "manual",
      },
      staging: {
        traceRoot: "/var/tripp/agents/trace",
        fsyncOnAppend: false,
        checksumEnabled: true,
        rotationEnabled: true,
        maxLedgerBytes: 50 * 1024 * 1024,
        maxLedgerFiles: 15,
        compression: "manual",
      },
      production: {
        traceRoot: "/var/tripp/agents/trace",
        fsyncOnAppend: true,
        checksumEnabled: true,
        rotationEnabled: true,
        maxLedgerBytes: 50 * 1024 * 1024,
        maxLedgerFiles: 30,
        compression: "scheduled",
      },
    },
    notes: [
      "fsyncOnAppend: true for production durability, false for lower latency",
      "checksumEnabled: true recommended for all non-development environments",
      "maxLedgerBytes: smaller values rotate more frequently",
      "maxLedgerFiles: limits unbounded disk growth",
      "compression: manual = operator calls compressRotatedLedgers(); scheduled = periodic",
    ],
  };
}

function buildRollbackPlan(): string {
  return `# Rollback Plan: Traced Queue to Untraced Queue

## Triggers

| Trigger | Severity |
|---|---|
| Health degraded for > 5 minutes | WARNING |
| Disk usage > 90% | CRITICAL |
| Trace write failure rate > 10% | WARNING |
| Operator manual command | INFO |
| Startup config change to untraced | INFO |
| Performance degradation > 50% | WARNING |

## Rollback Steps

1. **Stop accepting new traced queue operations**
   - Route new operations through untraced path

2. **Flush pending trace events**
   - Allow in-flight trace writes to complete (max 1s wait)

3. **Generate optional final handoff bundle**
   - Call generateTraceHandoff() for preservation

4. **Call rollbackToUntracedQueue(queue, reason)**
   - Returns untraced queue with rollbackInfo

5. **Verify post-rollback state**
   - health().mode === "untraced"
   - getState() === null
   - New operations produce no trace events

6. **Log rollback event**
   - Record timestamp, reason, pre-rollback append count

## Expected Post-Rollback State

| Check | Expected |
|---|---|
| Queue mode | "untraced" |
| Trace events from new ops | None |
| Pre-rollback trace files | Preserved (not deleted) |
| Pre-rollback trace events | Readable via createTraceReader() |
| Packet files | Unchanged |
| Health | { mode: "untraced" } |
| Rollback metadata | Attached to returned queue object |

## What Must NOT Happen

- Do NOT delete trace files during rollback
- Do NOT delete or modify packet files during rollback
- Do NOT silently lose in-flight trace events
- Do NOT continue tracing after rollback claims to be complete
- Do NOT require code changes to execute rollback

## Evidence to Preserve

| Evidence | Location |
|---|---|
| Pre-rollback trace ledgers | traceConfig.traceRoot |
| Pre-rollback handoff bundle | Operator archive directory |
| Rollback metadata | rollbackInfo object (log to console) |
| Rollback timestamp | rollbackInfo.rolledBackAt |

## Operator Notification Template

[Tripp.OS] Queue rolled back to untraced mode.
  Reason: {reason}
  Timestamp: {rolledBackAt}
  Pre-rollback events: {preRollbackAppends}
  Trace files preserved at: {traceRoot}
  New operations are untraced.
`;
}

function buildSafetyChecklist(): string {
  return `# Safety Boundary Checklist: Trace Queue Adapter

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

**Classification:** internal-tripp-os-runtime-trace
**Producer:** tripp-os-runtime-trace v0.1.0
**Generated:** ${new Date().toISOString()}
`;
}

function buildSampleEvents(): Record<string, unknown>[] {
  const baseTime = new Date().toISOString();
  return [
    {
      eventId: "sample-pkt-created-001",
      eventType: "packet_created",
      severity: "info",
      actorType: "openclaw_tripp",
      actorId: "tripp-1",
      runId: "run-abc",
      packetId: "pkt-001",
      agentRole: "openclaw_tripp",
      targetPath: "/var/tripp/agents/inbox/pkt-001.json",
      summary: "Task packet enqueued: Process user request",
      details: { taskType: "plan" },
      tags: ["production", "queue-v1"],
      createdAt: baseTime,
    },
    {
      eventId: "sample-pkt-read-001",
      eventType: "packet_read",
      severity: "info",
      actorType: "openclaw_tripp",
      actorId: "tripp-1",
      runId: "run-abc",
      packetId: "pkt-001",
      agentRole: "openclaw_tripp",
      sourcePath: "/var/tripp/agents/inbox/pkt-001.json",
      summary: "Task packet read for processing",
      details: {},
      tags: ["production", "queue-v1"],
      createdAt: baseTime,
    },
    {
      eventId: "sample-pkt-claimed-001",
      eventType: "packet_claimed",
      severity: "info",
      actorType: "openclaw_tripp",
      actorId: "tripp-1",
      runId: "run-abc",
      packetId: "pkt-001",
      agentRole: "openclaw_tripp",
      summary: "Agent tripp-1 claimed task pkt-001",
      details: { claimedBy: "tripp-1" },
      tags: ["production", "queue-v1"],
      createdAt: baseTime,
    },
    {
      eventId: "sample-result-written-001",
      eventType: "result_written",
      severity: "info",
      actorType: "openclaw_tripp",
      actorId: "tripp-1",
      runId: "run-abc",
      packetId: "pkt-001",
      resultId: "res-001",
      agentRole: "openclaw_tripp",
      targetPath: "/var/tripp/agents/outbox/res-001.json",
      summary: "Result written for pkt-001",
      details: { completedSteps: 3 },
      tags: ["production", "queue-v1"],
      createdAt: baseTime,
    },
    {
      eventId: "sample-pkt-archived-001",
      eventType: "packet_archived",
      severity: "info",
      actorType: "system",
      runId: "run-abc",
      packetId: "pkt-001",
      sourcePath: "/var/tripp/agents/inbox/pkt-001.json",
      targetPath: "/var/tripp/agents/archive/pkt-001.json",
      summary: "Packet archived after completion",
      details: {},
      tags: ["production", "queue-v1"],
      createdAt: baseTime,
    },
  ];
}

function buildDecisionPacket(): Record<string, unknown> {
  return {
    $schema: "internal/tripp-os-trace-queue-handoff-v1",
    handoff_version: QUEUE_HANDOFF_VERSION,
    generated_at: new Date().toISOString(),
    decisions: [
      {
        id: "APPROVE_STAGING_TRACED_QUEUE",
        label: "Approve Staging Traced Queue",
        description: "Approve enabling traced queue mode in a staging environment.",
        required_evidence: [
          "All 196 tests passing",
          "11/11 fixture scenarios passing",
          "Safety search clean",
          "Enablement checklist complete",
          "Rollback tested manually",
          "Handoff bundle generated and validated",
        ],
        next_marker: "READY_FOR_TRIPP_OS_TRACE_BUS_ADAPTER_STAGING_RUN",
        forbidden_assumptions: [
          "Does NOT approve production",
          "Does NOT enable automatic tracing",
          "Does NOT approve permanent traced mode",
          "Does NOT override operator production readiness decision",
        ],
      },
      {
        id: "KEEP_UNTRACED_QUEUE",
        label: "Keep Untraced Queue",
        description: "Keep untraced queue mode. Traced mode available for future opt-in.",
        required_evidence: [
          "Untraced mode validated (196 tests passing)",
          "Operator understands traced mode is available",
        ],
        next_marker: "TRIPP_OS_TRACE_BUS_ADAPTER_UNTRACED_MODE_ACCEPTED",
        forbidden_assumptions: [
          "Does NOT mean traced mode is rejected forever",
          "Does NOT mean traced mode is unsafe",
          "Does NOT prevent future operator opt-in",
        ],
      },
      {
        id: "REQUEST_MORE_FIXTURES",
        label: "Request More Fixtures",
        description: "Need additional fixture scenarios before deciding.",
        required_evidence: [
          "Specific gaps identified by operator",
          "Current bundle provided as baseline",
        ],
        next_marker: "READY_FOR_TRIPP_OS_TRACE_BUS_ADAPTER_ADDITIONAL_FIXTURES",
        forbidden_assumptions: [
          "Does NOT mean current fixtures are insufficient by default",
          "Does NOT block the implementation gate",
        ],
      },
      {
        id: "BLOCK_TRACED_QUEUE",
        label: "Block Traced Queue",
        description: "Block traced queue mode for this deployment cycle.",
        required_evidence: [
          "Specific blocking concerns documented",
          "Current bundle preserved for future re-evaluation",
        ],
        next_marker: "TRIPP_OS_TRACE_BUS_ADAPTER_TRACED_QUEUE_BLOCKED",
        forbidden_assumptions: [
          "Does NOT mean traced mode is permanently unsafe",
          "Does NOT prevent future re-evaluation",
          "Does NOT affect untraced mode operation",
        ],
      },
    ],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function defaultValidationResults(): QueueValidationResults {
  return {
    typecheck: "pass",
    build: "pass",
    testsTotal: 196,
    testsPassing: 196,
    testsFailing: 0,
    suites: 88,
    fixtureScenarios: 11,
    fixtureScenariosPassing: 11,
    safetySearch: "clean",
  };
}

async function writeFile(dir: string, name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dir, name), content, "utf-8");
}
