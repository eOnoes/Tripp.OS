/**
 * @tripp-os/agent-bus
 *
 * File-based inter-agent message bus with typed schemas, trace ledger,
 * and transport layer.
 *
 * Recovered package — minimal implementation based on runtime-trace
 * usage patterns. Provides the 21 symbols required by existing imports.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

// ── Enums ──────────────────────────────────────────────────────────────

export const AgentBusTraceEventTypeSchema = z.enum([
  "packet_created",
  "packet_read",
  "packet_claimed",
  "packet_archived",
  "packet_rejected",
  "result_written",
  "result_read",
  "schema_validation_failed",
  "warden_review_started",
  "warden_verdict_recorded",
  "human_decision_recorded",
  "tools_loaded",
  "subagent_spawned",
  "subagent_completed",
]);
export type AgentBusTraceEventType = z.infer<typeof AgentBusTraceEventTypeSchema>;

// Permissive severity — tests may use custom values
export const AgentBusTraceSeveritySchema = z.string();
export type AgentBusTraceSeverity = z.infer<typeof AgentBusTraceSeveritySchema>;

// Permissive actor type — tests use "openclaw_tripp", "openclaw_echo", "operator", etc.
export const AgentBusTraceActorTypeSchema = z.string();
export type AgentBusTraceActorType = z.infer<typeof AgentBusTraceActorTypeSchema>;

// ── Packet Types ───────────────────────────────────────────────────────

export const ExternalAgentTaskPacketSchema = z.object({
  packetId: z.string().min(1),
  title: z.string().optional(),
  objective: z.string().optional(),
  agentRole: z.string().min(1),
  taskType: z.string().min(1),
  trustZone: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  schemaVersion: z.string().optional(),
  createdAt: z.string().optional(),
}).passthrough();
export type ExternalAgentTaskPacket = z.infer<typeof ExternalAgentTaskPacketSchema>;

export const ExternalAgentResultPacketSchema = z.object({
  packetId: z.string().min(1),
  summary: z.string().optional(),
  resultId: z.string().optional(),
  agentRole: z.string().optional(),
  status: z.string().optional(),
  proposedChanges: z.array(z.string()).optional().default([]),
  assumptions: z.array(z.string()).optional(),
  payload: z.record(z.unknown()).optional(),
  schemaVersion: z.string().optional(),
  createdAt: z.string().optional(),
}).passthrough();
export type ExternalAgentResultPacket = z.infer<typeof ExternalAgentResultPacketSchema>;

export const ExternalAgentReviewPacketSchema = z.object({
  packetId: z.string().min(1),
  summary: z.string().optional(),
  verdict: z.string().optional(),
  reviewId: z.string().optional(),
  reviewerRole: z.string().optional(),
  issues: z.array(z.string()).optional().default([]),
  resultId: z.string().optional(),
  schemaVersion: z.string().optional(),
  createdAt: z.string().optional(),
}).passthrough();
export type ExternalAgentReviewPacket = z.infer<typeof ExternalAgentReviewPacketSchema>;

// ── Trace Event Types ──────────────────────────────────────────────────

export const AgentBusTraceEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: AgentBusTraceEventTypeSchema,
  severity: z.string(),
  actorType: z.string(),
  actorId: z.string().optional(),
  runId: z.string().optional(),
  packetId: z.string().optional(),
  resultId: z.string().optional(),
  reviewId: z.string().optional(),
  agentRole: z.string().optional(),
  subagentId: z.string().optional(),
  subagentRole: z.string().optional(),
  sourcePath: z.string().optional(),
  targetPath: z.string().optional(),
  rootCauseEventId: z.string().optional(),
  parentEventId: z.string().optional(),
  summary: z.string().min(1),
  details: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.string(),
}).passthrough();
export type AgentBusTraceEvent = z.infer<typeof AgentBusTraceEventSchema>;

export const ValidatedTraceEventSchema = AgentBusTraceEventSchema;

export const CreateTraceEventInputSchema = z.object({
  eventType: AgentBusTraceEventTypeSchema,
  severity: z.string(),
  actorType: z.string(),
  actorId: z.string().optional(),
  runId: z.string().optional(),
  packetId: z.string().optional(),
  resultId: z.string().optional(),
  reviewId: z.string().optional(),
  agentRole: z.string().optional(),
  subagentId: z.string().optional(),
  subagentRole: z.string().optional(),
  sourcePath: z.string().optional(),
  targetPath: z.string().optional(),
  rootCauseEventId: z.string().optional(),
  parentEventId: z.string().optional(),
  summary: z.string().min(1),
  details: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
}).passthrough();
export type CreateTraceEventInput = z.infer<typeof CreateTraceEventInputSchema>;

export interface TraceEventEnvelope {
  event: AgentBusTraceEvent;
  checksum: string;
  version: string;
}

// ── Options ────────────────────────────────────────────────────────────

export interface WriteOptions {
  workdir?: string;
}

export interface ListOptions {
  workdir?: string;
}

// ── Internal: Directory Resolution ─────────────────────────────────────

function resolveWorkdir(options?: WriteOptions | ListOptions): string {
  return options?.workdir ?? process.cwd();
}

function getInboxDir(options?: WriteOptions | ListOptions): string {
  return path.join(resolveWorkdir(options), "inbox");
}

function getOutboxDir(options?: WriteOptions | ListOptions): string {
  return path.join(resolveWorkdir(options), "outbox");
}

function getArchiveDir(options?: WriteOptions | ListOptions): string {
  return path.join(resolveWorkdir(options), "archive");
}

function getRejectedDir(options?: WriteOptions | ListOptions): string {
  return path.join(resolveWorkdir(options), "rejected");
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function generatePacketId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Packet Write Functions ─────────────────────────────────────────────

export async function writeTaskPacket(
  packet: ExternalAgentTaskPacket,
  options?: WriteOptions
): Promise<string> {
  const validated = ExternalAgentTaskPacketSchema.parse(packet);
  const dir = getInboxDir(options);
  await ensureDir(dir);
  const fileName = `task-${validated.packetId ?? generatePacketId()}.json`;
  const filePath = path.join(dir, fileName);
  const data = { ...validated, writtenAt: new Date().toISOString() };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  return filePath;
}

export async function writeResultPacket(
  packet: ExternalAgentResultPacket,
  options?: WriteOptions
): Promise<string> {
  const validated = ExternalAgentResultPacketSchema.parse(packet);
  const dir = getOutboxDir(options);
  await ensureDir(dir);
  const fileName = `result-${validated.packetId ?? generatePacketId()}.json`;
  const filePath = path.join(dir, fileName);
  const data = { ...validated, writtenAt: new Date().toISOString() };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  return filePath;
}

export async function writeReviewPacket(
  packet: ExternalAgentReviewPacket,
  options?: WriteOptions
): Promise<{ jsonPath: string; mdPath: string; reviewId: string }> {
  const validated = ExternalAgentReviewPacketSchema.parse(packet);
  const dir = getOutboxDir(options);
  await ensureDir(dir);
  const reviewId = validated.reviewId ?? `review-${generatePacketId()}`;
  const fileName = `review-${reviewId}`;
  const jsonPath = path.join(dir, `${fileName}.json`);
  const mdPath = path.join(dir, `${fileName}.md`);

  const data = { ...validated, reviewId, writtenAt: new Date().toISOString() };
  await fs.writeFile(jsonPath, JSON.stringify(data, null, 2) + "\n", "utf-8");

  const mdContent = `# Review: ${reviewId}\n\n` +
    `**Packet:** ${validated.packetId}\n\n` +
    `**Verdict:** ${validated.verdict ?? "pending"}\n\n` +
    `**Issues:**\n${(validated.issues ?? []).map((i: string) => `- ${i}`).join("\n")}\n\n` +
    `**Reviewed At:** ${new Date().toISOString()}\n`;
  await fs.writeFile(mdPath, mdContent, "utf-8");

  return { jsonPath, mdPath, reviewId };
}

// ── Packet Read Functions ──────────────────────────────────────────────

export async function readTaskPacket(filePath: string): Promise<ExternalAgentTaskPacket> {
  const content = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(content);
  return ExternalAgentTaskPacketSchema.parse(parsed);
}

export async function readResultPacket(filePath: string): Promise<ExternalAgentResultPacket> {
  const content = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(content);
  return ExternalAgentResultPacketSchema.parse(parsed);
}

// ── Packet Move Functions ──────────────────────────────────────────────

export async function movePacketToArchive(
  filePath: string,
  options?: ListOptions
): Promise<string> {
  const dir = getArchiveDir(options);
  await ensureDir(dir);
  const fileName = path.basename(filePath);
  const destPath = path.join(dir, `${Date.now()}-${fileName}`);
  await fs.rename(filePath, destPath);
  return destPath;
}

export async function movePacketToRejected(
  filePath: string,
  _reason: string,
  options?: ListOptions
): Promise<string> {
  const dir = getRejectedDir(options);
  await ensureDir(dir);
  const fileName = path.basename(filePath);
  const destPath = path.join(dir, `${Date.now()}-${fileName}`);
  await fs.rename(filePath, destPath);
  return destPath;
}

// ── Listing Functions ──────────────────────────────────────────────────

export async function listInboxPackets(options?: ListOptions): Promise<string[]> {
  const dir = getInboxDir(options);
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

export async function listOutboxPackets(options?: ListOptions): Promise<string[]> {
  const dir = getOutboxDir(options);
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

// ── Trace Event Functions ──────────────────────────────────────────────

export function createTraceEvent(input: CreateTraceEventInput): AgentBusTraceEvent {
  const validated = CreateTraceEventInputSchema.parse(input);
  const hash = createHash("sha256")
    .update(`${validated.eventType}:${validated.summary}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 16);

  return {
    ...validated,
    eventId: `evt-${hash}`,
    createdAt: new Date().toISOString(),
  };
}

export async function appendTraceEvent(
  event: AgentBusTraceEvent,
  filePath: string
): Promise<void> {
  const line = JSON.stringify(event) + "\n";
  await fs.appendFile(filePath, line, "utf-8");
}
