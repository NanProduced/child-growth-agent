import { HeaderUtils } from "coze-coding-dev-sdk";
import { NextRequest, NextResponse } from "next/server";
import { runBusinessWrite, AccountsError, mapAccountsError } from "@/lib/auth";
import { ObservationStateConflictError } from "@/lib/evidence-snapshot";
import { processObservationAgent } from "@/lib/observation-agent";
import { getChild, getObservation } from "@/lib/queries";

/**
 * Agent 判断与 AI 整理（真实模型调用）：需教师身份。
 * - 已确认归档的记录不再允许 AI 改写（保护确认稿与追溯链）；
 * - 信息不足时只保存 agent_context 并进入 needs_input；
 * - 原文 raw_text 永不改动，仅写入 agent_context 或 ai_draft 草稿。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    return await runBusinessWrite(request, "observation.organize", { kind: "observation", observation_id: id }, async () => {
    const observation = await getObservation(id);
    if (!observation) {
      return NextResponse.json({ message: "观察记录不存在" }, { status: 404 });
    }
    if (observation.status === "confirmed") {
      return NextResponse.json(
        { message: "该记录已由教师确认归档，不能再重新进行 AI 整理。" },
        { status: 409 }
      );
    }

    const child = await getChild(observation.child_id);
    if (!child) {
      return NextResponse.json({ message: "关联幼儿档案不存在" }, { status: 400 });
    }

    const updated = await processObservationAgent({
      observation,
      child,
      forwardHeaders: HeaderUtils.extractForwardHeaders(request.headers),
    });
    return NextResponse.json({ observation: updated });
    });
  } catch (e) {
    if (e instanceof AccountsError) return mapAccountsError(e);
    if (e instanceof ObservationStateConflictError) {
      return NextResponse.json({ message: e.message }, { status: 409 });
    }
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "AI 整理失败" },
      { status: 500 }
    );
  }
}
