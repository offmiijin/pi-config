import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  PeriodPreset,
  UsageBucket,
  UsageFilter,
  UsageGroup,
  UsageRecord,
  UsageSnapshot,
  UsageTotals,
} from "./types.ts";

interface CachedFile {
  mtimeMs: number;
  size: number;
  records: UsageRecord[];
}

export function getSessionsDirectory(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDir, "sessions");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timestampValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    freshTokens: 0,
    cost: 0,
    cacheHit: null,
  };
}

function addTotals(target: UsageTotals, record: UsageRecord): void {
  target.requests += 1;
  target.input += record.input;
  target.output += record.output;
  target.cacheRead += record.cacheRead;
  target.cacheWrite += record.cacheWrite;
  target.totalTokens += record.totalTokens;
  target.freshTokens += record.input + record.output + record.cacheWrite;
  target.cost += record.costTotal;
}

function finalizeTotals(totals: UsageTotals): UsageTotals {
  const denominator = totals.input + totals.cacheRead + totals.cacheWrite;
  return {
    ...totals,
    cacheHit: denominator > 0 ? totals.cacheRead / denominator : null,
  };
}

function sessionTimestamp(date: Date, startOf: "day" | "week" | "month" | "year"): number {
  if (startOf === "day") date.setHours(0, 0, 0, 0);
  if (startOf === "month") {
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
  }
  if (startOf === "year") {
    date.setMonth(0, 1);
    date.setHours(0, 0, 0, 0);
  }
  if (startOf === "week") {
    const day = date.getDay();
    const daysSinceMonday = (day + 6) % 7;
    date.setDate(date.getDate() - daysSinceMonday);
    date.setHours(0, 0, 0, 0);
  }
  return date.getTime();
}

export function getPeriodBounds(period: PeriodPreset, now = Date.now(), custom?: { from?: number; to?: number }): { from: number; to: number } {
  const end = now;
  const date = new Date(now);
  const start = (amount: number): number => now - amount;
  switch (period) {
    case "last15m": return { from: start(15 * 60_000), to: end };
    case "last30m": return { from: start(30 * 60_000), to: end };
    case "last1h": return { from: start(60 * 60_000), to: end };
    case "last3h": return { from: start(3 * 60 * 60_000), to: end };
    case "last24h": return { from: start(24 * 60 * 60_000), to: end };
    case "last48h": return { from: start(48 * 60 * 60_000), to: end };
    case "last7d": return { from: start(7 * 24 * 60 * 60_000), to: end };
    case "last30d": return { from: start(30 * 24 * 60 * 60_000), to: end };
    case "last365d": return { from: start(365 * 24 * 60 * 60_000), to: end };
    case "today": return { from: sessionTimestamp(date, "day"), to: end };
    case "yesterday": {
      const from = sessionTimestamp(date, "day") - 24 * 60 * 60_000;
      return { from, to: from + 24 * 60 * 60_000 };
    }
    case "thisWeek": return { from: sessionTimestamp(date, "week"), to: end };
    case "lastWeek": {
      const to = sessionTimestamp(date, "week");
      return { from: to - 7 * 24 * 60 * 60_000, to };
    }
    case "thisMonth": return { from: sessionTimestamp(date, "month"), to: end };
    case "lastMonth": {
      const to = sessionTimestamp(date, "month");
      const previous = new Date(to);
      previous.setMonth(previous.getMonth() - 1);
      return { from: previous.getTime(), to };
    }
    case "thisYear": return { from: sessionTimestamp(date, "year"), to: end };
    case "lastYear": {
      const to = sessionTimestamp(date, "year");
      const previous = new Date(to);
      previous.setFullYear(previous.getFullYear() - 1);
      return { from: previous.getTime(), to };
    }
    case "custom": {
      const from = custom?.from ?? now;
      const to = custom?.to ?? now;
      return from <= to ? { from, to } : { from: to, to: from };
    }
  }
}

function parseUsageRecord(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  sessionId: string,
  sessionFile: string,
  fallbackTimestamp: number,
): UsageRecord | null {
  if (entry.type !== "message" || message.role !== "assistant") return null;
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const usageData = usage as Record<string, unknown>;
  const cost = typeof usageData.cost === "object" && usageData.cost !== null
    ? usageData.cost as Record<string, unknown>
    : {};
  const provider = typeof message.provider === "string" ? message.provider : "unknown";
  const model = typeof message.model === "string" ? message.model : "unknown";
  const responseModel = typeof message.responseModel === "string" ? message.responseModel : undefined;
  const id = typeof entry.id === "string"
    ? `${sessionId}:${entry.id}`
    : `${sessionFile}:${fallbackTimestamp}:${provider}:${model}`;

  return {
    id,
    sessionId,
    sessionFile,
    timestamp: timestampValue(message.timestamp, fallbackTimestamp),
    provider,
    model,
    responseModel,
    input: numberValue(usageData.input),
    output: numberValue(usageData.output),
    cacheRead: numberValue(usageData.cacheRead),
    cacheWrite: numberValue(usageData.cacheWrite),
    totalTokens: numberValue(usageData.totalTokens),
    costInput: numberValue(cost.input),
    costOutput: numberValue(cost.output),
    costCacheRead: numberValue(cost.cacheRead),
    costCacheWrite: numberValue(cost.cacheWrite),
    costTotal: numberValue(cost.total),
  };
}

