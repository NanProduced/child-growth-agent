"use client";

/**
 * YAYA-UI1 浏览器验收临时预览页（由 runner 复制到 src/app/yaya-preview/page.tsx，
 * 验收结束后删除；仓库不保留可访问的 mock 路由）。
 *
 * 只使用自建 fixture 身份驱动真实组件；所有 /api/yaya/** 由验收脚本在网络层拦截，
 * 不接真实数据库 / 模型 / 对象存储。
 */
import { useSearchParams } from "next/navigation";

import { TeacherProvider } from "@/components/teacher-provider";
import { YayaPanel } from "@/components/yaya/yaya-panel";
import { YayaSurface } from "@/components/yaya/yaya-provider";
import { YayaWorkspace } from "@/components/yaya/yaya-workspace";
import type { AuthStatusResponse } from "@/lib/accounts/types";

const fixtureAuth: AuthStatusResponse = {
  state: {
    kind: "authenticated",
    principal: {
      account_id: "teacher-1",
      username: "teacher1",
      display_name: "测试教师",
      role: "teacher",
      account_status: "active",
      scope: { kind: "classes", class_ids: ["class-1"] },
    },
  },
  session: {
    session_id: "session-fixture",
    created_at: "2026-10-06T00:00:00.000Z",
    expires_at: "2026-12-31T00:00:00.000Z",
  },
  csrf: { header_name: "x-csrf-token", token: "csrf-fixture" },
};

export default function YayaPreviewPage() {
  const search = useSearchParams();
  const view = search.get("view") === "workspace" ? "workspace" : "panel";
  return (
    <TeacherProvider initial={fixtureAuth}>
      <YayaSurface auth={fixtureAuth} defaultOpen={view === "panel"}>
        {view === "workspace" ? (
          <div className="py-2">
            <YayaWorkspace />
          </div>
        ) : (
          <YayaPanel auth={fixtureAuth} />
        )}
      </YayaSurface>
    </TeacherProvider>
  );
}

