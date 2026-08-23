export type AlertSeverity = "low" | "medium" | "high" | "critical";

export function alertSeverityRank(value: AlertSeverity | null): number {
  if (value === "critical") return 4;
  if (value === "high") return 3;
  if (value === "medium") return 2;
  if (value === "low") return 1;
  return 0;
}

export function isUrgent(priorityScore: number, severity: AlertSeverity | null): boolean {
  return alertSeverityRank(severity) >= 3 || priorityScore >= 80;
}

export function isWaiting(priorityScore: number, severity: AlertSeverity | null): boolean {
  return !isUrgent(priorityScore, severity) && (severity === "medium" || priorityScore >= 60);
}

export function priorityLevel(priorityScore: number, severity: AlertSeverity | null) {
  if (severity === "critical") return { label: "วิกฤต", tone: "danger" } as const;
  if (isUrgent(priorityScore, severity)) return { label: "เร่งด่วน", tone: "danger" } as const;
  if (isWaiting(priorityScore, severity)) return { label: "รอติดตาม", tone: "warning" } as const;
  if (severity === "low") return { label: "เฝ้าดู", tone: "warning" } as const;
  return { label: "ปกติ", tone: "neutral" } as const;
}

interface ComparablePriority {
  groupId: string;
  priorityScore: number;
  highestOpenAlertSeverity: AlertSeverity | null;
  oldestOpenAlertAt: number | null;
  lastActivityAt: number | null;
}

export function compareActionPriority(left: ComparablePriority, right: ComparablePriority): number {
  return (
    alertSeverityRank(right.highestOpenAlertSeverity) - alertSeverityRank(left.highestOpenAlertSeverity) ||
    (left.oldestOpenAlertAt ?? left.lastActivityAt ?? Number.MAX_SAFE_INTEGER) -
      (right.oldestOpenAlertAt ?? right.lastActivityAt ?? Number.MAX_SAFE_INTEGER) ||
    right.priorityScore - left.priorityScore ||
    left.groupId.localeCompare(right.groupId)
  );
}
