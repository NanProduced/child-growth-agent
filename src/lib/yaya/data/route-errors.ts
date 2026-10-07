/** 芽芽私有路由统一错误映射：AUTH 错误体优先，其余走 DATA1 错误体。 */
import type { NextResponse } from "next/server";
import { AccountsError, mapAccountsError } from "@/lib/auth";
import { mapYayaDataError } from "../storage-types";

export function yayaRouteError(error: unknown): NextResponse {
  if (error instanceof AccountsError) return mapAccountsError(error);
  return mapYayaDataError(error);
}
