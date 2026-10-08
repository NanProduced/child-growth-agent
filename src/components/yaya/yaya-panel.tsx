"use client";

/**
 * 桌面占据应用壳的预留列；手机由 Radix 管理模态焦点和滚动。
 * Activity 在关闭时保留私有草稿及组件状态，并释放模态副作用；runtime 始终留在 Provider。
 */
import { Activity, useEffect, useRef, useState } from "react";
import Link from "next/link";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ThreadListPrimitive } from "@assistant-ui/react";
import { History, MessageSquarePlus, PanelRightOpen, ShieldAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTeacher } from "@/components/teacher-provider";
import type { AuthStatusResponse } from "@/lib/accounts/types";

import { YayaAvatar } from "./yaya-avatar";
import { YayaComposer } from "./yaya-composer";
import { useYayaRuntimeReady, useYayaSurface, useYayaThreadAvailability } from "./yaya-provider";
import { YayaThread, YayaThreadUnavailable } from "./yaya-thread";
import { YayaThreadList } from "./yaya-thread-list";

function AuthGateCard({ auth }: { auth: AuthStatusResponse }) {
  const state = auth.state;
  const content =
    state.kind === "anonymous"
      ? { title: "请先登录园所账号", body: "登录后才能使用芽芽；未登录不开放模型。" }
      : state.kind === "invalid_session"
        ? { title: "登录状态已失效", body: "请重新登录园所账号后继续。" }
        : { title: "身份服务暂时不可用", body: "请稍后重试；在身份服务恢复前不会调用模型。" };
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 text-center" data-yaya-auth-gate>
      <ShieldAlert className="size-8 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium text-foreground">{content.title}</p>
      <p className="text-xs leading-5 text-muted-foreground">{content.body}</p>
      {state.kind !== "unavailable" ? (
        <Button asChild size="sm" className="h-11">
          <Link href="/login">去登录</Link>
        </Button>
      ) : null}
    </div>
  );
}

interface PanelViewProps {
  view: "thread" | "list";
  onViewChange: (view: "thread" | "list") => void;
}

function PanelHeader({ view, onViewChange }: PanelViewProps) {
  const runtimeReady = useYayaRuntimeReady();
  const { setOpen } = useYayaSurface();
  const historyLabel = view === "list" ? "返回会话" : "查看历史会话";
  const newConversation = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-11 shrink-0"
      aria-label="新对话"
      title="新对话"
      disabled={!runtimeReady}
      onClick={() => onViewChange("thread")}
    >
      <MessageSquarePlus className="size-5" aria-hidden />
    </Button>
  );

  return (
    <header className="flex shrink-0 items-center gap-2 border-b px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] lg:pt-3">
      <YayaAvatar mood="idle" size={32} />
      <div className="min-w-0 flex-1">
        <DialogPrimitive.Title className="truncate text-base font-semibold text-foreground">芽芽</DialogPrimitive.Title>
        <DialogPrimitive.Description className="truncate text-xs leading-5 text-muted-foreground">
          幼教工作助手
        </DialogPrimitive.Description>
      </div>
      <div className="flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          aria-label={historyLabel}
          title={historyLabel}
          aria-pressed={view === "list"}
          disabled={!runtimeReady}
          onClick={() => onViewChange(view === "list" ? "thread" : "list")}
        >
          <History className="size-5" aria-hidden />
        </Button>
        {runtimeReady ? <ThreadListPrimitive.New asChild>{newConversation}</ThreadListPrimitive.New> : newConversation}
        <Button asChild variant="ghost" size="icon" className="size-11 shrink-0">
          <Link href="/assistant" aria-label="在工作区打开" title="在工作区打开" onClick={() => setOpen(false)}>
            <PanelRightOpen className="size-5" aria-hidden />
          </Link>
        </Button>
        <DialogPrimitive.Close asChild>
          <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" aria-label="关闭芽芽" title="关闭芽芽" data-yaya-close>
            <X className="size-5" aria-hidden />
          </Button>
        </DialogPrimitive.Close>
      </div>
    </header>
  );
}

function PanelBody({ view }: Pick<PanelViewProps, "view">) {
  const threadAvailability = useYayaThreadAvailability();
  return (
    <>
      <Activity mode={view === "list" ? "visible" : "hidden"}>
        <YayaThreadList className="flex min-h-0 flex-1 flex-col" />
      </Activity>
      <Activity mode={view === "thread" ? "visible" : "hidden"}>
        {threadAvailability === "ready" ? (
          <>
            <YayaThread />
            <YayaComposer />
          </>
        ) : threadAvailability === "unavailable" ? (
          <YayaThreadUnavailable />
        ) : (
          <div role="status" className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            正在读取会话…
          </div>
        )}
      </Activity>
    </>
  );
}

export function YayaPanel({ auth }: { auth: AuthStatusResponse }) {
  auth = useTeacher().auth;
  const { open, setOpen, isMobile } = useYayaSurface();
  const runtimeReady = useYayaRuntimeReady();
  const [view, setView] = useState<"thread" | "list">("thread");
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const panel = panelRef.current;
    const viewport = window.visualViewport;
    if (!open || !isMobile || panel === null || viewport === null) return;
    const update = () => {
      panel.style.height = `${viewport.height}px`;
      panel.style.top = `${viewport.offsetTop}px`;
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      panel.style.removeProperty("height");
      panel.style.removeProperty("top");
    };
  }, [open, isMobile]);

  return (
    <Activity mode={open ? "visible" : "hidden"}>
      <DialogPrimitive.Root open={open} onOpenChange={setOpen} modal={isMobile}>
        <DialogPrimitive.Overlay forceMount className="fixed inset-0 z-40 bg-background lg:hidden" />
        <DialogPrimitive.Content
          forceMount
          ref={panelRef}
          role={isMobile ? "dialog" : "complementary"}
          aria-modal={isMobile ? true : undefined}
          aria-label="芽芽助手"
          data-yaya-panel
          data-platform-chat
          onInteractOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            panelRef.current?.querySelector<HTMLButtonElement>("[data-yaya-close]")?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById("yaya-entry-button")?.focus({ preventScroll: true });
          }}
          className="fixed inset-x-0 top-0 z-50 flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-background font-sans outline-none [padding-left:env(safe-area-inset-left)] [padding-right:env(safe-area-inset-right)] lg:sticky lg:inset-x-auto lg:top-0 lg:z-40 lg:col-start-2 lg:row-start-1 lg:w-full lg:border-l [&_.overflow-y-auto]:overscroll-contain [&_textarea]:overscroll-contain"
        >
          <PanelHeader view={view} onViewChange={setView} />
          {runtimeReady ? <PanelBody view={view} /> : <AuthGateCard auth={auth} />}
        </DialogPrimitive.Content>
      </DialogPrimitive.Root>
    </Activity>
  );
}

