import { NextRequest } from "next/server";
import { z } from "zod";
import { communicationPeriodSchema } from "@/lib/family-communication-contract";
import { CommunicationError, communicationErrorResponse, generateCommunication, loadCommunicationWorkspace, lookupCommunication } from "@/lib/family-communication";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams;
    const original = query.get("client_request_id");
    if (original) return Response.json({ communication: await lookupCommunication(request, original) }, { headers: { "Cache-Control": "no-store" } });
    const childId = query.get("child_id");
    const kind = query.get("kind");
    const period = communicationPeriodSchema.safeParse(kind === "year" ? { kind } : { kind, value: query.get("value") });
    if (!z.string().uuid().safeParse(childId).success || !period.success) throw new CommunicationError("invalid_request", "请选择幼儿和时间段。", 400);
    return Response.json(await loadCommunicationWorkspace(request, childId!, period.data), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationErrorResponse(error); }
}
export async function POST(request: NextRequest) {
  try {
    const communication = await generateCommunication(request, await request.json().catch(() => null));
    return Response.json({ communication }, { status: communication.status === "generating" ? 202 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationErrorResponse(error); }
}
