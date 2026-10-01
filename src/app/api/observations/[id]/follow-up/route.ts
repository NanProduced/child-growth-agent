import { HeaderUtils } from "coze-coding-dev-sdk";
import { NextRequest, NextResponse } from "next/server";

import { requireTeacher } from "@/lib/auth";
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
  const guard = requireTeacher(request);
  if (guard) return guard;

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
    // 原子保护：只有仍处于 needs_input 时才允许写入重试回答，已结束/已确认不得被恢复为待追问
    const saved = await updateObservationAgentContext(
      observation.id,
      context,
      "needs_input",
      "needs_input",
    );
    const updated = await processObservationAgent({
      observation: saved,
      child,
      forwardHeaders: HeaderUtils.extractForwardHeaders(request.headers),
    });
    return NextResponse.json({ observation: updated });
  } catch (error) {
    if (error instanceof ObservationStateConflictError) {
      return NextResponse.json({ message: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "处理补充信息失败" },
      { status: 500 },
    );
  }
}
