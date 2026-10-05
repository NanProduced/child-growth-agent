import { NextRequest, NextResponse } from "next/server";
import { runBusinessWrite, AccountsError, mapAccountsError } from "@/lib/auth";
import { createClass, findClassByName } from "@/lib/queries";
import { scopedListClasses } from "@/lib/accounts/scoped-queries";
import { createClassSchema } from "@/lib/validation";

/**
 * 班级：
 * - GET 默认当前任教班级；catalog=true 仅提供基础目录，仍须有业务范围；
 * - POST 仅管理员：新建班级，同学年内不允许重名。
 */
export async function GET(request?: NextRequest) {
  try {
    return NextResponse.json({ classes: await scopedListClasses({ catalog: request?.nextUrl.searchParams.get("catalog") === "true" }, request) });
  } catch (e) {
    if (e instanceof AccountsError) return mapAccountsError(e);
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "查询班级失败" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = createClassSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "输入不合法" },
      { status: 400 }
    );
  }

  try {
    return await runBusinessWrite(request, "class.manage", { kind: "class" }, async () => {
    const existing = await findClassByName(parsed.data.name, parsed.data.school_year);
    if (existing) {
      return NextResponse.json(
        { message: `同学年下已存在同名班级「${parsed.data.name}」` },
        { status: 409 }
      );
    }
    const created = await createClass(parsed.data);
    return NextResponse.json({ class: created }, { status: 201 });
    });
  } catch (e) {
    if (e instanceof AccountsError) return mapAccountsError(e);
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "创建班级失败" },
      { status: 500 }
    );
  }
}
