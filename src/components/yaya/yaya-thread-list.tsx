"use client";

/**
 * 会话历史列表：新建 / 切换 / 删除（删除二次确认，仅删会话与私有草稿）。
 */
import { useState } from "react";
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { MessageSquarePlus, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

function formatWhen(value: Date): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(value);
  } catch {
    return "";
  }
}

function YayaThreadListItem() {
  const lastMessageAt = useAuiState((state) => state.threadListItem.lastMessageAt);
  const isMain = useAuiState((state) => state.threads.mainThreadId === state.threadListItem.id);
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <ThreadListItemPrimitive.Root className="flex items-center gap-1 rounded-lg px-1">
      <ThreadListItemPrimitive.Trigger className="flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center rounded-lg px-2 py-1 text-left hover:bg-accent aria-[current=true]:bg-accent">
        <span className="w-full truncate text-sm text-foreground">
          <ThreadListItemPrimitive.Title fallback="未命名会话" />
        </span>
        <span className="text-[11px] text-muted-foreground">
          {lastMessageAt !== undefined ? formatWhen(lastMessageAt) : "新会话"}
          {isMain ? " · 当前" : ""}
        </span>
      </ThreadListItemPrimitive.Trigger>
      <ThreadListItemPrimitive.Delete asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 text-muted-foreground"
          aria-label="删除会话"
          onClick={(event) => {
            event.preventDefault();
            setConfirmOpen(true);
          }}
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
      </ThreadListItemPrimitive.Delete>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这个会话？</AlertDialogTitle>
            <AlertDialogDescription>
              只删除会话与其中的私有草稿；已确认的正式观察、已归档关联与仍被引用的图片会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const trigger = document.activeElement;
                if (trigger instanceof HTMLElement) trigger.blur();
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ThreadListItemPrimitive.Root>
  );
}

export function YayaThreadList({ className }: { className?: string }) {
  return (
    <ThreadListPrimitive.Root className={className}>
      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="text-sm font-medium text-foreground">历史会话</h2>
        <ThreadListPrimitive.New asChild>
          <Button type="button" variant="outline" size="sm" className="h-11" data-yaya-new-thread>
            <MessageSquarePlus className="size-3.5" aria-hidden />
            新对话
          </Button>
        </ThreadListPrimitive.New>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <ThreadListPrimitive.Items components={{ ThreadListItem: YayaThreadListItem }} />
      </div>
    </ThreadListPrimitive.Root>
  );
}
