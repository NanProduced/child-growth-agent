"use client";

/**
 * 会话消息区：可滚动视口 + 空态 + 消息渲染。
 * 状态旁路（响应中/异常）经 store 通知入口按钮的 aria-live 文案。
 * 会话列表未就绪时不渲染线程原语，只显示读取说明（不冒充空数据）。
 */
import { useEffect } from "react";
import { AuiIf, ThreadPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { YayaAvatar } from "./yaya-avatar";
import { YayaMessage } from "./yaya-message";
import { useYayaStore, useYayaThreadAvailability } from "./yaya-provider";
import { YAYA_PART_NAMES } from "./client/parts";

function YayaEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <YayaAvatar mood="idle" size={56} />
      <p className="text-sm font-medium text-foreground">我是芽芽，你的幼教工作助手</p>
      <p className="text-xs leading-5 text-muted-foreground">
        可以问幼教问题，也可以说“记一条小满的观察”。
        <br />
        AI 整理结果只是草稿，核对后才进入正式记录。
      </p>
    </div>
  );
}

export function YayaThreadUnavailable() {
  const aui = useAui();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center" data-yaya-thread-unavailable>
      <p className="text-sm font-medium text-foreground">会话读取暂未完成</p>
      <p className="text-xs leading-5 text-muted-foreground">
        这不代表没有数据，也不会显示成空会话；可稍后重新读取。
      </p>
      <Button type="button" variant="outline" size="sm" className="h-11" onClick={() => aui.threads.reload()}>
        <RefreshCw className="size-3.5" aria-hidden />
        重新读取
      </Button>
    </div>
  );
}

export function YayaThread({ className }: { className?: string }) {
  const store = useYayaStore();
  const availability = useYayaThreadAvailability();
  const isRunning = useAuiState((state) => {
    try {
      return state.thread.isRunning;
    } catch {
      return false;
    }
  });
  const remoteId = useAuiState((state) => {
    try {
      return state.threadListItem.remoteId;
    } catch {
      return undefined;
    }
  });
  const hasProblem = useAuiState((state) => {
    try {
      return state.thread.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some((part) => part.type === "data" && part.name === YAYA_PART_NAMES.runError)
      );
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (remoteId === undefined) return;
    store.updateNotice(remoteId, { running: isRunning, problem: hasProblem });
  }, [store, remoteId, isRunning, hasProblem]);

  if (availability !== "ready") return <YayaThreadUnavailable />;

  return (
    <ThreadPrimitive.Root className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <ThreadPrimitive.Viewport
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3 [overflow-anchor:none]"
        data-yaya-thread
        turnAnchor="bottom"
      >
        <AuiIf condition={(state) => state.thread.isEmpty}>
          <YayaEmpty />
        </AuiIf>
        <ThreadPrimitive.Messages>{() => <YayaMessage />}</ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

