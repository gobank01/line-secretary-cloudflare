export type DataMode = "real" | "demo";

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
  category: { id: number; slug: string; name: string; color: string } | null;
  latestSummary: string | null;
  actionItems: string[];
  unresolvedQuestions: string[];
  openAlerts: number;
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
  lastActivityAt: number | null;
}

export interface DashboardHealthDto {
  backlogGroups: number;
  aiCallsToday: number;
  aiInputTokensToday: number;
  linePushesMonth: number;
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
