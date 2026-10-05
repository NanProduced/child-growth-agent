import { NextRequest, NextResponse } from "next/server";
import { withBusinessRead, AccountsError, mapAccountsError } from "@/lib/auth";
import {
  CLASS_CONTEXT_REASON_MESSAGES,
  resolveClassContextAt,
} from "@/lib/class-context";
import { parseIsoDateStrict } from "@/lib/format";
import { getChild } from "@/lib/queries";

/**
 * 只读：按 observed_at 解析幼儿当时的班级归属（分班历史唯一命中）。
 * 无归属/重叠/历史异常时返回 status=needs_confirmation，由教师确认后
 * 在 POST /api/observations 携带 confirmed_class_id 提交；本接口不写库。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const observedAt = request.nextUrl.searchParams.get("observed_at") ?? "";
  if (!parseIsoDateStrict(observedAt)) {
    return NextResponse.json(
      { message: "观察日期格式应为 YYYY-MM-DD，且必须是真实存在的日历日期" },
      { status: 400 }
    );
  }

  try {
    return await withBusinessRead(request, "child.read", { kind: "child", child_id: id }, async () => {
    const child = await getChild(id);
    if (!child) {
      return NextResponse.json({ message: "幼儿不存在" }, { status: 404 });
    }
    const lookup = await resolveClassContextAt(child.id, observedAt);
    if (lookup.status === "resolved") {
      return NextResponse.json({
        child_id: child.id,
        observed_at: observedAt,
        status: "resolved",
        reason: null,
        class: lookup.class,
        enrollment_id: lookup.enrollment_id,
        candidates: [],
      });
    }
    return NextResponse.json({
      child_id: child.id,
      observed_at: observedAt,
      status: "needs_confirmation",
      reason: lookup.reason,
      class: null,
      enrollment_id: null,
      candidates: lookup.candidates,
      message: CLASS_CONTEXT_REASON_MESSAGES[lookup.reason],
    });
    });
  } catch (e) {
    if (e instanceof AccountsError) return mapAccountsError(e);
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "查询发生时班级失败" },
      { status: 500 }
    );
  }
}
