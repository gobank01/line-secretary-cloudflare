export interface LineJoinEvent {
  type: "join";
  groupId: string;
  replyToken: string;
  timestamp: number;
}

export interface LineLeaveEvent {
  type: "leave";
  groupId: string;
  timestamp: number;
}

export interface LineTextEvent {
  type: "text";
  groupId: string;
  userId: string | null;
  messageId: string;
  text: string;
  timestamp: number;
}

export type LineGroupEvent = LineJoinEvent | LineLeaveEvent | LineTextEvent;

export class InvalidLinePayloadError extends Error {
  constructor() {
    super("Invalid LINE webhook payload");
    this.name = "InvalidLinePayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLineEvents(payload: unknown): LineGroupEvent[] {
  if (!isRecord(payload) || !Array.isArray(payload.events)) throw new InvalidLinePayloadError();

  const normalized: LineGroupEvent[] = [];
  for (const event of payload.events) {
    if (!isRecord(event) || !isRecord(event.source)) continue;
    if (event.source.type !== "group" || typeof event.source.groupId !== "string") continue;
    if (typeof event.type !== "string" || typeof event.timestamp !== "number") continue;

    const groupId = event.source.groupId;
    if (event.type === "join" && typeof event.replyToken === "string") {
      normalized.push({ type: "join", groupId, replyToken: event.replyToken, timestamp: event.timestamp });
      continue;
    }
    if (event.type === "leave") {
      normalized.push({ type: "leave", groupId, timestamp: event.timestamp });
      continue;
    }
    if (
      event.type === "message" &&
      isRecord(event.message) &&
      event.message.type === "text" &&
      typeof event.message.id === "string" &&
      typeof event.message.text === "string"
    ) {
      normalized.push({
        type: "text",
        groupId,
        userId: typeof event.source.userId === "string" ? event.source.userId : null,
        messageId: event.message.id,
        text: event.message.text,
        timestamp: event.timestamp,
      });
    }
  }

  return normalized;
}
