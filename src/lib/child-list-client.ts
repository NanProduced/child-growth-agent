import type { Child } from "./types";

/**
 * 录入页幼儿列表加载（G6-WRITE1，客户端安全）。
 *
 * 只把明确成功且形状可核实的响应当作幼儿列表：
 * - 401/403/503 与非法 JSON、非法形状都必须抛出可展示的错误，不得转换成“暂无幼儿”；
 * - fetch 注入仅供测试使用；网络失败原样抛给调用方（由页面进入可重试错误态）。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 幼儿列表项的最小可信形状：id/name 必须是非空字符串 */
export function isReliableChildShape(value: unknown): value is Child {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0
  );
}

export async function loadChildren(
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Child[]> {
  const res = await fetchImpl("/api/children", { signal });
  let payload: unknown = null;
  try {
    payload = JSON.parse(await res.text());
  } catch {
    if (res.ok) throw new Error("幼儿列表返回了无法解析的数据，请重试。");
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error("需要教师身份：请先登录后再录入观察。");
    if (res.status === 403) throw new Error("当前账号没有录入观察的权限。");
    if (res.status === 503) throw new Error("教师身份未配置或身份服务暂时不可用，请稍后重试。");
    throw new Error(`幼儿列表加载失败（${res.status}），请重试。`);
  }
  const data = isRecord(payload) ? payload : null;
  if (!data || !Array.isArray(data.children) || !data.children.every(isReliableChildShape)) {
    throw new Error("幼儿列表返回了无法识别的数据，请重试。");
  }
  return data.children;
}
