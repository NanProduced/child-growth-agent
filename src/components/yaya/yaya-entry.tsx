"use client";

/**
 * 芽芽入口：桌面右下浮动按钮 / 手机右下浮动按钮（不遮主行动）。
 * 旁路状态用文字 + aria-live 表达，不依赖颜色；/assistant 工作区不显示入口。
 */
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { useAuiState } from "@assistant-ui/react";

import { useTeacher } from "@/components/teacher-provider";
import { cn } from "@/lib/utils";
import type { AuthStatusResponse } from "@/lib/accounts/types";

import { YayaAvatar, YAYA_MOOD_TEXT } from "./yaya-avatar";
import { useYayaRuntimeReady, useYayaSurface } from "./yaya-provider";
import { YAYA_PART_NAMES } from "./client/parts";
const subscribeHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;

function EntryButton({
  statusText,
  mood,
  label,
}: {
  statusText: string;
  mood: "idle" | "thinking" | "unknown";
  label: string;
}) {
  const { open, setOpen, isMobile } = useYayaSurface();
  const hydrated = useSyncExternalStore(subscribeHydration, clientHydrated, serverHydrated);
  return (
    <div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-50 md:bottom-6 md:right-6">
      <button
        id="yaya-entry-button"
        type="button"
        disabled={!hydrated}
        data-yaya-entry
        aria-haspopup={isMobile ? "dialog" : undefined}
        aria-expanded={open}
        aria-label={`打开芽芽助手。${statusText}`}
        title="打开芽芽助手"
        onClick={() => setOpen(true)}
        className={cn(
          "flex min-h-11 items-center gap-2 rounded-full border bg-background pl-1.5 pr-3.5 shadow-lg",
          "hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        )}
      >
        <YayaAvatar mood={mood} size={32} />
        <span className="flex flex-col items-start leading-tight">
          <span className="text-sm font-medium text-foreground">{label}</span>
          <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {statusText}
          </span>
        </span>
      </button>
    </div>
  );
}

function EntryWithRuntime() {
  const mood = useAuiState((state) => {
    try {
      if (state.thread.isRunning) return "thinking";
      return state.thread.messages.some((message) =>
        message.role === "assistant" &&
        message.content.some((part) => part.type === "data" && part.name === YAYA_PART_NAMES.runError)
      ) ? "unknown" : "idle";
    } catch {
      return "idle";
    }
  });
  const statusText =
    mood === "thinking"
      ? YAYA_MOOD_TEXT.thinking
      : mood === "unknown"
        ? "上次请求未完成，可重新读取核对"
        : YAYA_MOOD_TEXT.idle;
  return <EntryButton statusText={statusText} mood={mood} label="芽芽" />;
}

export function YayaEntry({ auth }: { auth: AuthStatusResponse }) {
  auth = useTeacher().auth;
  const pathname = usePathname();
  const runtimeReady = useYayaRuntimeReady();
  const { open } = useYayaSurface();
  if (open || pathname === "/assistant" || pathname?.startsWith("/assistant/") === true) return null;
  if (runtimeReady) return <EntryWithRuntime />;
  const statusText = auth.state.kind === "unavailable"
    ? "身份服务暂时不可用"
    : auth.state.kind === "invalid_session"
      ? "登录状态已失效"
      : auth.state.kind === "authenticated"
        ? "正在准备会话"
        : "登录后使用";
  return (
    <EntryButton
      statusText={statusText}
      mood="idle"
      label="芽芽"
    />
  );
}
