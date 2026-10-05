import { NextResponse } from "next/server";

import { AccountsError } from "../accounts/errors";
import { mapAccountsError } from "../accounts/guards";
import { MediaError, mediaErrorBody, mediaErrorStatus } from "./errors";

/** 媒体路由统一错误映射：授权错误复用 AUTH 冻结错误体，媒体错误按 code 映射 */
export function mediaRouteError(error: unknown): NextResponse {
  if (error instanceof AccountsError) return mapAccountsError(error);
  if (error instanceof MediaError) {
    return NextResponse.json(mediaErrorBody(error), { status: mediaErrorStatus(error) });
  }
  return NextResponse.json(
    { error: "server_error", message: "服务器暂时无法处理该请求，请稍后重试。" },
    { status: 500 },
  );
}
