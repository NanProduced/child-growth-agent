import { HeaderUtils } from "coze-coding-dev-sdk";
import { NextRequest, NextResponse } from "next/server";

import { runBusinessWrite, AccountsError, mapAccountsError } from "@/lib/auth";
import { ObservationStateConflictError } from "@/lib/evidence-snapshot";
import { appendFollowUpAction, processObservationAgent } from "@/lib/observation-agent";
import {
  getChild,
  getObservation,
  updateObservationAgentContext,
} from "@/lib/queries";
import { followUpActionSchema } from "@/lib/validation";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const body = await request.json().catch(() => null);
  const parsed = followUpActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "补充信息请求不合法" },
      { status: 400 },
    );
  }

  const { id } = await params;
  try {
    return await runBusinessWrite(request, "observation.organize", { kind: "observation", observation_id: id }, async () => {
    const observation = await getObservation(id);
    if (!observation) {
      return NextResponse.json({ message: "观察记录不存在" }, { status: 404 });
    }
    if (observation.status !== "needs_input") {
      return NextResponse.json(
        { message: "当前记录不在等待补充信息状态，不能提交追问操作。" },
        { status: 409 },
      );
    }
    if (!observation.agent_context?.follow_up) {
      return NextResponse.json(
        { message: "当前记录缺少有效的补充问题，请重新进入 Agent 判断。" },
        { status: 409 },
      );
    }

    const child = await getChild(observation.child_id);
    if (!child) {
      return NextResponse.json({ message: "关联幼儿档案不存在" }, { status: 400 });
    }

    const context = appendFollowUpAction(
      observation.agent_context,
      parsed.data.action,
      parsed.data.content,
    );
    // 原子保护：状态、上下文与原草稿都必须仍匹配服务端读取时的快照
    const saved = await updateObservationAgentContext(observation.id, context, "needs_input", {
      expectedStatus: "needs_input",
      expectedAgentContext: observation.agent_context ?? null,
      expectedAiDraft: observation.ai_draft ?? null,
    });
    const updated = await processObservationAgent({
      observation: saved,
      child,
      forwardHeaders: HeaderUtils.extractForwardHeaders(request.headers),
    });
    return NextResponse.json({ observation: updated });
    });
  } catch (error) {
    if (error instanceof AccountsError) return mapAccountsError(error);
    if (error instanceof ObservationStateConflictError) {
      return NextResponse.json({ message: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "处理补充信息失败" },
      { status: 500 },
    );
  }
}
