"use client";

/**
 * 宽屏批量核对台（工作区专用）：
 * 显示当前会话最近一次待核对提案，与对话共用同一服务端提案 / operation 身份；
 * 只提交选中且完整的项，一项待补充不阻塞其他项。
 */
import { useAuiState, type ThreadMessage } from "@assistant-ui/react";

import { cn } from "@/lib/utils";

import { YAYA_PART_NAMES, type YayaProposalPartData } from "./client/parts";
import { YayaProposalPanel } from "./yaya-proposal";

function latestProposal(
  messages: readonly ThreadMessage[]
): { proposal_id: string; proposal_origin: "teacher_card" | "model_suggestion" } | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message === undefined || message.role !== "assistant") continue;
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex];
      if (part === undefined || part.type !== "data" || part.name !== YAYA_PART_NAMES.proposal) continue;
      const data = part.data as YayaProposalPartData;
      return { proposal_id: data.proposal_id, proposal_origin: data.proposal_origin };
    }
  }
  return null;
}

export function YayaReviewPanel({ className }: { className?: string }) {
  const proposalId = useAuiState((state) => latestProposal(state.thread.messages)?.proposal_id ?? null);
  const origin = useAuiState((state) => latestProposal(state.thread.messages)?.proposal_origin ?? null);
  return (
    <aside
      className={cn("flex w-[420px] shrink-0 flex-col border-l bg-muted/30", className)}
      aria-label="核对记录"
      data-yaya-review-panel
    >
      <header className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">核对记录</h2>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          只提交选中且完整的项；一项待补充不会阻塞其他项与无关问答。
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {proposalId !== null && origin !== null ? (
          <YayaProposalPanel proposalId={proposalId} origin={origin} variant="panel" />
        ) : (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
            当前没有待核对的操作。在左侧对话里说“记一条观察”，核对卡会出现在这里。
          </p>
        )}
      </div>
    </aside>
  );
}
