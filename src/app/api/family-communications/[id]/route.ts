import { NextRequest } from "next/server";
import { communicationErrorResponse, updateCommunication } from "@/lib/family-communication";

export const runtime = "nodejs";
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return Response.json({ communication: await updateCommunication(request, id, await request.json().catch(() => null)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationErrorResponse(error); }
}
