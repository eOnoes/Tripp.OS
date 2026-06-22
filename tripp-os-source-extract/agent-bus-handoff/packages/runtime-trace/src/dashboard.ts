/**
 * @tripp-os/runtime-trace — HTML Dashboard Generator
 *
 * Generates a self-contained HTML file from a handoff bundle
 * for visual operator inspection.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ── generateDashboard ─────────────────────────────────────────────────

/**
 * Generate a self-contained HTML dashboard from a handoff bundle.
 * The output is a single HTML file with no external dependencies.
 */
export async function generateDashboard(bundleDir: string, outputPath?: string): Promise<string> {
  const summaryRaw = await fs.readFile(path.join(bundleDir, "trace-summary.json"), "utf-8");
  const summary = JSON.parse(summaryRaw) as Record<string, unknown>;

  const validationRaw = await fs.readFile(path.join(bundleDir, "trace-validation.json"), "utf-8");
  const validation = JSON.parse(validationRaw) as Record<string, unknown>;

  const healthRaw = await fs.readFile(path.join(bundleDir, "trace-health.json"), "utf-8");
  const health = JSON.parse(healthRaw) as Record<string, unknown>;

  const checksumsRaw = await fs.readFile(path.join(bundleDir, "trace-checksums.json"), "utf-8");
  const checksums = JSON.parse(checksumsRaw) as Record<string, unknown>;

  const manifestRaw = await fs.readFile(path.join(bundleDir, "trace-manifest.json"), "utf-8");
  const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;

  const html = buildHtml(summary, validation, health, checksums, manifest);

  const outPath = outputPath ?? path.join(bundleDir, "dashboard.html");
  await fs.writeFile(outPath, html, "utf-8");
  return outPath;
}

// ── HTML Builder ──────────────────────────────────────────────────────

function buildHtml(
  summary: Record<string, unknown>,
  validation: Record<string, unknown>,
  health: Record<string, unknown>,
  checksums: Record<string, unknown>,
  manifest: Record<string, unknown>
): string {
  const confidence = String(summary.confidence_level ?? "unknown");
  const confidenceColor = confidence === "confirmed" ? "#22c55e" : confidence === "report-backed" ? "#f59e0b" : "#ef4444";
  const isValid = validation.is_valid === true;

  const files = (manifest.files ?? []) as Array<{ file: string; size: number; digest: string }>;
  const checksumList = (checksums.files_checked ?? []) as Array<{
    file: string; checksumFile: string; expected: string | null; actual: string | null; verified: boolean;
  }>;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tripp.OS Trace Handoff Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.6;padding:2rem}
