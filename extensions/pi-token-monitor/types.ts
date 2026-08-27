export type TokenMonitorView = "overview" | "table" | "graphs" | "details";

export type PeriodPreset =
  | "last15m"
  | "last30m"
  | "last1h"
  | "last3h"
  | "last24h"
  | "last48h"
  | "last7d"
  | "last30d"
  | "last365d"
  | "today"
  | "yesterday"
  | "thisWeek"
  | "lastWeek"
  | "thisMonth"
  | "lastMonth"
  | "thisYear"
  | "lastYear";

export interface UsageFilter {
  period: PeriodPreset;
  model?: string;
  router?: string;
  now?: number;
}

export interface UsageRecord {
  id: string;
  sessionId: string;
  sessionFile: string;
  timestamp: number;
  provider: string;
  model: string;
  responseModel?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
}

export interface UsageTotals {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  freshTokens: number;
  cost: number;
  cacheHit: number | null;
}

export interface UsageGroup {
  key: string;
  label: string;
  totals: UsageTotals;
}

export interface UsageBucket {
  start: number;
  label: string;
  totals: UsageTotals;
}

export interface UsageSnapshot {
  generatedAt: number;
  from: number;
  to: number;
  filter: UsageFilter;
  totals: UsageTotals;
  records: UsageRecord[];
  routers: UsageGroup[];
  models: UsageGroup[];
  buckets: UsageBucket[];
}
