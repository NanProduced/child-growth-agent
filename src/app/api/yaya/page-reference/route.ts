import { NextRequest, NextResponse } from "next/server";
import { mapAccountsError } from "@/lib/accounts/guards";
import { readPageReference } from "@/lib/yaya/page-reference-service";

export async function GET(request: NextRequest) {
  try {
    const reference = await readPageReference(request, request.nextUrl.searchParams.get("path") ?? "");
    return NextResponse.json({ reference }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return mapAccountsError(error);
  }
}
