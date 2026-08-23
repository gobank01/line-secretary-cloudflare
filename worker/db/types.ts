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
