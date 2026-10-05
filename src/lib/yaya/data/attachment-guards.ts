/**
 * 消息/提案附件引用守卫（DATA1）：附件必须存在、ready 且属于当前 owner。
 * 与冻结图片读取口径一致：deleting/deleted 不得成为新引用。
 */
import type { TransactionClient } from "@/storage/database/pg-client";
import { validateMessageAttachments } from "./invariants";
import { YayaDataError, type YayaAttachmentStatus } from "../storage-types";

export async function assertAttachmentsReadyForOwner(
  client: TransactionClient,
  ownerAccountId: string,
  attachmentIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(attachmentIds)];
  if (unique.length === 0) return;
  const rows = await client.query<{
    id: string;
    uploader_account_id: string;
    status: YayaAttachmentStatus;
  }>(
    "SELECT id, uploader_account_id, status FROM yaya_attachments WHERE id = ANY($1::varchar[])",
    [unique],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const problems = validateMessageAttachments(
    ownerAccountId,
    unique.map((id) => {
      const found = byId.get(id);
      return found
        ? { attachment_id: id, uploader_account_id: found.uploader_account_id, status: found.status }
        : { attachment_id: id, uploader_account_id: "", status: "absent" as const };
    }),
  );
  if (problems.length > 0) {
    const missing = problems.some((entry) => entry.startsWith("attachment_missing"));
    throw new YayaDataError(
      missing ? "attachment_missing" : "attachment_conflict",
      missing ? "引用的附件不存在。" : "附件不可用或不属于当前账号。",
      { reasons: problems },
    );
  }
}
