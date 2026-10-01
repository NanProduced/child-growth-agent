import { HeaderUtils } from "coze-coding-dev-sdk";
import { NextRequest, NextResponse } from "next/server";
import { reviewTeacherEdit } from "@/lib/ai";
import { requireTeacher } from "@/lib/auth";
import {
  confirmObservation,
  getObservation,
  getChild,
  listObservations,
  updateObservationAgentContext,
} from "@/lib/queries";
import {
  updateGrowthProfileSafely,
  type ProfileUpdateResult,
} from "@/lib/growth-profile";
import {
  clarificationSnapshot,
  normalizeTeacherEditContent,
  normalizeTeacherNote,
  sameClarificationSnapshot,
  sameTeacherEditContent,
  sameTeacherEditNote,
  teacherEditSubmissionAction,
} from "@/lib/teacher-edit-review";
import type { AgentContext, TeacherEditClarification } from "@/lib/types";
import {
  confirmObservationSchema,
  findDevelopmentForbiddenTerm,
  isQuoteInRawText,
} from "@/lib/validation";

/**
 * 教师确认：未修改 AI 草稿时直接确认；修改 AI 内容时先进行 Agent 修改审核。
 * 只有审核 accept 且提交内容仍与审核快照一致时，才写入 confirmed_content。
 */

