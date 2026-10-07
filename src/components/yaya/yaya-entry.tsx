"use client";

/**
 * 芽芽入口：桌面右下浮动按钮 / 手机右下浮动按钮（不遮主行动）。
 * 旁路状态用文字 + aria-live 表达，不依赖颜色；/assistant 工作区不显示入口。
 */
import { useCallback, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { useAuiState } from "@assistant-ui/react";

import { cn } from "@/lib/utils";
import type { AuthStatusResponse } from "@/lib/accounts/types";

import { YayaAvatar, YAYA_MOOD_TEXT } from "./yaya-avatar";
import { useYayaRuntimeReady, useYayaStore, useYayaSurface } from "./yaya-provider";

function EntryButton({
  statusText,
  mood,
  label,
}: {
  statusText: string;
  mood: "idle" | "thinking" | "unknown";
  label: string;
}) {
  const { open, setOpen } = useYayaSurface();
  return (
    <div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-50 md:bottom-6 md:right-6">
      <button
        id="yaya-entry-button"
        type="button"
        data-yaya-entry
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`打开芽芽助手。${statusText}`}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex min-h-11 items-center gap-2 rounded-full border bg-background pl-1.5 pr-3.5 shadow-lg",
          "hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        )}
      >
        <YayaAvatar mood={mood} size={32} />
        <span className="flex flex-col items-start leading-tight">
          <span className="text-sm font-medium text-foreground">{label}</span>
          <span role="status" aria-live="polite" className="text-[11px] text-muted-foreground">
            {statusText}
          </span>
        </span>
      </button>
    </div>
  );
}

const getServerNotice = () => null;

function EntryWithRuntime() {
  const store = useYayaStore();
  const remoteId = useAuiState((state) => state.threadListItem.remoteId);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(
    () => (remoteId === undefined ? null : store.notice(remoteId)),
    [store, remoteId]
  );
  const notice = useSyncExternalStore(subscribe, getSnapshot, getServerNotice);
  const mood = notice?.running === true ? "thinking" : notice?.problem === true ? "unknown" : "idle";
  const statusText =
    notice?.running === true
      ? YAYA_MOOD_TEXT.thinking
      : notice?.problem === true
        ? "上次请求未完成，可重新读取核对"
        : YAYA_MOOD_TEXT.idle;
  return <EntryButton statusText={statusText} mood={mood} label="芽芽" />;
}

export function YayaEntry({ auth }: { auth: AuthStatusResponse }) {
  const pathname = usePathname();
  const runtimeReady = useYayaRuntimeReady();
  if (pathname !== null && pathname.startsWith("/assistant")) return null;
  if (runtimeReady) return <EntryWithRuntime />;
  const anonymous = auth.state.kind !== "authenticated";
  return (
    <EntryButton
      statusText={anonymous ? "登录后使用" : "身份服务暂时不可用"}
      mood="idle"
      label="芽芽"
    />
  );
}