.container{max-width:1200px;margin:0 auto}
h1{color:#f8fafc;font-size:1.8rem;margin-bottom:0.5rem}
.subtitle{color:#94a3b8;font-size:0.9rem;margin-bottom:2rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.5rem;margin-bottom:2rem}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.5rem}
.card h2{font-size:1.1rem;color:#f8fafc;margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem}
.badge{display:inline-block;padding:0.25rem 0.75rem;border-radius:999px;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em}
.badge-confirmed{background:#064e3b;color:#6ee7b7}
.badge-report-backed{background:#78350f;color:#fcd34d}
.badge-unknown{background:#7f1d1d;color:#fca5a5}
.badge-valid{background:#064e3b;color:#6ee7b7}
.badge-invalid{background:#7f1d1d;color:#fca5a5}
table{width:100%;border-collapse:collapse;font-size:0.85rem}
th{text-align:left;padding:0.5rem;color:#94a3b8;font-weight:500;border-bottom:1px solid #334155}
td{padding:0.5rem;border-bottom:1px solid #1e293b}
tr:hover td{background:#252f47}
.status-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:0.4rem}
.status-verified{background:#22c55e}
.status-missing{background:#f59e0b}
.status-failed{background:#ef4444}
.metric{display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid #334155}
.metric:last-child{border-bottom:none}
.metric-label{color:#94a3b8;font-size:0.85rem}
.metric-value{color:#f8fafc;font-weight:500}
.footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #334155;color:#64748b;font-size:0.8rem;text-align:center}
</style>
</head>
<body>
<div class="container">
<h1>Tripp.OS Trace Handoff</h1>
<div class="subtitle">${escapeHtml(String(summary.source_trace_root ?? ""))} &middot; ${escapeHtml(String(summary.generated_at ?? ""))}</div>

<div class="grid">
  <div class="card">
    <h2>Confidence</h2>
    <div>
      <span class="badge badge-${confidence.replace(/\s+/g, "-")}" style="background:${confidenceColor}20;color:${confidenceColor};border:1px solid ${confidenceColor}40">${escapeHtml(confidence)}</span>
      <p style="margin-top:0.75rem;color:#94a3b8;font-size:0.85rem">${escapeHtml(String(summary.confidence_reason ?? ""))}</p>
    </div>
  </div>

  <div class="card">
    <h2>Validation</h2>
    <span class="badge ${isValid ? "badge-valid" : "badge-invalid"}">${isValid ? "VALID LEDGER" : "MALFORMED LINES"}</span>
    <div style="margin-top:0.75rem">
      <div class="metric"><span class="metric-label">Total lines</span><span class="metric-value">${Number(validation.total_lines ?? 0).toLocaleString()}</span></div>
      <div class="metric"><span class="metric-label">Valid lines</span><span class="metric-value">${Number(validation.valid_lines ?? 0).toLocaleString()}</span></div>
      <div class="metric"><span class="metric-label">Malformed</span><span class="metric-value">${Number(validation.malformed_lines ?? 0).toLocaleString()}</span></div>
    </div>
  </div>

  <div class="card">
    <h2>Health</h2>
    <div>
      <div class="metric"><span class="metric-label">Writable</span><span class="metric-value">${health.writable ? "Yes" : "No"}</span></div>
      <div class="metric"><span class="metric-label">Degraded</span><span class="metric-value">${health.degraded ? "Yes" : "No"}</span></div>
      <div class="metric"><span class="metric-label">Fallback sink</span><span class="metric-value">${escapeHtml(String(health.fallback_sink ?? "none"))}</span></div>
      <div class="metric"><span class="metric-label">Total appends</span><span class="metric-value">${Number(health.total_appends ?? 0).toLocaleString()}</span></div>
    </div>
  </div>

  <div class="card">
    <h2>Checksums</h2>
    <div>
      <div class="metric"><span class="metric-label">Enabled</span><span class="metric-value">${checksums.checksums_enabled ? "Yes" : "No"}</span></div>
      <div class="metric"><span class="metric-label">Algorithm</span><span class="metric-value">${escapeHtml(String(checksums.checksum_algorithm ?? "SHA-256"))}</span></div>
      <div class="metric"><span class="metric-label">Files checked</span><span class="metric-value">${Number(checksums.files_checked ?? 0).toLocaleString()}</span></div>
      <div class="metric"><span class="metric-label">All verified</span><span class="metric-value">${checksums.all_verified ? "Yes" : "No"}</span></div>
    </div>
  </div>
</div>

<div class="card" style="margin-bottom:1.5rem">
  <h2>Bundle Files (${files.length})</h2>
  <table>
    <thead><tr><th>File</th><th>Size</th><th>Digest (SHA-256)</th></tr></thead>
    <tbody>
      ${files.map((f) => `<tr><td>${escapeHtml(f.file)}</td><td>${formatBytes(f.size)}</td><td style="font-family:monospace;font-size:0.75rem;color:#94a3b8">${f.digest.slice(0, 16)}...</td></tr>`).join("")}
    </tbody>
  </table>
</div>

${checksumList.length > 0 ? `
<div class="card" style="margin-bottom:1.5rem">
  <h2>Checksum Verification (${checksumList.length})</h2>
  <table>
    <thead><tr><th>File</th><th>Status</th><th>Expected</th><th>Actual</th></tr></thead>
    <tbody>
      ${checksumList.map((c) => {
        const status = c.verified ? "verified" : c.expected === null ? "missing" : "failed";
        const dotColor = c.verified ? "#22c55e" : c.expected === null ? "#f59e0b" : "#ef4444";
        return `<tr>
          <td>${escapeHtml(c.file)}</td>
          <td><span class="status-dot" style="background:${dotColor}"></span>${status}</td>
          <td style="font-family:monospace;font-size:0.75rem;color:#94a3b8">${c.expected ? c.expected.slice(0, 12) + "..." : "—"}</td>
          <td style="font-family:monospace;font-size:0.75rem;color:#94a3b8">${c.actual ? c.actual.slice(0, 12) + "..." : "—"}</td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>
</div>
` : ""}

<div class="footer">
  Generated by Tripp.OS runtime-trace &middot; ${escapeHtml(String(summary.producer ?? ""))} v${escapeHtml(String(summary.producer_version ?? ""))}
  &middot; ${escapeHtml(String(summary.contract_classification ?? ""))}
</div>
</div>
</body>
</html>`;
}

// ── Utilities ─────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