function withoutTeacherEditReview(context: AgentContext): AgentContext {
  const next = { ...context };
  delete next.teacher_edit_review;
  return next;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = requireTeacher(request);
  if (guard) return guard;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = confirmObservationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "确认内容不完整" },
      { status: 400 }
    );
  }

  const forbiddenTerm = findDevelopmentForbiddenTerm(parsed.data.content);
  if (forbiddenTerm) {
    return NextResponse.json(
      { message: `确认内容包含不适合写入成长记录的表述「${forbiddenTerm}」，请改为具体行为和语言。` },
      { status: 400 },
    );
  }

  try {
    const observation = await getObservation(id);
    if (!observation) {
      return NextResponse.json({ message: "观察记录不存在" }, { status: 404 });
    }
    if (observation.status === "confirmed") {
      return NextResponse.json(
        { message: "该记录已确认归档，无需重复确认。" },
        { status: 409 }
      );
    }
    if (observation.status !== "ai_organized") {
      return NextResponse.json(
        { message: "请先生成并核对 AI 整理草稿，再进行确认归档。" },
        { status: 409 }
      );
    }

    if (!observation.ai_draft) {
      return NextResponse.json(
        { message: "当前记录缺少 AI 原始草稿，不能进行教师修改审核。" },
        { status: 409 },
      );
    }

    const submittedContent = parsed.data.content;
    if (!isQuoteInRawText(observation.raw_text, submittedContent.highlight_quote)) {
      return NextResponse.json(
        { message: "原文金句必须逐字来自观察原文的连续片段，不能改写或引用教师补充信息。" },
        { status: 400 },
      );
    }

    const normalizedContent = normalizeTeacherEditContent(submittedContent);
    const clarification = parsed.data.clarification?.trim() || undefined;
    const clarifications: TeacherEditClarification[] =
      observation.agent_context?.teacher_edit_clarifications ?? [];
    const currentReview = observation.agent_context?.teacher_edit_review;
    const teacherNote = parsed.data.teacher_note?.trim() || undefined;
    const normalizedNote = normalizeTeacherNote(teacherNote);
    const reviewMatches = Boolean(
      currentReview &&
        sameTeacherEditContent(currentReview.content_snapshot, submittedContent) &&
        sameClarificationSnapshot(currentReview, clarifications) &&
        sameTeacherEditNote(currentReview, normalizedNote),
    );
    const submissionAction = teacherEditSubmissionAction(
      observation.ai_draft,
      normalizedContent,
      currentReview,
      clarifications,
      normalizedNote,
    );

    // 教师回答 clarify 问题：独立保存问答，并带着澄清依据重新审核
    if (clarification) {
      if (!currentReview || currentReview.decision !== "clarify" || !reviewMatches) {
        return NextResponse.json(
          { message: "当前没有等待澄清的修改审核，请先提交修改或重新生成审核。" },
          { status: 409 },
        );
      }
      const nextClarifications: TeacherEditClarification[] = [
        ...clarifications,
        {
          question: currentReview.question,
          answer: clarification,
          created_at: new Date().toISOString(),
        },
      ];
      const reviewContext = withoutTeacherEditReview({
        ...(observation.agent_context ?? {}),
        teacher_edit_clarifications: nextClarifications,
      });
      const { review } = await reviewTeacherEdit({
        rawText: observation.raw_text,
        originalDraft: observation.ai_draft,
        content: normalizedContent,
        teacherNote,
        agentContext: reviewContext,
        clarifications: nextClarifications,
        forwardHeaders: HeaderUtils.extractForwardHeaders(request.headers),
      });
      const updated = await updateObservationAgentContext(
        observation.id,
        {
          ...reviewContext,
          teacher_edit_review: {
            ...review,
            content_snapshot: normalizedContent,
            clarification_snapshot: clarificationSnapshot(nextClarifications),
            note_snapshot: normalizedNote,
            reviewed_at: new Date().toISOString(),
          },
        },
        "ai_organized",
      );
      return NextResponse.json({
        observation: updated,
        requiresAgentConfirmation: true,
        agentReview: review,
      });
    }

    if (submissionAction === "confirm") {
      if (currentReview && !reviewMatches) {
        await updateObservationAgentContext(
          observation.id,
          withoutTeacherEditReview(observation.agent_context ?? {}),
          "ai_organized",
        );
      }
      const confirmed = await confirmObservation(observation.id, {
        ...submittedContent,
        teacher_note: teacherNote,
      });
      let profileUpdate: ProfileUpdateResult = {
        status: "failed",
        message: "观察已确认，但成长档案暂未更新，请稍后重试。",
      };
      try {
        const child = await getChild(confirmed.child_id);
        if (!child) throw new Error("关联幼儿档案不存在");
        const confirmedObservations = await listObservations({
          childId: confirmed.child_id,
          status: "confirmed",
        });
        profileUpdate = await updateGrowthProfileSafely(child, confirmedObservations, {
          forwardHeaders: HeaderUtils.extractForwardHeaders(request.headers),
        });
      } catch (error) {
        console.error("确认后更新成长档案失败：", error);
      }
      return NextResponse.json({
        observation: confirmed,
        profileUpdateStatus: profileUpdate.status,
        profileUpdateMessage: profileUpdate.message,
        growthProfile: profileUpdate.growthProfile,
      });
    }

    if (submissionAction === "clarify" && currentReview) {
      return NextResponse.json({
        observation,
        requiresAgentConfirmation: true,
        agentReview: currentReview,
      });
    }

    const reviewContext = observation.agent_context
      ? withoutTeacherEditReview(observation.agent_context)
      : {};
    if (currentReview) {
      await updateObservationAgentContext(observation.id, reviewContext, "ai_organized");
    }

    const { review } = await reviewTeacherEdit({
      rawText: observation.raw_text,
      originalDraft: observation.ai_draft,
      content: normalizedContent,
      teacherNote,
      agentContext: reviewContext,
      clarifications,
      forwardHeaders: HeaderUtils.extractForwardHeaders(request.headers),
    });
    const reviewedAt = new Date().toISOString();
    const updated = await updateObservationAgentContext(
      observation.id,
      {
        ...reviewContext,
        teacher_edit_review: {
          ...review,
          content_snapshot: normalizedContent,
          clarification_snapshot: clarificationSnapshot(clarifications),
          note_snapshot: normalizedNote,
          reviewed_at: reviewedAt,
        },
      },
      "ai_organized",
    );
    return NextResponse.json({
      observation: updated,
      requiresAgentConfirmation: true,
      agentReview: review,
    });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "确认归档失败" },
      { status: 500 }
    );
  }
}
