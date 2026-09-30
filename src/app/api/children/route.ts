import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/auth";
import { createChild, findClassesByName, getClass, listChildren } from "@/lib/queries";
import type { SchoolClass } from "@/lib/types";
import { createChildSchema } from "@/lib/validation";

/** 幼儿档案：读取对访客开放（只读），新增需教师身份（服务端校验） */
export async function GET() {
  try {
    return NextResponse.json({ children: await listChildren() });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "查询幼儿档案失败" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const guard = requireTeacher(request);
  if (guard) return guard;

  const body = await request.json().catch(() => null);
  const parsed = createChildSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "输入不合法" },
      { status: 400 }
    );
  }

  try {
    const target = await resolveClassForChild(parsed.data);
    if ("message" in target) {
      return NextResponse.json({ message: target.message }, { status: target.status });
    }
    const child = await createChild({
      name: parsed.data.name,
      gender: parsed.data.gender,
      birth_date: parsed.data.birth_date,
      class_id: target.class.id,
      avatar_emoji: parsed.data.avatar_emoji,
      note: parsed.data.note,
    });
    return NextResponse.json({ child }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "新增幼儿失败" },
      { status: 500 }
    );
  }
}

/**
 * 新增幼儿的班级来源：
 * - 优先 class_id（权威来源）；
 * - 兼容旧表单的 class_name，但只匹配已存在的班级，不再把自由文本当唯一来源；
 * - 没有可匹配的班级时返回明确错误，不回退到「向日葵班」默认值。
 */
async function resolveClassForChild(input: {
  class_id?: string;
  class_name?: string;
}): Promise<{ class: SchoolClass } | { status: number; message: string }> {
  if (input.class_id) {
    const found = await getClass(input.class_id);
    if (!found) return { status: 404, message: "班级不存在" };
    if (!found.is_active) {
      return { status: 400, message: `班级「${found.name}」已停用，无法新增幼儿` };
    }
    return { class: found };
  }

  const name = input.class_name?.trim();
  if (!name) return { status: 400, message: "请选择班级：提交 class_id 或班级名称" };

  const matches = await findClassesByName(name);
  if (matches.length === 0) {
    return { status: 400, message: `未找到班级「${name}」，请先创建班级后再新增幼儿` };
  }
  if (matches.length > 1) {
    return { status: 400, message: `存在多个同名班级「${name}」，请改用 class_id 指定` };
  }
  const found = matches[0];
  if (!found.is_active) {
    return { status: 400, message: `班级「${found.name}」已停用，无法新增幼儿` };
  }
  return { class: found };
}
