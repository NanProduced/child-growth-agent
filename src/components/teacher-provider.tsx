"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

interface TeacherState {
  loading: boolean;
  /** 服务端是否已配置 TEACHER_PASSCODE */
  configured: boolean;
  /** 当前浏览器是否持有有效教师会话 */
  isTeacher: boolean;
  login: (passcode: string) => Promise<{ ok: boolean; message?: string }>;
  logout: () => Promise<void>;
}

const TeacherContext = createContext<TeacherState | null>(null);

export function TeacherProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [isTeacher, setIsTeacher] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((data: { configured?: boolean; isTeacher?: boolean }) => {
        if (!alive) return;
        setConfigured(Boolean(data.configured));
        setIsTeacher(Boolean(data.isTeacher));
      })
      .catch(() => {
        if (alive) setConfigured(false);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const login = useCallback(async (passcode: string) => {
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (res.ok) {
        setIsTeacher(true);
        setConfigured(true);
        return { ok: true };
      }
      return { ok: false, message: data.message ?? "登录失败，请稍后再试" };
    } catch {
      return { ok: false, message: "网络异常，请稍后再试" };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      setIsTeacher(false);
    }
  }, []);

  return (
    <TeacherContext.Provider value={{ loading, configured, isTeacher, login, logout }}>
      {children}
    </TeacherContext.Provider>
  );
}

export function useTeacher(): TeacherState {
  const ctx = useContext(TeacherContext);
  if (!ctx) throw new Error("useTeacher 必须在 TeacherProvider 内使用");
  return ctx;
}
