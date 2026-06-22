/**
 * @tripp-os/runtime-trace — Ledger Compression
 *
 * Gzip compression for rotated trace ledgers.
 * Provides ~10x storage reduction with transparent read support.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";

// ── Compress ──────────────────────────────────────────────────────────

/**
 * Gzip-compress a single ledger file.
 * Removes the original after successful compression.
 * Returns the path of the compressed file (.jsonl.gz).
 */
export async function compressLedgerFile(ledgerPath: string): Promise<string> {
  const compressedPath = `${ledgerPath}.gz`;
  await pipeline(
    createReadStream(ledgerPath),
    createGzip({ level: 6 }),
    createWriteStream(compressedPath)
  );
  // Verify compressed file exists and is smaller
  const originalStat = await fs.stat(ledgerPath);
  const compressedStat = await fs.stat(compressedPath);
  if (compressedStat.size >= originalStat.size) {
    // Compression didn't help — remove compressed file and keep original
    await fs.unlink(compressedPath);
    return ledgerPath;
  }
  // Safe to remove original
  await fs.unlink(ledgerPath);
  return compressedPath;
}

/**
 * Compress all rotated ledger files in a directory.
 * Skips the current (active) ledger and already-compressed files.
 * Returns list of compressed file paths.
 */
export async function compressRotatedLedgers(traceRoot: string, currentLedger?: string): Promise<string[]> {
  const entries = await fs.readdir(traceRoot);
  const rotated = entries.filter((f) => {
    if (!f.endsWith(".jsonl")) return false;
    if (f === currentLedger) return false;
    return true;
  });

  const results: string[] = [];
  for (const file of rotated) {
    const filePath = path.join(traceRoot, file);
    const compressed = await compressLedgerFile(filePath);
    results.push(compressed);
  }
  return results;
}

// ── Decompress ────────────────────────────────────────────────────────

/**
 * Decompress a .jsonl.gz file back to .jsonl.
 * Returns the path of the decompressed file.
 */
export async function decompressLedgerFile(compressedPath: string): Promise<string> {
  if (!compressedPath.endsWith(".gz")) return compressedPath;
  const ledgerPath = compressedPath.replace(/\.gz$/, "");
  await pipeline(
    createReadStream(compressedPath),
    createGunzip(),
    createWriteStream(ledgerPath)
  );
  return ledgerPath;
}

/**
 * Read a ledger file, transparently decompressing if .jsonl.gz.
 * Returns the file content as a string.
 */
export async function readLedgerContent(ledgerPath: string): Promise<string> {
  if (ledgerPath.endsWith(".gz")) {
    const chunks: Buffer[] = [];
    const gunzip = createGunzip();
    const stream = createReadStream(ledgerPath);
    stream.pipe(gunzip);
    for await (const chunk of gunzip) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }
  return fs.readFile(ledgerPath, "utf-8");
}

/**
 * List all ledger files in a directory, including compressed ones.
 */
export async function listLedgerFiles(traceRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(traceRoot);
    return entries
      .filter((f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.gz"))
      .sort();
  } catch {
    return [];
  }
}
