"use client";

/**
 * 芽芽独立工作区：左侧会话历史，中间消息流，宽屏右侧批量核对台。
 * 与侧栏共用同一运行时 / 同一会话 / 同一账号私有历史（不复制、不另存）。
 */
import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTeacher } from "@/components/teacher-provider";

import { useYayaRuntimeReady, useYayaThreadAvailability } from "./yaya-provider";
import { YayaComposer } from "./yaya-composer";
import { YayaReviewPanel } from "./yaya-review-panel";
import { YayaThread, YayaThreadUnavailable } from "./yaya-thread";
import { YayaThreadList } from "./yaya-thread-list";

function WorkspaceGate() {
  const { auth } = useTeacher();
  const title =
    auth.state.kind === "anonymous"
      ? "请先登录园所账号"
      : auth.state.kind === "invalid_session"
        ? "登录状态已失效"
        : "身份服务暂时不可用";
  return (
    <div className="flex h-[60dvh] flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-base font-medium text-foreground">{title}</p>
      <p className="text-sm leading-[1.65] text-muted-foreground">登录后才能使用芽芽；未登录不开放模型。</p>
      <Button asChild size="sm" className="mt-2 h-11 rounded-xl">
        <Link href="/login">去登录</Link>
      </Button>
    </div>
  );
}

export function YayaWorkspace() {
  const runtimeReady = useYayaRuntimeReady();
  if (!runtimeReady) return <WorkspaceGate />;
  return <YayaWorkspaceBody />;
}

function YayaWorkspaceBody() {
  const threadAvailability = useYayaThreadAvailability();
  const [view, setView] = useState<"thread" | "list">("thread");
  return (
    <div data-platform-chat className="mx-auto flex h-[calc(100dvh-11rem)] min-h-0 w-full max-w-[1536px] overflow-hidden rounded-2xl border border-border bg-background font-sans text-foreground xl:h-[calc(100dvh-8.5rem)]">
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-muted/30 lg:flex">
        <YayaThreadList className="flex min-h-0 flex-1 flex-col" />
      </aside>
      <section aria-label="当前会话" className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b bg-card px-4 py-3">
          <Button asChild variant="ghost" size="icon" className="size-11 rounded-xl lg:hidden">
            <Link href="/" aria-label="返回应用">
              <ArrowLeft className="size-5" aria-hidden />
            </Link>
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="min-w-0 text-2xl font-semibold leading-8 text-foreground [overflow-wrap:anywhere]">芽芽工作区</h1>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">同一会话、同一账号私有历史</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 rounded-xl shadow-none lg:hidden"
            onClick={() => setView(view === "list" ? "thread" : "list")}
            aria-pressed={view === "list"}
          >
            {view === "list" ? "返回会话" : "历史会话"}
          </Button>
        </header>
        {view === "list" ? (
          <YayaThreadList className="flex min-h-0 flex-1 flex-col lg:hidden" />
        ) : threadAvailability === "ready" ? (
          <>
            <YayaThread className="yaya-workspace-thread" />
            <YayaComposer />
          </>
        ) : threadAvailability === "unavailable" ? (
          <YayaThreadUnavailable />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            正在读取会话…
          </div>
        )}
      </section>
      <YayaReviewPanel className="hidden xl:flex" />
    </div>
  );
}