export function parseSessionText(text: string, sessionFile = ""): UsageRecord[] {
  let sessionId = sessionFile || "session";
  const records: UsageRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A session can be read while Pi is appending its final, incomplete line.
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const entry = parsed as Record<string, unknown>;
    if (entry.type === "session" && typeof entry.id === "string") {
      sessionId = entry.id;
      continue;
    }
    const message = entry.message;
    if (typeof message !== "object" || message === null) continue;
    const fallback = timestampValue(entry.timestamp, 0);
    const record = parseUsageRecord(entry, message as Record<string, unknown>, sessionId, sessionFile, fallback);
    if (record) records.push(record);
  }
  return records;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listJsonlFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

function groupRecords(records: UsageRecord[], keyOf: (record: UsageRecord) => string, labelOf: (record: UsageRecord) => string): UsageGroup[] {
  const grouped = new Map<string, UsageGroup>();
  for (const record of records) {
    const key = keyOf(record);
    let group = grouped.get(key);
    if (!group) {
      group = { key, label: labelOf(record), totals: emptyTotals() };
      grouped.set(key, group);
    }
    addTotals(group.totals, record);
  }
  return [...grouped.values()]
    .map((group) => ({ ...group, totals: finalizeTotals(group.totals) }))
    .sort((a, b) => b.totals.cost - a.totals.cost || b.totals.requests - a.totals.requests);
}

function createBuckets(records: UsageRecord[], from: number, to: number): UsageBucket[] {
  const duration = to - from;
  const bucketSize = duration <= 6 * 60 * 60_000
    ? 15 * 60_000
    : duration <= 8 * 24 * 60 * 60_000
      ? 60 * 60_000
      : 24 * 60 * 60_000;
  const count = Math.max(1, Math.min(96, Math.ceil(duration / bucketSize)));
  const actualSize = Math.max(bucketSize, Math.ceil(duration / count));
  const buckets = Array.from({ length: count }, (_, index) => {
    const start = from + index * actualSize;
    const date = new Date(start);
    const label = actualSize >= 24 * 60 * 60_000
      ? date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
      : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    return { start, label, totals: emptyTotals() };
  });
  for (const record of records) {
    const index = Math.min(buckets.length - 1, Math.max(0, Math.floor((record.timestamp - from) / actualSize)));
    const bucket = buckets[index];
    if (bucket) addTotals(bucket.totals, record);
  }
  return buckets.map((bucket) => ({ ...bucket, totals: finalizeTotals(bucket.totals) }));
}

export class UsageStore {
  private readonly cache = new Map<string, CachedFile>();
  private readonly sessionsRoot: string;

  constructor(sessionsDirectory = getSessionsDirectory()) {
    this.sessionsRoot = sessionsDirectory;
  }

  async loadRecords(): Promise<UsageRecord[]> {
    const paths = await listJsonlFiles(this.sessionsRoot);
    const seen = new Set(paths);
    for (const path of paths) {
      try {
        const metadata = await stat(path);
        const cached = this.cache.get(path);
        if (cached && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) continue;
        const text = await readFile(path, "utf8");
        this.cache.set(path, {
          mtimeMs: metadata.mtimeMs,
          size: metadata.size,
          records: parseSessionText(text, path),
        });
      } catch {
        // Ignore files removed or rotated during a refresh.
      }
    }
    for (const path of this.cache.keys()) {
      if (!seen.has(path)) this.cache.delete(path);
    }
    return [...this.cache.values()].flatMap((file) => file.records);
  }

  async snapshot(filter: UsageFilter): Promise<UsageSnapshot> {
    const now = filter.now ?? Date.now();
    const bounds = getPeriodBounds(filter.period, now, { from: filter.customFrom, to: filter.customTo });
    const allRecords = await this.loadRecords();
    const records = allRecords
      .filter((record) => record.timestamp >= bounds.from && record.timestamp < bounds.to)
      .filter((record) => !filter.model || record.model === filter.model || record.responseModel === filter.model)
      .filter((record) => !filter.router || record.provider === filter.router)
      .sort((a, b) => b.timestamp - a.timestamp);
    const totals = records.reduce((result, record) => {
      addTotals(result, record);
      return result;
    }, emptyTotals());
    return {
      generatedAt: now,
      from: bounds.from,
      to: bounds.to,
      filter: { ...filter, now },
      totals: finalizeTotals(totals),
      records,
      routers: groupRecords(records, (record) => record.provider, (record) => record.provider),
      models: groupRecords(records, (record) => record.model, (record) => record.model),
      buckets: createBuckets(records, bounds.from, bounds.to),
    };
  }

  get sessionsDirectory(): string {
    return this.sessionsRoot;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export function recordDisplayName(record: UsageRecord): string {
  return `${record.provider}/${record.model} · ${basename(record.sessionFile)}`;
}
