/**
 * @tripp-os/runtime-trace — Trace Health
 *
 * Health status types and checks for the trace writer.
 * Runtime integration is optional — types only, no runtime behavior imported.
 */

// ── Trace Health Status ───────────────────────────────────────────────

export interface TraceHealthStatus {
  /** Can we write to the primary sink? */
  readonly writable: boolean;

  /** Are we operating in fallback/degraded mode? */
  readonly degraded: boolean;

  /** Which fallback sink is active (if any)? */
  readonly fallbackSink: string | null;

  /** Timestamp (ms) of the last successful write */
  readonly lastWriteMs: number;

  /**
   * Current ratio of malformed lines (0.0 to 1.0), or null if not computed.
   * This is reader-derived only — health() does not perform O(N) file scans.
   * Use TraceReader.validate() to compute the actual malformed ratio.
   */
  readonly malformedRatio: number | null;

  /** Active alert message (if any) */
  readonly alert: string | null;
}

// ── Trace Write Result ────────────────────────────────────────────────

export interface TraceWriteResult {
  readonly success: boolean;
  readonly sink: "primary" | "fallback:stderr" | "fallback:memory" | "fallback:file" | "fallback:noop" | "none";
  readonly eventId: string;
  readonly timestamp: string;
  readonly degraded?: boolean;
  readonly error?: string;
}

// ── Ledger Validation Result ──────────────────────────────────────────

export interface LedgerValidationSummary {
  readonly totalLines: number;
  readonly validLines: number;
  readonly malformedLines: number;
  readonly malformedLineNumbers: readonly number[];
  readonly isValid: boolean;
  readonly earliestTimestamp: string | null;
  readonly latestTimestamp: string | null;
}

// ── Health Check ──────────────────────────────────────────────────────

export interface TraceHealthCheckable {
  health(): TraceHealthStatus;
}

export function isTraceHealthy(checkable: TraceHealthCheckable): boolean {
  const h = checkable.health();
  return h.writable && !h.degraded;
}
