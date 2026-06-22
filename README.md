# Tripp.OS

Tripp.OS — agent-bus, runtime-trace, and OS-level contracts for the Tripp multi-agent system.

## Packages

- **`@tripp-os/agent-bus`** — File-based inter-agent message bus with typed schemas, trace ledger, and transport layer
- **`@tripp-os/runtime-trace`** — Runtime trace writer, reader, handoff, queue, adapter, and health monitoring

## Structure

```
tripp-os-source-extract/agent-bus-handoff/packages/
├── agent-bus/          @tripp-os/agent-bus
│   ├── src/            TypeScript source
│   └── package.json
└── runtime-trace/      @tripp-os/runtime-trace
    ├── src/            TypeScript source + tests
    └── package.json

tripp-os-static-evidence-package/
├── 00_INDEX.md
├── 01_state_manifest.json
├── 02_handoff_bundle_schemas.json
├── 03_sample_handoff_bundle/
├── 04_production_readiness_summary.md
├── 05_rollout_plan_summary.md
├── 06_marker_glossary.json
├── 07_control_intake_validation.json
├── 08_boundary_statement.md
├── DELIVERY_RECEIPT.md
└── MANIFEST.sha256
```

## Source

Extracted from `Kimi_Agent_Tripp.OS Audit Blocked.zip` (Stage 6M — lane complete).

## Status

- **Stage:** 6M — Final Runtime Trace Handoff Audit — LANE COMPLETE
- **Tests:** 130/130 passing (agent-bus + runtime-trace)
- **Owner:** Kimi
- **Platform:** Built on Linux (sandbox)
