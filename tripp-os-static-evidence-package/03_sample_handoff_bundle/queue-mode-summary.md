# Queue Mode Summary

| Property | Untraced | Traced |
|---|---|---|
| **Default** | Yes | No (explicit opt-in) |
| **Latency** | ~0.04ms | ~0.27ms p50 |
| **Disk overhead** | None | ~153 bytes/event |
| **Compressed** | N/A | ~6 bytes/event |
| **Checksums** | N/A | SHA-256 |
| **Rotation** | N/A | Collision-safe timestamps |
| **Rollback** | N/A | Full support |

## Decision Flow

1. Is operator approval documented? → YES → Continue
2. Is explicit adapter constructed? → YES → Continue
3. Is traceRoot isolated? → YES → Enable traced mode
4. Any stop condition? → YES → Rollback immediately

## Consumer Rules
- Default is untraced
- Traced requires explicit adapter
- No env-var activation
- Rollback always available
