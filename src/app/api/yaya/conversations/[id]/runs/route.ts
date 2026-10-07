/**
 * 芽芽运行接口：POST 发起（NDJSON 事件流）/ GET 原运行查询（五态只读）。
 *
 * 发起：API0 严格请求体；先登记（事务提交）后派发；同键同内容不再次派发，异内容 409。
 * 查询：不启动模型、不执行旧批准、不产生业务写、不续期。
 * 响应头未发送前的失败用 HTTP 错误；流开始后的失败只能是显式终态事件。
 */
import { NextRequest } from 'next/server';

import { lookupYayaRun, startYayaRun } from '@/lib/yaya/agent/runtime';
import { yayaRouteError } from '@/lib/yaya/data';
import { createPlatformWriteBinding } from '@/lib/yaya/agent/runtime/platform-binding';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  try {
    return await startYayaRun(request, id, { write: (state) => createPlatformWriteBinding(state, request) });
  } catch (error) {
    return yayaRouteError(error);
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  try {
    return await lookupYayaRun(request, id);
  } catch (error) {
    return yayaRouteError(error);
  }
}
