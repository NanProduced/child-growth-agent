/**
 * YAYA-DATA1-R1 隔离库反例（C 提案业务来源投影 + D 媒体附件存储接口），先行编写。
 *
 * C：当前实现只核 owner 就返回完整 payload、本人提案图片直接 full —— 撤权/转班后
 *    响应仍包含受限内容，即 RED；修复后按当前业务来源投影。
 * D：媒体端口能力（client_upload_id 幂等、pending→ready、三派生对象、租约令牌、
 *    deletion_unknown、聚合审计、只解除自己会话引用）当前缺失，即 RED。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { NextRequest } from "next/server";
import {
  assertCleanupComplete,
  modelGuardEnv,
  runCleanupSteps,
  startIsolatedPostgres,
  startModelRequestGuard,
  type IsolatedPostgres,
} from "../harness-safety";
import { buildPrincipal } from "../../src/lib/accounts/repository";
import { computeCsrfToken, createSessionToken } from "../../src/lib/accounts/session";
import type { Principal } from "../../src/lib/accounts/types";
import * as yayaDataIndex from "../../src/lib/yaya/data";
import { yayaDataRepository } from "../../src/lib/yaya/data";
import type { TransactionClient } from "../../src/storage/database/pg-client";
import { GET as proposalsGet, POST as proposalsPost } from "../../src/app/api/yaya/proposals/route";
import { POST as approvalPost } from "../../src/app/api/yaya/proposals/[id]/approval/route";
import { GET as operationsGet } from "../../src/app/api/yaya/operations/route";
import { GET as messagesGet, POST as messagesPost } from "../../src/app/api/yaya/conversations/[id]/messages/route";
import { POST as conversationsPost } from "../../src/app/api/yaya/conversations/route";

const RUN = `data1r1m-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ORIGIN = "http://data1-r1-media.invalid";
const PRIVATE_MARKER = "PRIVATE_PROPOSAL_CONTENT_MARKER";

let passed = 0;
const failures: string[] = [];
function check(label: string, condition: unknown): void {
  if (condition) passed += 1;
  else {
    failures.push(label);
    console.error(`FAIL: ${label}`);
  }
}
function stage(label: string): void {
  console.error(`[stage] ${label}`);
}
const loose = yayaDataRepository as unknown as Record<string, unknown>;
const looseIndex = yayaDataIndex as unknown as Record<string, unknown>;

interface R1MediaRecord {
  attachment_id: string;
  status: string;
  thumbnail_key?: string;
  width?: number;
  deletion_lease_id: string | null;
}
interface R1Repo {
  insertPendingAttachment(client: TransactionClient, input: Record<string, unknown>): Promise<R1MediaRecord>;
  findAttachmentByClientUploadId(client: TransactionClient, owner: string, clientUploadId: string): Promise<R1MediaRecord | null>;
  markAttachmentReady(client: TransactionClient, attachmentId: string): Promise<R1MediaRecord>;
  removePendingAttachment(client: TransactionClient, attachmentId: string): Promise<boolean>;
  addObservationAttachmentRefs(
    client: TransactionClient,
    input: { observation_id: string; attachment_ids: readonly string[]; actor_account_id: string },
  ): Promise<{ added: number; attachment_revision: number }>;
  getObservationAttachmentRevisionNumber(client: TransactionClient, observationId: string): Promise<number>;
  getMediaAttachmentReferenceFacts(
    client: TransactionClient,
    attachmentId: string,
  ): Promise<{ observation_refs: { observation_id: string; status: string }[] }>;
  releaseConversationAttachmentRefs(
    client: TransactionClient,
    input: { conversation_id: string; message_ids: readonly string[]; owner_account_id: string },
  ): Promise<number>;
  acquireAttachmentDeletionLease(
    client: TransactionClient,
    attachmentId: string,
    expectedRevision?: number,
  ): Promise<{ outcome: string; lease_token?: string; status?: string; record?: unknown }>;
  completeAttachmentDeletionByLease(
    client: TransactionClient,
    input: { attachment_id: string; lease_token: string; outcome: string },
  ): Promise<R1MediaRecord>;
  appendMediaAttachmentAudit(client: TransactionClient, entry: Record<string, unknown>): Promise<void>;
}
const repo = yayaDataRepository as unknown as R1Repo;
function hasMethod(name: string): boolean {
  const ok = typeof loose[name] === "function";
  check(`D 方法已发布：${name}`, ok);
  return ok;
}
function hasIndexFunction(name: string): boolean {
  const ok = typeof looseIndex[name] === "function";
  check(`D 端口工厂已发布：${name}`, ok);
  return ok;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
function req(
  token: string | null,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body: unknown,
  path: string,
): NextRequest {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (token) {
    headers.cookie = `cga_session=${token}`;
    if (method !== "GET") headers["x-csrf-token"] = computeCsrfToken(token);
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function respond(response: Promise<Response>): Promise<{ text: string; json: Record<string, unknown>; status: number }> {
  const result = await response;
  const text = await result.text();
  return { text, json: JSON.parse(text) as Record<string, unknown>, status: result.status };
}

interface Session {
  accountId: string;
  token: string;
  sessionId: string;
  principal: Principal;
}
async function createSession(db: Client, name: string, role: "teacher" | "admin", classIds: string[]): Promise<Session> {
  const accountId = randomUUID();
  const token = createSessionToken();
  await db.query(
    "INSERT INTO app_accounts (id, username, display_name, password_hash, role, status) VALUES ($1,$2,$2,'test-never-logged-in',$3,'active')",
    [accountId, `${RUN}-${name}`, role],
  );
  const session = await db.query<{ id: string }>(
    "INSERT INTO app_sessions (account_id, token_hash, expires_at) VALUES ($1,$2,now()+interval '1 day') RETURNING id",
    [accountId, token.tokenHash],
  );
  for (const classId of classIds) {
    await db.query("INSERT INTO teacher_class_assignments (account_id, class_id) VALUES ($1,$2)", [accountId, classId]);
  }
  return {
    accountId,
    token: token.token,
    sessionId: session.rows[0]!.id,
    principal: buildPrincipal(
      { id: accountId, username: `${RUN}-${name}`, display_name: name, role, status: "active", class_ids: classIds },
      "single-school",
    ),
  };
}
function clientFor(url: string): Client {
  return new Client({ connectionString: url });
}
async function withRawTransaction<T>(client: Client, work: (tx: TransactionClient) => Promise<T>): Promise<T> {
  const tx = client as unknown as TransactionClient;
  await tx.query("BEGIN");
  try {
    const result = await work(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
async function poolQueryFor<T>(url: string, sql: string, paramsList: unknown[] = []): Promise<T[]> {
  const client = clientFor(url);
  await client.connect();
  try {
    const result = await client.query(sql, paramsList);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}
function errorCode(error: unknown): string | null {
  const candidate = error as { name?: string; code?: string };
  return candidate?.name === "YayaDataError" ? candidate.code ?? null : null;
}
async function expectCode(work: () => Promise<unknown>, code: string, label: string): Promise<void> {
  try {
    await work();
    check(label, false);
  } catch (error) {
    check(label, errorCode(error) === code);
  }
}

const confirmItem = (observationId: string, attachments: string[] = []) => ({
  item_key: `item-${observationId.slice(0, 6)}`,
  target_id: observationId,
  action: "observation.confirm",
  resource: "observation",
  resource_ref: { kind: "observation", observation_id: observationId },
  payload: { kind: "organize_observation", observation_id: observationId },
  attachment_associations: attachments.map((id) => ({ attachment_id: id, target_id: observationId })),
  business_revision: null,
});

async function main(): Promise<void> {
  const cleanupIssues: string[] = [];
  const guard = await startModelRequestGuard();
  Object.assign(process.env, modelGuardEnv(guard));
  let isolated: IsolatedPostgres | null = null;
  let db: Client | null = null;
  try {
    isolated = await startIsolatedPostgres({
      runId: RUN,
      containerName: `cga-${RUN}`,
      dbName: `cga_data1r1m_${process.pid}`,
      labelKey: "child-growth-agent.data1-r1-media",
      noteIssue: (label, detail) => cleanupIssues.push(`${label}: ${detail}`),
    });
    process.env.DATABASE_URL = isolated.url;
    delete process.env.PGDATABASE_URL;
    process.env.AUTH_TRUSTED_ORIGINS = ORIGIN;
    db = clientFor(isolated.url);
    await db.connect();
    const database = db;
    const url = isolated.url;

    await database.query(fs.readFileSync(`${ROOT}scripts/initialize-demo-db.sql`, "utf8"));
    await database.query(fs.readFileSync(`${ROOT}scripts/upgrade-auth-v1.sql`, "utf8"));
    await database.query(fs.readFileSync(`${ROOT}scripts/upgrade-yaya-v1.sql`, "utf8"));
    await database.query(fs.readFileSync(`${ROOT}scripts/upgrade-yaya-chat-bind-v1.sql`, "utf8"));

    const classA = randomUUID();
    const classB = randomUUID();
    const classC = randomUUID();
    const childA = randomUUID();
    const childB = randomUUID();
    const childH = randomUUID();
    const childM = randomUUID();
    const obsA = randomUUID();
    const obsB = randomUUID();
    const obsH = randomUUID();
    for (const [id, name] of [
      [classA, "R1M A"],
      [classB, "R1M B"],
      [classC, "R1M C"],
    ] as const) {
      await database.query("INSERT INTO classes (id,name,stage,school_year) VALUES ($1,$2,'small','2026')", [id, name]);
    }
    for (const [childId, classId] of [
      [childA, classA],
      [childB, classB],
      [childH, classA],
      [childM, classA],
    ] as const) {
      await database.query(
        "INSERT INTO children (id,name,gender,birth_date,class_name) VALUES ($1,$2,'女','2022-01-01','fixture')",
        [childId, `Fixture ${childId.slice(0, 8)}`],
      );
      await database.query(
        "INSERT INTO child_class_enrollments (child_id,class_id,start_date) VALUES ($1,$2,'2026-01-01')",
        [childId, classId],
      );
    }
    for (const [observationId, childId, classId] of [
      [obsA, childA, classA],
      [obsB, childB, classB],
      [obsH, childH, classA],
    ] as const) {
      await database.query(
        `INSERT INTO observations (id,child_id,class_id,observed_at,raw_text,status)
         VALUES ($1,$2,$3,'2026-02-01',$4,'ai_organized')`,
        [observationId, childId, classId, PRIVATE_MARKER],
      );
    }
    const teacherA = await createSession(database, "la", "teacher", [classA]);
    const teacherD = await createSession(database, "ld", "teacher", [classA, classB]);
    const teacherH = await createSession(database, "lh", "teacher", [classA]);
    const admin = await createSession(database, "ladmin", "admin", []);
    stage("seeded");

    /* ========================= C：提案按当前业务来源投影 ========================= */

    const createConversation = async (session: Session): Promise<string> =>
      (
        await withRawTransaction(database, (tx) =>
          yayaDataRepository.createConversation(tx, { owner_account_id: session.accountId, title: null }),
        )
      ).conversation_id;
    const registerAttachment = async (owner: Session, attachmentId: string): Promise<void> => {
      await withRawTransaction(database, (tx) =>
        yayaDataRepository.registerAttachment(tx, {
          attachment_id: attachmentId,
          uploader_account_id: owner.accountId,
          conversation_id: null,
          object_key: `${RUN}/${attachmentId}`,
          media_type: "image/png",
          byte_size: 8,
          checksum_sha256: "f".repeat(64),
          source_kind: "raw_input",
          derived_from: null,
        }),
      );
    };
    const prepareViaHttp = async (session: Session, conversationId: string, item: unknown): Promise<string> => {
      const prepared = await respond(
        proposalsPost(
          req(session.token, "POST", {
            conversation_id: conversationId,
            proposal_origin: "teacher_card",
            auth: { kind: "action", action: "observation.confirm", resource: "observation" },
            items: [item],
          }, "/api/yaya/proposals"),
        ),
      );
      check("C 准备提案 201", prepared.status === 201);
      return (prepared.json.proposal as { proposal_id: string }).proposal_id;
    };
    const getProposalHttp = (session: Session, proposalId: string) =>
      respond(proposalsGet(req(session.token, "GET", undefined, `/api/yaya/proposals?proposal_id=${proposalId}`)));

    // 本人旧提案撤权：payload 必须被当前业务来源投影扣留
    const attOnlyProposal = randomUUID();
    await registerAttachment(teacherA, attOnlyProposal);
    const convA = await createConversation(teacherA);
    const proposalRevoked = await prepareViaHttp(teacherA, convA, confirmItem(obsA, [attOnlyProposal]));
    const beforeRevoke = await getProposalHttp(teacherA, proposalRevoked);
    const beforeItem = ((beforeRevoke.json.proposal as Record<string, unknown>).items as Record<string, unknown>[])[0]!;
    const beforeAttachments = (beforeRevoke.json.proposal as Record<string, unknown>).attachments;
    check("C 同 owner 正常对照：access=full 且 payload 存在", beforeItem.access === "full" && beforeItem.payload !== null);
    check(
      "C 同 owner 正常对照：图片可读（上传者本人）",
      Array.isArray(beforeAttachments) && JSON.stringify(beforeAttachments).includes('"readable":true'),
    );

    await database.query(
      "UPDATE teacher_class_assignments SET removed_at = now() WHERE account_id = $1 AND class_id = $2",
      [teacherA.accountId, classA],
    );
    const afterRevoke = await getProposalHttp(teacherA, proposalRevoked);
    const afterItem = ((afterRevoke.json.proposal as Record<string, unknown>).items as Record<string, unknown>[])[0]!;
    check("C 撤权后 payload 必须扣留", afterItem.access !== "full" && afterItem.payload === null);
    check("C 撤权后响应不得包含业务原文", !afterRevoke.text.includes(PRIVATE_MARKER));
    check("C 撤权后仅旧提案图片引用不得可读", !JSON.stringify(afterRevoke.json).includes('"readable":true'));
    check(
      "C 撤权后仍保留 operation 身份用于恢复",
      typeof afterItem.operation_id === "string" && (afterItem.operation_id as string).length > 0,
    );
    stage("c-revoke");

    // 幼儿转班：目标幼儿离开范围后 payload 扣留
    const attTransfer = randomUUID();
    await registerAttachment(teacherA, attTransfer);
    const convTransfer = await createConversation(teacherA);
    const transferProposal = await prepareViaHttp(teacherA, convTransfer, {
      item_key: "transfer-item",
      target_id: childM,
      action: "observation.write",
      resource: "child",
      resource_ref: { kind: "child", child_id: childM },
      payload: {
        kind: "create_observation",
        child_id: childM,
        observed_at: "2026-02-02",
        raw_text: PRIVATE_MARKER,
        context: null,
        confirmed_class_id: null,
        image_ids: [],
        source_input: null,
      },
      attachment_associations: [{ attachment_id: attTransfer, target_id: childM }],
      business_revision: null,
    });
    await database.query(
      "UPDATE child_class_enrollments SET end_date = '2026-02-01' WHERE child_id = $1 AND end_date IS NULL",
      [childM],
    );
    await database.query(
      "INSERT INTO child_class_enrollments (child_id,class_id,start_date) VALUES ($1,$2,'2026-02-01')",
      [childM, classC],
    );
    const transferAfter = await getProposalHttp(teacherA, transferProposal);
    const transferItem = ((transferAfter.json.proposal as Record<string, unknown>).items as Record<string, unknown>[])[0]!;
    check("C 转班后 payload 必须扣留", transferItem.access !== "full" && transferItem.payload === null);
    check("C 转班后响应不得包含业务原文", !transferAfter.text.includes(PRIVATE_MARKER));
    stage("c-transfer");

    // 旧提案 + 正式观察双引用：提案无权但观察引用仍有效 → full
    const attBoth = randomUUID();
    await registerAttachment(teacherD, attBoth);
    await withRawTransaction(database, async (tx) => {
      await tx.query(
        `INSERT INTO yaya_attachment_refs (attachment_id, record_kind, record_id, linked_by_account_id)
         VALUES ($1, 'observation', $2, $3)`,
        [attBoth, obsB, teacherD.accountId],
      );
    });
    const convD = await createConversation(teacherD);
    const proposalBoth = await prepareViaHttp(teacherD, convD, confirmItem(obsA, [attBoth]));
    await database.query(
      "UPDATE teacher_class_assignments SET removed_at = now() WHERE account_id = $1 AND class_id = $2",
      [teacherD.accountId, classA],
    );
    const bothAfter = await getProposalHttp(teacherD, proposalBoth);
    const bothItem = ((bothAfter.json.proposal as Record<string, unknown>).items as Record<string, unknown>[])[0]!;
    check("C 双引用：提案条目本身无权", bothItem.access !== "full" && bothItem.payload === null);
    check("C 双引用：另有有效 full 观察引用时图片仍可读", bothAfter.text.includes('"readable":true'));
    stage("c-both");

    // R2：同一提案内共享照片必须评估全部匹配条目并取最佳合法投影（与条目顺序无关）
    const attShared = randomUUID();
    await registerAttachment(teacherD, attShared);
    const sharedItem = (key: string, observationId: string) => ({
      item_key: key,
      target_id: observationId,
      action: "observation.confirm",
      resource: "observation",
      resource_ref: { kind: "observation", observation_id: observationId },
      payload: { kind: "organize_observation", observation_id: observationId },
      attachment_associations: [{ attachment_id: attShared, target_id: observationId }],
      business_revision: null,
    });
    const prepareSharedOrder = async (order: "deny-first" | "allow-first"): Promise<Record<string, unknown>> => {
      const conversationId = await createConversation(teacherD);
      const items =
        order === "deny-first"
          ? [sharedItem("a-deny", obsA), sharedItem("z-allow", obsB)]
          : [sharedItem("a-allow", obsB), sharedItem("z-deny", obsA)];
      const prepared = await respond(
        proposalsPost(
          req(
            teacherD.token,
            "POST",
            {
              conversation_id: conversationId,
              proposal_origin: "teacher_card",
              auth: { kind: "action", action: "observation.confirm", resource: "observation" },
              items,
            },
            "/api/yaya/proposals",
          ),
        ),
      );
      check(`R2 共享照片提案准备 201（${order}）`, prepared.status === 201);
      const proposalId = (prepared.json.proposal as { proposal_id: string }).proposal_id;
      const projected = await getProposalHttp(teacherD, proposalId);
      return projected.json.proposal as Record<string, unknown>;
    };
    const denyFirst = await prepareSharedOrder("deny-first");
    const allowFirst = await prepareSharedOrder("allow-first");
    const readableOf = (proposal: Record<string, unknown>): boolean =>
      ((proposal.attachments as { readable: boolean }[]) ?? []).some((entry) => entry.readable === true);
    check("R2 共享照片投影与条目顺序无关（无权条目在前仍可读）", readableOf(denyFirst));
    check("R2 共享照片投影与条目顺序无关（有权条目在前仍可读）", readableOf(allowFirst));
    const payloadOf = (proposal: Record<string, unknown>, key: string): unknown =>
      ((proposal.items as { item_key: string; access: string; payload: unknown }[]) ?? []).find(
        (entry) => entry.item_key === key,
      )?.payload;
    check(
      "R2 无权条目 payload 仍扣留、有权条目 payload 保留",
      payloadOf(denyFirst, "a-deny") === null &&
        payloadOf(denyFirst, "z-allow") !== null &&
        payloadOf(allowFirst, "a-allow") !== null &&
        payloadOf(allowFirst, "z-deny") === null,
    );

    // 历史只读：消息附件仅元数据（用未被撤权的独立账号 teacherH）
    const attHistory = randomUUID();
    await registerAttachment(teacherH, attHistory);
    await withRawTransaction(database, async (tx) => {
      await tx.query(
        `INSERT INTO yaya_attachment_refs (attachment_id, record_kind, record_id, linked_by_account_id)
         VALUES ($1, 'observation', $2, $3)`,
        [attHistory, obsH, teacherH.accountId],
      );
    });
    await database.query(
      "UPDATE child_class_enrollments SET end_date = '2026-02-01' WHERE child_id = $1 AND end_date IS NULL",
      [childH],
    );
    await database.query(
      "INSERT INTO child_class_enrollments (child_id,class_id,start_date) VALUES ($1,$2,'2026-02-01')",
      [childH, classB],
    );
    const convHistory = await createConversation(teacherH);
    await respond(
      messagesPost(
        req(
          teacherH.token,
          "POST",
          {
            client_message_id: "r1m-hist",
            role: "user",
            message_kind: "image",
            fragments: [],
            attachment_ids: [attHistory],
            expected_conversation_revision: 1,
          },
          `/api/yaya/conversations/${convHistory}/messages`,
        ),
        params(convHistory),
      ),
    );
    const historyMessages = await respond(
      messagesGet(req(teacherH.token, "GET", undefined, `/api/yaya/conversations/${convHistory}/messages`), params(convHistory)),
    );
    const historyJson = JSON.stringify(historyMessages.json);
    check("C 历史只读：附件仅元数据不可读", historyJson.includes('"metadata_only":true') && !historyJson.includes('"readable":true'));
    stage("c-history");

    // 管理员读取别人提案：owner 边界 404，且不得含内容标记
    const adminRead = await respond(
      proposalsGet(req(admin.token, "GET", undefined, `/api/yaya/proposals?proposal_id=${proposalRevoked}`)),
    );
    check("C 管理员不得读取他人提案", adminRead.status === 404 && !adminRead.text.includes(PRIVATE_MARKER));

    // 原 operation 回执：撤权后 owner 仍可按原身份查询（恢复不被 404 掩盖）
    const recoveryQuery = await respond(
      operationsGet(req(teacherA.token, "GET", undefined, "/api/yaya/operations?operation_id=not-a-real-operation")),
    );
    check("C 原操作查询按 owner 而非业务范围判定（存在性未知不伪装成功）", recoveryQuery.status === 404);
    stage("c-admin-recovery");

    /* ========================= D：媒体附件存储接口 ========================= */

    const dReady = [
      "insertPendingAttachment",
      "findAttachmentByClientUploadId",
      "markAttachmentReady",
      "removePendingAttachment",
      "addObservationAttachmentRefs",
      "getObservationAttachmentRevisionNumber",
      "getMediaAttachmentReferenceFacts",
      "releaseConversationAttachmentRefs",
      "acquireAttachmentDeletionLease",
      "completeAttachmentDeletionByLease",
      "appendMediaAttachmentAudit",
    ].every(hasMethod);
    if (dReady) {
      const attM = randomUUID();
      const record = {
        attachment_id: attM,
        owner_account_id: teacherA.accountId,
        status: "pending" as const,
        object_key: `${RUN}/m-original`,
        thumbnail_key: `${RUN}/m-thumb`,
        model_key: `${RUN}/m-model`,
        content_type: "image/jpeg",
        byte_size: 1234,
        checksum_sha256: "a".repeat(64),
        thumbnail_checksum: "b".repeat(64),
        model_checksum: "c".repeat(64),
        width: 800,
        height: 600,
        client_upload_id: "client-1",
        created_at: new Date().toISOString(),
        deletion_lease_id: null,
      };
      await withRawTransaction(database, (tx) => repo.insertPendingAttachment(tx, record));
      const found = await withRawTransaction(database, (tx) =>
        repo.findAttachmentByClientUploadId(tx, teacherA.accountId, "client-1"),
      );
      check("D client_upload_id 幂等查询命中同一附件", found?.attachment_id === attM && found?.status === "pending");
      const otherOwner = await withRawTransaction(database, (tx) =>
        repo.findAttachmentByClientUploadId(tx, teacherD.accountId, "client-1"),
      );
      check("D client_upload_id 按 owner 隔离", otherOwner === null);
      await expectCode(
        () =>
          withRawTransaction(database, (tx) =>
            repo.insertPendingAttachment(tx, { ...record, attachment_id: randomUUID() }),
          ),
        "attachment_conflict",
        "D 同 owner 重复 client_upload_id 拒绝",
      );
      const pendingRefs = await withRawTransaction(database, (tx) =>
        repo.addObservationAttachmentRefs
          ? repo.addObservationAttachmentRefs(tx, {
              observation_id: obsA,
              attachment_ids: [attM],
              actor_account_id: teacherA.accountId,
            })
          : Promise.reject(new Error("missing")),
      ).catch((error: unknown) => error);
      check("D pending 附件不得新增引用", errorCode(pendingRefs) === "attachment_conflict");
      const pendingLease = await withRawTransaction(database, (tx) =>
        repo.acquireAttachmentDeletionLease(tx, attM),
      );
      check("D pending 不得获得租约", pendingLease.outcome === "not_ready");
      const ready = await withRawTransaction(database, (tx) => repo.markAttachmentReady(tx, attM));
      check("D pending→ready CAS 成功且返回完整字段", ready.status === "ready" && ready.thumbnail_key === `${RUN}/m-thumb` && ready.width === 800);
      await expectCode(
        () => withRawTransaction(database, (tx) => repo.markAttachmentReady(tx, attM)),
        "attachment_conflict",
        "D 非 pending 不得再次 markReady",
      );

      const attP = randomUUID();
      await withRawTransaction(database, (tx) =>
        repo.insertPendingAttachment(tx, {
          ...record,
          attachment_id: attP,
          client_upload_id: null,
          object_key: `${RUN}/p-original`,
        }),
      );
      const removed = await withRawTransaction(database, (tx) => repo.removePendingAttachment(tx, attP));
      check("D removePending 删除 pending 返回 true", removed === true);
      const removedAgain = await withRawTransaction(database, (tx) => repo.removePendingAttachment(tx, attM));
      check("D removePending 对非 pending 返回 false", removedAgain === false);

      const attM2 = randomUUID();
      await withRawTransaction(database, (tx) =>
        repo.insertPendingAttachment(tx, {
          ...record,
          attachment_id: attM2,
          client_upload_id: "client-2",
          object_key: `${RUN}/m2-original`,
        }),
      );
      await withRawTransaction(database, (tx) => repo.markAttachmentReady(tx, attM2));
      const added = await withRawTransaction(database, (tx) =>
        repo.addObservationAttachmentRefs(tx, {
          observation_id: obsA,
          attachment_ids: [attM, attM2],
          actor_account_id: teacherA.accountId,
        }),
      );
      check("D 观察引用 added/revision 计数正确", added.added === 2 && added.attachment_revision === 2);
      const addedAgain = await withRawTransaction(database, (tx) =>
        repo.addObservationAttachmentRefs(tx, {
          observation_id: obsA,
          attachment_ids: [attM],
          actor_account_id: teacherA.accountId,
        }),
      );
      check("D 重复观察引用幂等不递增", addedAgain.added === 0 && addedAgain.attachment_revision === 2);
      const revisionNumber = await withRawTransaction(database, (tx) =>
        repo.getObservationAttachmentRevisionNumber(tx, obsA),
      );
      check("D 观察附件 revision 读取一致", revisionNumber === 2);

      const facts = await withRawTransaction(database, (tx) => repo.getMediaAttachmentReferenceFacts(tx, attM));
      check(
        "D 引用事实完整返回观察状态",
        facts.observation_refs.some((entry: { observation_id: string; status: string }) => entry.observation_id === obsA && entry.status === "ai_organized"),
      );

      // dangling 引用：查询必须按不完整拒绝，而不是空集
      const danglingAtt = randomUUID();
      await withRawTransaction(database, (tx) =>
        repo.insertPendingAttachment(tx, {
          ...record,
          attachment_id: danglingAtt,
          client_upload_id: "client-dangling",
          object_key: `${RUN}/dangling-original`,
        }),
      );
      await withRawTransaction(database, (tx) => repo.markAttachmentReady(tx, danglingAtt));
      await database.query(
        `INSERT INTO yaya_attachment_refs (attachment_id, record_kind, record_id, linked_by_account_id)
         VALUES ($1, 'observation', $2, $3)`,
        [danglingAtt, randomUUID(), teacherA.accountId],
      );
      await expectCode(
        () => withRawTransaction(database, (tx) => repo.getMediaAttachmentReferenceFacts(tx, danglingAtt)),
        "reference_incomplete",
        "D 悬空引用按查询不完整拒绝",
      );

      // 只解除指定 owner 会话的消息引用
      const convRel = await createConversation(teacherA);
      const msgRel = randomUUID();
      await database.query(
        `INSERT INTO yaya_messages (id, conversation_id, owner_account_id, role, message_kind, fragments, attachment_ids)
         VALUES ($1,$2,$3,'user','image','[]'::jsonb,'[]'::jsonb)`,
        [msgRel, convRel, teacherA.accountId],
      );
      await database.query(
        `INSERT INTO yaya_attachment_refs (attachment_id, record_kind, record_id, linked_by_account_id)
         VALUES ($1, 'message', $2, $3)`,
        [attM, msgRel, teacherA.accountId],
      );
      await expectCode(
        () =>
          withRawTransaction(database, (tx) =>
            repo.releaseConversationAttachmentRefs(tx, {
              conversation_id: convRel,
              message_ids: [msgRel],
              owner_account_id: teacherD.accountId,
            }),
          ),
        "owner_mismatch",
        "D 非会话 owner 不得解除引用",
      );
      const releasedCount = await withRawTransaction(database, (tx) =>
        repo.releaseConversationAttachmentRefs(tx, {
          conversation_id: convRel,
          message_ids: [msgRel],
          owner_account_id: teacherA.accountId,
        }),
      );
      const observationRefsLeft = await poolQueryFor<{ count: string }>(
        url,
        "SELECT count(*)::text AS count FROM yaya_attachment_refs WHERE attachment_id = $1 AND record_kind = 'observation'",
        [attM],
      );
      check("D 只解除指定会话消息引用且观察引用保留", releasedCount === 1 && observationRefsLeft[0]?.count === "1");

      // 租约令牌、unknown 无损、可重取、令牌核对
      const attL = randomUUID();
      await withRawTransaction(database, (tx) =>
        repo.insertPendingAttachment(tx, {
          ...record,
          attachment_id: attL,
          client_upload_id: "client-lease",
          object_key: `${RUN}/lease-original`,
        }),
      );
      await withRawTransaction(database, (tx) => repo.markAttachmentReady(tx, attL));
      const lease = await withRawTransaction(database, (tx) => repo.acquireAttachmentDeletionLease(tx, attL));
      check("D ready 可获取租约令牌", lease.outcome === "acquired" && typeof lease.lease_token === "string");
      const busy = await withRawTransaction(database, (tx) => repo.acquireAttachmentDeletionLease(tx, attL));
      check(
        "D 租约进行中不可重取（not_ready + deleting）",
        busy.outcome === "not_ready" && busy.status === "deleting",
      );
      await expectCode(
        () =>
          withRawTransaction(database, (tx) =>
            repo.completeAttachmentDeletionByLease(tx, {
              attachment_id: attL,
              lease_token: "wrong-token",
              outcome: "deleted",
            }),
          ),
        "revision_conflict",
        "D 错误租约令牌拒绝落状态",
      );
      const unknownRecord = await withRawTransaction(database, (tx) =>
        repo.completeAttachmentDeletionByLease(tx, {
          attachment_id: attL,
          lease_token: lease.lease_token ?? "",
          outcome: "unknown",
        }),
      );
      check("D unknown 结果保留 deletion_unknown 且不恢复 ready", unknownRecord.status === "deletion_unknown");
      const reLease = await withRawTransaction(database, (tx) => repo.acquireAttachmentDeletionLease(tx, attL));
      check("D deletion_unknown 可重新取得租约", reLease.outcome === "acquired");
      const deletedRecord = await withRawTransaction(database, (tx) =>
        repo.completeAttachmentDeletionByLease(tx, {
          attachment_id: attL,
          lease_token: reLease.lease_token ?? "",
          outcome: "deleted",
        }),
      );
      check("D deleted 终态", deletedRecord.status === "deleted" && deletedRecord.deletion_lease_id === null);
      const deletedLease = await withRawTransaction(database, (tx) => repo.acquireAttachmentDeletionLease(tx, attL));
      check(
        "D 已删除不可再取租约（not_ready + deleted）",
        deletedLease.outcome === "not_ready" && deletedLease.status === "deleted",
      );

      // 聚合审计
      const auditId = randomUUID();
      await withRawTransaction(database, (tx) =>
        repo.appendMediaAttachmentAudit(tx, {
          audit_id: auditId,
          action: "attach_observation_images",
          observation_id: obsA,
          attachment_ids: [attM, attM2],
          actor_account_id: teacherA.accountId,
          source_confirmed_at: null,
          request_id: "req-1",
          recorded_at: new Date().toISOString(),
        }),
      );
      const auditRow = await poolQueryFor<{ attachment_ids: unknown; request_id: string }>(
        url,
        "SELECT attachment_ids, request_id FROM yaya_attachment_appends WHERE audit_id = $1",
        [auditId],
      );
      check(
        "D 聚合审计独立落库",
        Array.isArray(auditRow[0]?.attachment_ids) &&
          (auditRow[0]?.attachment_ids as string[]).length === 2 &&
          auditRow[0]?.request_id === "req-1",
      );
    }

    if (hasIndexFunction("bindYayaAttachmentMetadataPort")) {
      interface R1Port {
        get(id: string): Promise<Record<string, unknown> | null>;
        markReady(id: string): Promise<Record<string, unknown>>;
        insertPending(record: Record<string, unknown>): Promise<void>;
        addObservationReferences(input: {
          observation_id: string;
          attachment_ids: readonly string[];
          actor_account_id: string;
          expected_attachment_revision?: number;
          source_confirmed_at?: string | null;
        }): Promise<{ added: number; attachment_revision: number }>;
        getObservationAttachmentRevision(observationId: string): Promise<number>;
      }
      const bindFactory = looseIndex.bindYayaAttachmentMetadataPort as (client: TransactionClient) => R1Port;
      const createFactory = looseIndex.createYayaAttachmentMetadataPort as (connect?: unknown) => R1Port;
      check("D 短事务端口工厂存在", typeof createFactory === "function");
      const boundClient = clientFor(url);
      await boundClient.connect();
      const port = bindFactory(boundClient as unknown as TransactionClient);
      const portRecord = await port.get("missing-attachment");
      check("D 绑定端口 get 未命中返回 null", portRecord === null);
      await boundClient.end();
      if (typeof createFactory === "function") {
        const shortPort = createFactory();
        const pid = randomUUID();
        await withRawTransaction(database, (tx) => {
          void tx;
          return Promise.resolve();
        });
        await withRawTransaction(database, (tx) =>
          repo.insertPendingAttachment(tx, {
            attachment_id: pid,
            owner_account_id: teacherA.accountId,
            status: "pending",
            object_key: `${RUN}/port-original`,
            thumbnail_key: `${RUN}/port-thumb`,
            model_key: `${RUN}/port-model`,
            content_type: "image/png",
            byte_size: 10,
            checksum_sha256: "d".repeat(64),
            thumbnail_checksum: "e".repeat(64),
            model_checksum: "f".repeat(64),
            width: 10,
            height: 10,
            client_upload_id: "client-port",
            created_at: new Date().toISOString(),
            deletion_lease_id: null,
          }),
        );
        const marked = await (shortPort.markReady as (id: string) => Promise<Record<string, unknown>>)(pid);
        check("D 短事务端口 markReady 可用", marked.status === "ready");

        /* -------- R2：媒体端口剩余缺口（租约引用核查 / 追加版本条件） -------- */
        const uploadReadyViaRepo = async (attachmentId: string): Promise<void> => {
          await withRawTransaction(database, (tx) =>
            repo.insertPendingAttachment(tx, {
              attachment_id: attachmentId,
              owner_account_id: teacherA.accountId,
              status: "pending",
              object_key: `${RUN}/r2-${attachmentId}-original`,
              thumbnail_key: `${RUN}/r2-${attachmentId}-thumb`,
              model_key: `${RUN}/r2-${attachmentId}-model`,
              content_type: "image/png",
              byte_size: 10,
              checksum_sha256: "1".repeat(64),
              thumbnail_checksum: "2".repeat(64),
              model_checksum: "3".repeat(64),
              width: 10,
              height: 10,
              client_upload_id: `r2-${attachmentId}`,
              created_at: new Date().toISOString(),
              deletion_lease_id: null,
            }),
          );
          await withRawTransaction(database, (tx) => repo.markAttachmentReady(tx, attachmentId));
        };

        // P1：租约取得时锁后核完整引用（有引用必须拒绝且不进入 deleting）
        const attLeaseRef = randomUUID();
        await uploadReadyViaRepo(attLeaseRef);
        await withRawTransaction(database, (tx) =>
          repo.addObservationAttachmentRefs(tx, {
            observation_id: obsA,
            attachment_ids: [attLeaseRef],
            actor_account_id: teacherA.accountId,
          }),
        );
        const leaseAfterRef = await withRawTransaction(database, (tx) =>
          repo.acquireAttachmentDeletionLease(tx, attLeaseRef),
        );
        check("R2 租约取得时锁后核引用：已有引用必须拒绝", leaseAfterRef.outcome === "referenced");
        const statusAfterRef = await poolQueryFor<{ status: string }>(
          url,
          "SELECT status FROM yaya_attachments WHERE id = $1",
          [attLeaseRef],
        );
        check("R2 有引用附件不得进入 deleting", statusAfterRef[0]?.status === "ready");

        // P1：引用查询不完整（悬空引用）同样必须拒绝租约
        const attDanglingLease = randomUUID();
        await uploadReadyViaRepo(attDanglingLease);
        await database.query(
          `INSERT INTO yaya_attachment_refs (attachment_id, record_kind, record_id, linked_by_account_id)
           VALUES ($1, 'observation', $2, $3)`,
          [attDanglingLease, randomUUID(), teacherA.accountId],
        );
        const leaseDangling = await withRawTransaction(database, (tx) =>
          repo.acquireAttachmentDeletionLease(tx, attDanglingLease),
        );
        check("R2 引用查询不完整必须拒绝租约", leaseDangling.outcome === "reference_incomplete");

        // P1：归档追加携带 expected_revision（端口同签名传 expected 时走 CAS）
        const obsCas = randomUUID();
        const obsCasConfirmedAt = "2026-04-01T00:00:00Z";
        await database.query(
          `INSERT INTO observations (id,child_id,class_id,observed_at,raw_text,status,confirmed_at)
           VALUES ($1,$2,$3,'2026-04-01','R2 CAS 夹具。','confirmed',$4)`,
          [obsCas, childA, classA, obsCasConfirmedAt],
        );
        const attCasA = randomUUID();
        const attCasB = randomUUID();
        await uploadReadyViaRepo(attCasA);
        await uploadReadyViaRepo(attCasB);
        const casFirst = await shortPort.addObservationReferences({
          observation_id: obsCas,
          attachment_ids: [attCasA],
          actor_account_id: teacherA.accountId,
          expected_attachment_revision: 0,
          source_confirmed_at: obsCasConfirmedAt,
        });
        check("R2 归档追加首个 expected=0 成功", casFirst.added === 1 && casFirst.attachment_revision === 1);
        let casSecondError: unknown = null;
        try {
          await shortPort.addObservationReferences({
            observation_id: obsCas,
            attachment_ids: [attCasB],
            actor_account_id: teacherA.accountId,
            expected_attachment_revision: 0,
            source_confirmed_at: obsCasConfirmedAt,
          });
        } catch (error) {
          casSecondError = error;
        }
        check("R2 归档追加过期前提必须拒绝", errorCode(casSecondError) === "revision_conflict");
        const casRevision = await shortPort.getObservationAttachmentRevision(obsCas);
        check("R2 归档追加最终 revision 只递增一次", casRevision === 1);
      }
    }

    stage("d-done");
    check("模型守门未被触发", guard.hits === 0);
  } finally {
    await runCleanupSteps(
      [
        { label: "database", run: () => db?.end().then(() => undefined) },
        {
          label: "container",
          run: () => {
            if (!isolated) return;
            const report = isolated.teardown();
            if (!report.ok) throw new Error(report.detail);
          },
        },
        { label: "model-guard", run: () => guard.close() },
      ],
      (label, detail) => cleanupIssues.push(`${label}: ${detail}`),
    );
    assertCleanupComplete(cleanupIssues);
  }
  console.log(JSON.stringify({ passed, total: passed + failures.length, failures, r1_media: true, run_id: RUN }));
  assert.equal(failures.length, 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
