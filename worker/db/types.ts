export type DataMode = "real" | "demo";
export type AlertSeverity = "low" | "medium" | "high" | "critical";

export interface NewGroup {
  sourceId: string;
  title: string;
  dataMode: DataMode;
  active: boolean;
  now: number;
}

export interface NewMessage {
  lineMessageId: string;
  groupId: string;
  userId: string | null;
  kind: "text";
  text: string;
  sentAt: number;
  ingestedAt: number;
  retentionExpiresAt: number;
}

export interface GroupRecord {
  sourceId: string;
  title: string;
  active: boolean;
  disclosureSentAt: number | null;
}

export interface RegisteredGroup extends GroupRecord {
  created: boolean;
}

export interface CategorySummaryDto {
  id: number;
  slug: string;
  name: string;
  color: string;
  groupCount: number;
  urgentCount: number;
  openActionCount: number;
}

export interface GroupSummaryDto {
  id: string;
  title: string;
  dataMode: DataMode;
  active: boolean;
  priorityScore: number;
  lastMessageAt: number | null;
  lastSummaryAt: number | null;
  needsCategoryReview: boolean;
  categoryLocked: boolean;
  categoryConfidence: number | null;
  categorySource: "ai" | "manual" | null;
  category: { id: number; slug: string; name: string; color: string } | null;
  latestSummary: string | null;
  actionItems: string[];
  unresolvedQuestions: string[];
  openAlerts: number;
  highestOpenAlertSeverity: AlertSeverity | null;
  oldestOpenAlertAt: number | null;
}

export interface ActionQueueItemDto {
  groupId: string;
  title: string;
  priorityScore: number;
  categoryName: string | null;
  categoryColor: string | null;
  summary: string | null;
  actionItems: string[];
  unresolvedQuestions: string[];
  openAlerts: number;
  highestOpenAlertSeverity: AlertSeverity | null;
  oldestOpenAlertAt: number | null;
  lastActivityAt: number | null;
}

export interface DashboardHealthDto {
  backlogGroups: number;
  aiCallsToday: number;
  aiInputTokensToday: number;
  linePushesMonth: number;
  lastSuccessfulCron: number | null;
  platformMetrics: { source: "cloudflare_analytics"; dashboardUrl: string };
  warnings: string[];
}

export interface DashboardPayload {
  generatedAt: number;
  kpis: { totalGroups: number; urgent: number; waiting: number; active: number; normal: number };
  categories: CategorySummaryDto[];
  groups: GroupSummaryDto[];
  actionQueue: ActionQueueItemDto[];
  health: DashboardHealthDto;
}
