"use client";

import { z } from "zod";
import { CSRF_HEADER_NAME, DATA_SCOPE_NONE_REASONS, INVALID_SESSION_REASONS, type AuthStatusResponse } from "./types";

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("school"), school_id: z.string().min(1) }),
  z.object({ kind: z.literal("classes"), class_ids: z.array(z.string().min(1)) }),
  z.object({ kind: z.literal("none"), reason: z.enum(DATA_SCOPE_NONE_REASONS) }),
]);
const statusSchema = z.object({
  state: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("anonymous") }),
    z.object({ kind: z.literal("invalid_session"), reason: z.enum(INVALID_SESSION_REASONS) }),
    z.object({ kind: z.literal("unavailable"), reason: z.literal("identity_service_unavailable") }),
    z.object({ kind: z.literal("authenticated"), principal: z.object({
      account_id: z.string().min(1), username: z.string().min(1), display_name: z.string().min(1),
      role: z.enum(["teacher", "admin"]), account_status: z.enum(["active", "disabled"]), scope: scopeSchema,
    }) }),
  ]),
  session: z.object({ session_id: z.string().min(1), created_at: z.string(), expires_at: z.string() }).nullable(),
  csrf: z.object({ header_name: z.literal(CSRF_HEADER_NAME), token: z.string().min(1) }).nullable(),
});

export const unavailableStatus: AuthStatusResponse = {
  state: { kind: "unavailable", reason: "identity_service_unavailable" }, session: null, csrf: null,
};

export function parseAccountStatus(value: unknown): AuthStatusResponse | null {
  const parsed = statusSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.state.kind === "authenticated" &&
      (!parsed.data.session || !parsed.data.csrf || parsed.data.state.principal.account_status !== "active")) return null;
  if (parsed.data.state.kind === "authenticated") {
    const { role, scope } = parsed.data.state.principal;
    if ((role === "teacher" && scope.kind === "school") || (role === "admin" && scope.kind !== "school")) return null;
    if (scope.kind === "none" && scope.reason === "account_disabled") return null;
  } else if (parsed.data.session !== null || parsed.data.csrf !== null) return null;
  return parsed.data;
}

export async function readAccountStatus(): Promise<AuthStatusResponse> {
  try {
    const response = await fetch("/api/auth/status", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return unavailableStatus;
    const body: unknown = await response.json();
    return parseAccountStatus(body) ?? unavailableStatus;
  } catch {
    return unavailableStatus;
  }
}

export function authIdentityKey(status: AuthStatusResponse): string {
  if (status.state.kind !== "authenticated") return status.state.kind;
  const principal = status.state.principal;
  const scope = principal.scope.kind === "classes"
    ? { kind: "classes", class_ids: [...principal.scope.class_ids].sort() } : principal.scope;
  return JSON.stringify([status.session?.session_id ?? "", principal.account_id, principal.role, scope]);
}

/** Each write uses the currently resolved session's CSRF; failed writes are never replayed. */
export async function fetchWithAccountAuth(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return fetch(input, { ...init, cache: "no-store", credentials: "same-origin" });
  }
  const status = await readAccountStatus();
  if (status.state.kind !== "authenticated" || !status.csrf) {
    return Response.json({
      error: status.state.kind === "unavailable" ? "identity_unavailable" : "unauthenticated",
      message: status.state.kind === "unavailable" ? "身份服务暂时不可用，请稍后重试。" : "请先登录园所账号。",
    }, { status: status.state.kind === "unavailable" ? 503 : 401 });
  }
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set(CSRF_HEADER_NAME, status.csrf.token);
  const response = await fetch(input, { ...init, headers, credentials: "same-origin" });
  if ([401, 403, 503].includes(response.status)) window.dispatchEvent(new Event("cga:auth-changed"));
  return response;
}
