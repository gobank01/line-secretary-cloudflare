export type DataMode = "demo" | "real";
export type AlertSeverity = "low" | "medium" | "high" | "critical";

export interface CategorySummary {
  id: number;
  slug: string;
  name: string;
  color: string;
  groupCount: number;
  urgentCount: number;
  openActionCount: number;
}

export interface GroupSummary {
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

export interface ActionQueueItem {
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

export interface SystemHealth {
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
  categories: CategorySummary[];
  groups: GroupSummary[];
  actionQueue: ActionQueueItem[];
  health: SystemHealth;
}

export interface AlertItem {
  id: number;
  groupId: string;
  groupTitle: string;
  kind: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "acknowledged" | "resolved";
  excerpt: string;
  createdAt: number;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
}

export interface GroupDetail {
  group: GroupSummary;
  messageCount: number;
  reports: Array<{
    id: number;
    periodStart: number;
    periodEnd: number;
    summary: string;
    actionItems: string[];
    unresolvedQuestions: string[];
    priorityScore: number;
    createdAt: number;
  }>;
  alerts: Array<{
    id: number;
    kind: string;
    severity: string;
    status: string;
    excerpt: string;
    createdAt: number;
    acknowledgedAt: number | null;
    resolvedAt: number | null;
  }>;
}

export interface AuditEntry {
  id: number;
  actor: "owner" | "ai" | "system";
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  createdAt: number;
}
