import type { AlertItem, AuditEntry, DashboardPayload, DataMode, GroupDetail } from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "include" });
  if (!response.ok) {
    let code = "request_failed";
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") code = body.error;
    } catch {
      // Keep the bounded fallback code; never surface server bodies directly.
    }
    throw new ApiError(response.status, code);
  }
  return (await response.json()) as T;
}

const jsonHeaders = { "content-type": "application/json" };

export const getSession = () => request<{ authenticated: true }>("/api/auth/session");

export const login = (password: string) =>
  request<{ authenticated: true }>("/api/auth/login", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ password }),
  });

export const logout = () =>
  request<{ authenticated: false }>("/api/auth/logout", {
    method: "POST",
  });

export const getDashboard = (mode: DataMode = "demo") =>
  request<DashboardPayload>(`/api/dashboard?mode=${mode}`);

export const getAlertsSince = (updatedAfter: number) =>
  request<{ alerts: AlertItem[] }>(`/api/alerts?updated_after=${updatedAfter}&limit=100`);

export const getGroup = (groupId: string) =>
  request<GroupDetail>(`/api/groups/${encodeURIComponent(groupId)}`);

export const setGroupCategory = (groupId: string, categoryId: number, locked = true) =>
  request(`/api/groups/${encodeURIComponent(groupId)}/category`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ categoryId, locked }),
  });

export const setGroupStatus = (groupId: string, active: boolean) =>
  request<{ active: boolean }>(`/api/groups/${encodeURIComponent(groupId)}/status`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ active }),
  });

export const deleteRawHistory = (groupId: string) =>
  request<{ deletedMessages: number }>(`/api/groups/${encodeURIComponent(groupId)}/raw-history`, {
    method: "DELETE",
  });

export const setAlertStatus = (alertId: number, status: "open" | "acknowledged" | "resolved") =>
  request(`/api/alerts/${alertId}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ status }),
  });

export const createCategory = (value: { slug: string; name: string; color: string }) =>
  request("/api/categories", { method: "POST", headers: jsonHeaders, body: JSON.stringify(value) });

export const updateCategory = (
  categoryId: number,
  value: { name?: string; color?: string; active?: boolean },
) =>
  request(`/api/categories/${categoryId}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(value),
  });

export const getAuditLog = (entityType: string, entityId: string) =>
  request<{ entries: AuditEntry[] }>(
    `/api/audit-log?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}&limit=50`,
  );
