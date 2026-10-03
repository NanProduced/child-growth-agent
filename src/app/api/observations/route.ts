import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/auth";
import {
  CLASS_CONTEXT_REASON_MESSAGES,
  buildEnrollmentSnapshot,
  buildTeacherConfirmedSnapshot,
  getReliableClass,
  resolveClassContextAt,
} from "@/lib/class-context";
import { getChild, listObservations, createObservation } from "@/lib/queries";
import type { ObservationClassContextSnapshot } from "@/lib/guide/types";
import { OBSERVATION_STATUSES, type ObservationStatus } from "@/lib/types";
import { createObservationSchema } from "@/lib/validation";
/**
 * 观察记录：
 * - GET 对访客开放（只读），支持 ?child_id= 与 ?status= 过滤；
 * - POST 需教师身份：保存观察原文（raw_text 保存后不可改写）。
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const childId = params.get("child_id") ?? undefined;
  const requestedStatus = params.get("status") ?? undefined;
  if (
    requestedStatus &&
    !(OBSERVATION_STATUSES as readonly string[]).includes(requestedStatus)
  ) {
    return NextResponse.json({ message: "观察状态筛选条件不合法" }, { status: 400 });
  }
  const status = requestedStatus as ObservationStatus | undefined;
  try {
    const observations = await listObservations({ childId, status: status || undefined });
    return NextResponse.json({ observations });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "查询观察记录失败" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const guard = requireTeacher(request);
  if (guard) return guard;

  const body = await request.json().catch(() => null);
  const parsed = createObservationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "输入不合法" },
      { status: 400 }
    );
  }

  try {
    const child = await getChild(parsed.data.child_id);
    if (!child) {
      return NextResponse.json({ message: "幼儿不存在" }, { status: 404 });
    }

    // 发生时班级：按 observed_at 查分班历史，不直接套用儿童当前班级
    let snapshot: ObservationClassContextSnapshot;
    if (parsed.data.confirmed_class_id) {
      // 教师确认：只接受班级 id；名称/阶段/学年由服务端严格核实，不信任客户端快照。
      // 班级资料无法核实（名称/学段/学年缺失或非法）时拒绝写入，不生成默认小班快照。
      const confirmed = await getReliableClass(parsed.data.confirmed_class_id);
      if (!confirmed) {
        return NextResponse.json(
          {
            error: "class_context_unreliable",
            message:
              "未找到该班级，或班级资料无法核实（班级名称、学段或学年缺失/异常），不能写入发生时班级快照。请先补全班级资料或选择其他班级。",
          },
          { status: 400 }
        );
      }
      snapshot = buildTeacherConfirmedSnapshot(confirmed);
    } else {
      const lookup = await resolveClassContextAt(child.id, parsed.data.observed_at);
      if (lookup.status !== "resolved") {
        return NextResponse.json(
          {
            error: "class_context_confirmation_required",
            reason: lookup.reason,
            message: CLASS_CONTEXT_REASON_MESSAGES[lookup.reason],
            candidates: lookup.candidates,
          },
          { status: 409 }
        );
      }
      snapshot = buildEnrollmentSnapshot(lookup.class, lookup.enrollment_id);
    }

    const observation = await createObservation({
      child_id: parsed.data.child_id,
      class_id: snapshot.class_id,
      observed_at: parsed.data.observed_at,
      context: parsed.data.context?.trim() ? parsed.data.context.trim() : null,
      raw_text: parsed.data.raw_text.trim(),
      is_demo: false,
      class_context_snapshot: snapshot,
    });
    return NextResponse.json({ observation }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "保存观察记录失败" },
      { status: 500 }
    );
  }
}
