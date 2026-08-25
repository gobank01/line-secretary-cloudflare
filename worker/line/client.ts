const LINE_API = "https://api.line.me/v2/bot";

export interface LineResult {
  ok: boolean;
  status: number;
  requestId: string | null;
}

function authorization(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function resultFrom(response: Response): LineResult {
  return {
    ok: response.ok,
    status: response.status,
    requestId: response.headers.get("x-line-request-id"),
  };
}

export async function getGroupSummary(groupId: string, token: string): Promise<{ groupName: string }> {
  const response = await fetch(`${LINE_API}/group/${encodeURIComponent(groupId)}/summary`, {
    headers: authorization(token),
  });
  if (!response.ok) throw new Error(`LINE group summary failed with ${response.status}`);

  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || !("groupName" in payload)) {
    throw new Error("LINE group summary response was invalid");
  }
  const groupName = (payload as { groupName?: unknown }).groupName;
  if (typeof groupName !== "string" || groupName.length === 0) {
    throw new Error("LINE group summary did not include a name");
  }
  return { groupName };
}

export async function pushDigest(
  ownerUserId: string,
  text: string,
  retryKey: string,
  token: string,
): Promise<LineResult> {
  const response = await fetch(`${LINE_API}/message/push`, {
    method: "POST",
    headers: { ...authorization(token), "x-line-retry-key": retryKey },
    body: JSON.stringify({ to: ownerUserId, messages: [{ type: "text", text }] }),
  });
  return resultFrom(response);
}
