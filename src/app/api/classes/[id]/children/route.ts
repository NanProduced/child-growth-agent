import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/auth";
import {
  enrollChildInClass,
  getCurrentClassId,
  getClass,
  getChild,
} from "@/lib/queries";
import { enrollChildSchema } from "@/lib/validation";

/**
 * 分班 / 转班（需教师身份）：
 * - 重新分班会自动结束旧归属并新建归属，旧关系保留为历史；
 * - 班级停用（is_active = false）后不再接受分班。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = requireTeacher(request);
  if (guard) return guard;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = enrollChildSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "输入不合法" },
      { status: 400 }
    );
  }

  try {
    const targetClass = await getClass(id);
    if (!targetClass) {
      return NextResponse.json({ message: "班级不存在" }, { status: 404 });
    }
    if (!targetClass.is_active) {
      return NextResponse.json(
        { message: `班级「${targetClass.name}」已停用，无法分班` },
        { status: 400 }
      );
    }

    const child = await getChild(parsed.data.child_id);
    if (!child) {
      return NextResponse.json({ message: "幼儿不存在" }, { status: 404 });
    }

    const currentClassId = await getCurrentClassId(child.id);
    if (currentClassId === targetClass.id) {
      return NextResponse.json(
        { message: `该幼儿已在「${targetClass.name}」，无需重复分班` },
        { status: 409 }
      );
    }

    await enrollChildInClass({
      child_id: child.id,
      class_id: targetClass.id,
      start_date: parsed.data.start_date,
    });

    return NextResponse.json({
      message: `已将「${child.name}」分入「${targetClass.name}」`,
      class: targetClass,
      child: await getChild(child.id),
    });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "分班失败" },
      { status: 500 }
    );
  }
}
