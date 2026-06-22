/**
 * @tripp-os/runtime-trace — CLI
 *
 * Command-line interface for trace handoff operations.
 * Usage: node cli.js handoff <trace-root> [output-dir]
 *        node cli.js validate <bundle-dir>
 *        node cli.js diff <bundle-a> <bundle-b>
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { generateTraceHandoff, validateHandoffBundle, diffHandoffBundles } from "./index.js";
import { validateTraceConfig } from "./index.js";

function printUsage(): void {
  console.log(`
Tripp.OS Runtime Trace CLI

Usage:
  node cli.js handoff <trace-root> [output-dir]   Generate a handoff bundle
  node cli.js validate <bundle-dir>                Validate a handoff bundle
  node cli.js diff <bundle-a> <bundle-b>           Compare two bundles

Options:
  --checksums           Enable SHA-256 checksums (default: off)
  --notes <text>        Add operator notes to the bundle
  --marker <text>       Set recommended next marker

Examples:
  node cli.js handoff ./.tripp/agents/trace ./handoffs
  node cli.js validate ./handoffs/runtime-trace-handoff-2026-01-01T00-00-00
  node cli.js diff ./bundle-a ./bundle-b
`);
}

async function runHandoff(args: string[]): Promise<number> {
  const traceRoot = args[0];
  const outputDir = args[1] ?? process.cwd();

  if (!traceRoot) {
    console.error("Error: trace-root is required");
    return 1;
  }

  // Parse flags
  let checksumEnabled = false;
  let notes = "";
  let marker = "";
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--checksums") checksumEnabled = true;
    if (args[i] === "--notes" && args[i + 1]) { notes = args[++i]; }
    if (args[i] === "--marker" && args[i + 1]) { marker = args[++i]; }
  }

  try {
    const config = validateTraceConfig({
      traceRoot: path.resolve(traceRoot),
      fsyncOnAppend: false,
      checksumEnabled,
    });

    const result = await generateTraceHandoff(path.resolve(traceRoot), path.resolve(outputDir), {
      config,
      notes: notes || undefined,
      recommendedNextMarker: marker || undefined,
    });

    console.log(`Bundle generated: ${result.bundleDir}`);
    console.log(`Files: ${result.filesGenerated.length}`);
    console.log(`Confidence: ${result.confidenceLevel}`);
    console.log(`Reason: ${result.confidenceReason}`);
    return 0;
  } catch (err: unknown) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }
}

async function runValidate(args: string[]): Promise<number> {
  const bundleDir = args[0];
  if (!bundleDir) {
    console.error("Error: bundle-dir is required");
    return 1;
  }

  try {
    const result = await validateHandoffBundle(path.resolve(bundleDir));
    if (result.valid) {
      console.log("Bundle is VALID");
      if (result.warnings.length > 0) {
        console.log(`Warnings: ${result.warnings.length}`);
        for (const w of result.warnings) console.log(`  - ${w}`);
      }
      return 0;
    } else {
      console.log("Bundle is INVALID");
      console.log(`Errors: ${result.errors.length}`);
      for (const e of result.errors) console.log(`  - ${e}`);
      if (result.warnings.length > 0) {
        console.log(`Warnings: ${result.warnings.length}`);
        for (const w of result.warnings) console.log(`  - ${w}`);
      }
      return 1;
    }
  } catch (err: unknown) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }
}

async function runDiff(args: string[]): Promise<number> {
  const bundleA = args[0];
  const bundleB = args[1];
  if (!bundleA || !bundleB) {
    console.error("Error: two bundle directories are required");
    return 1;
  }

  try {
    const result = await diffHandoffBundles(path.resolve(bundleA), path.resolve(bundleB));
    console.log(`Diff: ${bundleA} vs ${bundleB}`);
    console.log(`Confidence: ${result.confidenceDelta}`);
    console.log(`New files: ${result.newFiles.length}`);
    console.log(`Missing files: ${result.missingFiles.length}`);
    console.log(`Modified files: ${result.modifiedFiles.length}`);
    if (result.malformedDelta !== 0) {
      console.log(`Malformed line delta: ${result.malformedDelta > 0 ? "+" : ""}${result.malformedDelta}`);
    }
    if (result.warnings.length > 0) {
      console.log("Warnings:");
      for (const w of result.warnings) console.log(`  - ${w}`);
    }
    return 0;
  } catch (err: unknown) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }
}

// ── Main ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const commandArgs = args.slice(1);

if (!command || command === "--help" || command === "-h") {
  printUsage();
  process.exit(0);
}

(async () => {
  let exitCode = 1;
  switch (command) {
    case "handoff":
      exitCode = await runHandoff(commandArgs);
      break;
    case "validate":
      exitCode = await runValidate(commandArgs);
      break;
    case "diff":
      exitCode = await runDiff(commandArgs);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
  }
  process.exit(exitCode);
})();
