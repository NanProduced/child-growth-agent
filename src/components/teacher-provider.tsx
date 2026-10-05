"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authIdentityKey, parseAccountStatus, readAccountStatus, unavailableStatus } from "@/lib/accounts/client";
import type { AuthStatusResponse, Principal } from "@/lib/accounts/types";

interface TeacherState {
  loading: boolean; configured: boolean; isTeacher: boolean; canManageClasses: boolean; canCreateProfiles: boolean;
  principal: Principal | null; auth: AuthStatusResponse;
  login: (username: string, password: string) => Promise<{ ok: boolean; message?: string }>;
  logout: () => Promise<void>; revalidate: () => Promise<void>;
}
const TeacherContext = createContext<TeacherState | null>(null);

/** UI identity projections never authorize writes; the server rechecks the original session. */
export function TeacherProvider({ children, initial }: { children: React.ReactNode; initial: AuthStatusResponse }) {
  const router = useRouter();
  const [auth, setAuth] = useState(initial);
  const [loading, setLoading] = useState(false);
  const current = useRef(initial);
  const generation = useRef(0);
  const operationPending = useRef(false);
  useEffect(() => { generation.current += 1; operationPending.current = false; current.current = initial; setAuth(initial); setLoading(false); }, [initial]);
  const revalidate = useCallback(async () => {
    if (operationPending.current) return;
    const attempt = ++generation.current;
    const next = await readAccountStatus();
    if (attempt !== generation.current) return;
    const changed = authIdentityKey(next) !== authIdentityKey(current.current);
    current.current = next; setAuth(next);
    if (changed) router.refresh();
  }, [router]);
  useEffect(() => {
    const refresh = () => { void revalidate(); };
    window.addEventListener("focus", refresh); window.addEventListener("cga:auth-changed", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("cga:auth-changed", refresh); };
  }, [revalidate]);
  const login = useCallback(async (username: string, password: string) => {
    const attempt = ++generation.current;
    operationPending.current = true;
    setLoading(true);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", "x-cga-auth-request": "1" }, body: JSON.stringify({ username, password }) });
      const body: unknown = await response.json().catch(() => null);
      if (attempt !== generation.current) return { ok: false, message: "账号操作已更新，请重新核对登录状态。" };
      const status = parseAccountStatus(body);
      if (!response.ok || !status || status.state.kind !== "authenticated") {
        const message = body && typeof body === "object" && "message" in body && typeof body.message === "string"
          ? body.message : "登录暂未完成，请稍后重试。";
        if (response.status === 503) { current.current = unavailableStatus; setAuth(unavailableStatus); }
        return { ok: false, message };
      }
      current.current = status; setAuth(status); router.refresh();
      return { ok: true };
    } catch { return { ok: false, message: "网络连接异常，请重试。" }; }
    finally { if (attempt === generation.current) { operationPending.current = false; setLoading(false); } }
  }, [router]);
  const logout = useCallback(async () => {
    const attempt = ++generation.current;
    operationPending.current = true;
    setLoading(true);
    try {
      const status = await readAccountStatus();
      if (attempt !== generation.current) return;
      const headers = new Headers({ "content-type": "application/json" });
      if (status.csrf) headers.set(status.csrf.header_name, status.csrf.token);
      const response = await fetch("/api/auth/logout", { method: "POST", headers, body: "{}", credentials: "same-origin" });
      if (!response.ok) throw new Error("退出未完成，请重试。");
      if (attempt !== generation.current) return;
      const cleared: AuthStatusResponse = { state: { kind: "anonymous" }, session: null, csrf: null };
      current.current = cleared; setAuth(cleared); router.replace("/"); router.refresh();
    } finally { if (attempt === generation.current) { operationPending.current = false; setLoading(false); } }
  }, [router]);
  const principal = auth.state.kind === "authenticated" ? auth.state.principal : null;
  const isTeacher = principal?.role === "teacher";
  const canManageClasses = principal?.role === "admin";
  const canCreateProfiles = canManageClasses || (isTeacher && principal?.scope.kind === "classes" && principal.scope.class_ids.length > 0);
  const changed = authIdentityKey(initial) !== authIdentityKey(auth) &&
    (initial.state.kind === "authenticated" || auth.state.kind === "authenticated");
  return (
    <TeacherContext.Provider value={{ loading, configured: auth.state.kind !== "unavailable", isTeacher,
      canManageClasses, canCreateProfiles, principal, auth, login, logout, revalidate }}>
      {changed ? <div role="status" className="mx-auto max-w-5xl px-5 py-16 text-emerald-800">正在更新账号范围…</div> : children}
    </TeacherContext.Provider>
  );
}
export function useTeacher(): TeacherState {
  const context = useContext(TeacherContext);
  if (!context) throw new Error("useTeacher 必须在 TeacherProvider 内使用");
  return context;
}
