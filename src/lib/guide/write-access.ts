import { resolveServerAuth } from "@/lib/accounts/access";

import {
  READ_ONLY_ACCESS,
  type GuideWriteAccessView,
} from "./association-types";
import { guideCanCreateObservation, type IdentityFacts } from "./write-access-rules";

/**
 * 指南写入口的服务端身份解析（G6-WRITE1，B0 基线）。
 *
 * - 使用 B0 的 `resolveServerAuth`：每次请求重新解析会话与数据库账号，不缓存 Principal；
 * - 旧口令会话不再构成身份（B0 已退役，登录/写操作全部走园所账号 + 会话 CSRF）；
 * - 身份不可用 fail closed（隐藏写入口），不回退匿名或全园。
 */

export async function resolveIdentityFacts(): Promise<IdentityFacts> {
  const auth = await resolveServerAuth();
  if (auth.state.kind === "unavailable") return { kind: "unavailable" };
  if (auth.state.kind === "authenticated") return { kind: "principal", principal: auth.state.principal };
  return { kind: "none" };
}

/** 录入页身份级可写性；具体幼儿仍以服务端 observation.write 授权为准 */
export async function resolveCreateObservationAccess(): Promise<GuideWriteAccessView> {
  const identity = await resolveIdentityFacts();
  if (identity.kind === "unavailable") {
    return { ...READ_ONLY_ACCESS, read_only_reason: "身份服务暂时不可用，已隐藏写入口；请稍后重试。" };
  }
  if (identity.kind === "none") {
    return { ...READ_ONLY_ACCESS, read_only_reason: "需要教师身份才能录入观察；当前为只读查看。" };
  }
  if (!guideCanCreateObservation(identity)) {
    return {
      ...READ_ONLY_ACCESS,
      read_only_reason:
        identity.principal.role === "admin"
          ? "管理员没有教学操作权限，不能录入观察。"
          : "当前账号还没有任教班级，暂不能录入观察。",
    };
  }
  return {
    can_record: true,
    can_decide: true,
    can_organize: true,
    mode: "account_teacher",
    read_only_reason: null,
  };
}
