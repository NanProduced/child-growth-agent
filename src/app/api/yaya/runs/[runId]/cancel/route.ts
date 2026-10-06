/**
 * 芽芽取消运行：请求体必须为空；只停止该 run 后续派发/消费，
 * 不撤销已提交业务，也不声称上游物理取消已经验证。
 */
import { NextRequest } from 'next/server';

import { cancelYayaRun } from '@/lib/yaya/agent/runtime';
import { yayaRouteError } from '@/lib/yaya/data';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await params;
  try {
    return await cancelYayaRun(request, runId);
  } catch (error) {
    return yayaRouteError(error);
  }
}
