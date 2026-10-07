"use client";

/**
 * 芽芽面板：桌面非模态右侧栏 / 手机全屏会话页。
 *
 * - 桌面：覆盖在页面之上，不推挤布局、不设焦点陷阱，Escape 关闭并把焦点交还入口；
 * - 手机：页面级全屏，100dvh + 安全区；返回/关闭等效；
 * - 关闭不销毁运行时（会话、草稿、进行中的原操作标记都保留）；
 * - 未认证/身份不可用时不挂运行时，只显示权限卡。
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, History, MessageSquarePlus, PanelRightOpen, ShieldAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { AuthStatusResponse } from "@/lib/accounts/types";
import { cn } from "@/lib/utils";

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
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" data-yaya-auth-gate>
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

interface PanelBodyProps {
  auth: AuthStatusResponse;
  view: "thread" | "list";
  onViewChange: (view: "thread" | "list") => void;
  onClose: () => void;
}

function PanelBody({ auth, view, onViewChange, onClose }: PanelBodyProps) {
  const threadAvailability = useYayaThreadAvailability();
  return (
    <>
      <header className="flex items-center gap-1 border-b px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] lg:pt-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 lg:hidden"
          aria-label="返回"
          onClick={onClose}
        >
          <ArrowLeft className="size-5" aria-hidden />
        </Button>
        <YayaAvatar mood="idle" size={28} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">芽芽</p>
          <p className="truncate text-[11px] text-muted-foreground">幼教工作助手</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={view === "list" ? "返回会话" : "查看历史会话"}
          aria-pressed={view === "list"}
          onClick={() => onViewChange(view === "list" ? "thread" : "list")}
        >
          <History className="size-5" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label="新对话"
          onClick={() => {
            onViewChange("thread");
            document.querySelector<HTMLButtonElement>("[data-yaya-new-thread]")?.click();
          }}
        >
          <MessageSquarePlus className="size-5" aria-hidden />
        </Button>
        <Button asChild variant="ghost" size="icon" className="hidden size-11 lg:inline-flex">
          <Link href="/assistant" aria-label="在工作区打开">
            <PanelRightOpen className="size-5" aria-hidden />
          </Link>
        </Button>
        <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="关闭芽芽" onClick={onClose}>
          <X className="size-5" aria-hidden />
        </Button>
      </header>

      {view === "list" ? (
        <YayaThreadList className="flex min-h-0 flex-1 flex-col" />
      ) : threadAvailability === "ready" ? (
        <>
          <YayaThread />
          <YayaComposer />
          <YayaThreadList className="hidden" />
        </>
      ) : threadAvailability === "unavailable" ? (
        <YayaThreadUnavailable />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          正在读取会话…
        </div>
      )}
    </>
  );
}

export function YayaPanel({ auth }: { auth: AuthStatusResponse }) {
  const { open, setOpen } = useYayaSurface();
  const runtimeReady = useYayaRuntimeReady();
  const [view, setView] = useState<"thread" | "list">("thread");
  const panelRef = useRef<HTMLElement | null>(null);

  const close = () => {
    setOpen(false);
    if (typeof document !== "undefined") {
      document.getElementById("yaya-entry-button")?.focus();
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('[role="dialog"], [data-radix-popper-content-wrapper]')) {
        return;
      }
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, setOpen]);

  useEffect(() => {
    if (!open) return;
    if (typeof window === "undefined") return;
    if (!window.matchMedia("(max-width: 1023px)").matches) return;
    const input = panelRef.current?.querySelector<HTMLElement>("[data-yaya-composer-input]");
    input?.focus();
  }, [open]);

  return (
    <div
      className={cn("fixed inset-0 z-50 lg:z-40", open ? "pointer-events-auto" : "pointer-events-none")}
      aria-hidden={!open}
    >
      <aside
        ref={panelRef}
        role="complementary"
        aria-label="芽芽助手"
        inert={!open ? true : undefined}
        data-yaya-panel
        data-state={open ? "open" : "closed"}
        className={cn(
          "absolute inset-0 flex flex-col bg-background transition-transform duration-200 motion-reduce:transition-none",
          "lg:inset-y-0 lg:left-auto lg:right-0 lg:h-dvh lg:w-[clamp(360px,30vw,460px)] lg:border-l lg:shadow-xl",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        {runtimeReady ? (
          <PanelBody auth={auth} view={view} onViewChange={setView} onClose={close} />
        ) : (
          <AuthGateCard auth={auth} />
        )}
      </aside>
    </div>
  );
}

