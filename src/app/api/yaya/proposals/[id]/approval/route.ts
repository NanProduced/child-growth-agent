import { NextRequest, NextResponse } from "next/server";
import { yayaDataRepository, withPrivateRead, withPrivateWrite, yayaRouteError } from "@/lib/yaya/data";
import { normalizeApprovalAction } from "@/lib/yaya/data/invariants";
import { YayaDataError } from "@/lib/yaya/storage-types";

/**
 * 可信批准入口：只接受 { action, operation_ids }；approved/scope/Principal/
 * 资源事实/摘要等一切自报字段在 normalize 中丢弃。actor/session/资源事实/
 * 内容 digest/附件/业务版本快照全部服务端生成。批准不执行业务。
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body: unknown = await request.json().catch(() => null);
    const action = normalizeApprovalAction(body);
    if (action.action === "approve") {
      const result = await withPrivateWrite(request, ({ client, principal, sessionId, schoolId }) =>
        yayaDataRepository.recordApproval(client, {
          proposal_id: id,
          operation_ids: action.operation_ids,
          principal,
          session_id: sessionId,
          school_id: schoolId,
          execution_at: new Date().toISOString(),
        }),
      );
      return NextResponse.json(result, { status: 201 });
    }
    if (action.action === "reject") {
      const proposal = await withPrivateWrite(request, ({ client, principal }) =>
        yayaDataRepository.rejectProposalItems(client, {
          owner_account_id: principal.account_id,
          proposal_id: id,
          operation_ids: action.operation_ids,
        }),
      );
      return NextResponse.json({ proposal });
    }
    const result = await withPrivateWrite(request, ({ client, principal }) =>
      yayaDataRepository.cancelPendingApproval(client, {
        owner_account_id: principal.account_id,
        proposal_id: id,
      }),
    );
    return NextResponse.json(result);
  } catch (error) {
    return yayaRouteError(error);
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const approval = await withPrivateRead(request, ({ client, principal }) =>
      yayaDataRepository.getApproval(client, principal.account_id, id),
    );
    if (!approval) throw new YayaDataError("not_found", "批准记录不存在。");
    return NextResponse.json({ approval });
  } catch (error) {
    return yayaRouteError(error);
  }
}
