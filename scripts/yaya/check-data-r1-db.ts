/**
 * YAYA-DATA1-R1 隔离库反例（A 投影泄漏 + B 附件引用锁互斥），先行编写。
 *
 * 当前实现上的真实失败即 RED（HTTP 响应里存在原始受限标题/provenance 标记、
 * 引用写入与删除租约可同时在未提交窗口成立）；修复后 GREEN。
 * 只使用已获批 harness 的一次性本地 PostgreSQL；无模型/搜索/S3/托管库。
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
import { yayaDataRepository } from "../../src/lib/yaya/data";
import { beginAttachmentDeletion } from "../../src/lib/yaya/data/attachments";
import type { TransactionClient } from "../../src/storage/database/pg-client";
import { GET as conversationsGet, POST as conversationsPost } from "../../src/app/api/yaya/conversations/route";
import { DELETE as conversationDelete, GET as conversationGet, PATCH as conversationPatch } from "../../src/app/api/yaya/conversations/[id]/route";
import { GET as messagesGet, POST as messagesPost } from "../../src/app/api/yaya/conversations/[id]/messages/route";

const RUN = `data1r1-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ORIGIN = "http://data1-r1.invalid";
const PRIVATE_TITLE = "PRIVATE_CHILD_NAME_AND_FACT";
const PRIVATE_FRAGMENT = "PRIVATE_FRAGMENT_BODY";
const PRIVATE_PROVENANCE = "PRIVATE_PROVENANCE_LABEL";

let passed = 0;
const failures: string[] = [];
function check(label: string, condition: unknown): void {
  if (condition) {
    passed += 1;
  } else {
    failures.push(label);
    console.error(`FAIL: ${label}`);
  }
}
function stage(label: string): void {
  console.error(`[stage] ${label}`);
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
function req(
  token: string | null,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body: unknown,
  path: string,
  overrides: Record<string, string> = {},
): NextRequest {
  const headers: Record<string, string> = { origin: ORIGIN, ...overrides };
  if (token) {
    headers.cookie ??= `cga_session=${token}`;
    if (method !== "GET") headers["x-csrf-token"] ??= computeCsrfToken(token);
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

interface Attempt<T> {
  state: "pending" | "done";
  value?: T;
  error?: unknown;
  promise: Promise<void>;
}
function startAttempt<T>(work: () => Promise<T>): Attempt<T> {
  const attempt: Attempt<T> = { state: "pending", promise: Promise.resolve() };
  attempt.promise = work().then(
    (value) => {
      attempt.state = "done";
      attempt.value = value;
    },
    (error) => {
      attempt.state = "done";
      attempt.error = error;
    },
  );
  return attempt;
}
function errorCode(error: unknown): string | null {
  const candidate = error as { name?: string; code?: string };
  return candidate?.name === "YayaDataError" ? candidate.code ?? null : null;
}

type WriterKind = "saveMessage" | "prepareProposal" | "appendObservation" | "linkRef";

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
      dbName: `cga_data1r1_${process.pid}`,
      labelKey: "child-growth-agent.data1-r1",
      noteIssue: (label, detail) => cleanupIssues.push(`${label}: ${detail}`),
    });
    process.env.DATABASE_URL = isolated.url;
    delete process.env.PGDATABASE_URL;
    process.env.AUTH_TRUSTED_ORIGINS = ORIGIN;
    db = clientFor(isolated.url);
    await db.connect();
    const database = db;
    const containerUrl = isolated.url;

    await database.query(fs.readFileSync(`${ROOT}scripts/initialize-demo-db.sql`, "utf8"));
    await database.query(fs.readFileSync(`${ROOT}scripts/upgrade-auth-v1.sql`, "utf8"));
    await database.query(fs.readFileSync(`${ROOT}scripts/upgrade-yaya-v1.sql`, "utf8"));
    await database.query(fs.readFileSync(`${ROOT}scripts/upgrade-yaya-chat-bind-v1.sql`, "utf8"));
    const classA = randomUUID();
    const classB = randomUUID();
    const classC = randomUUID();
    const childA = randomUUID();
    const childC = randomUUID();
    const obsA = randomUUID();
    for (const [id, name] of [
      [classA, "R1 A"],
      [classB, "R1 B"],
      [classC, "R1 C"],
    ] as const) {
      await database.query("INSERT INTO classes (id,name,stage,school_year) VALUES ($1,$2,'small','2026')", [id, name]);
    }
    for (const [childId, classId] of [
      [childA, classA],
      [childC, classC],
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
    await database.query(
      `INSERT INTO observations (id,child_id,class_id,observed_at,raw_text,status)
       VALUES ($1,$2,$3,'2026-01-02','R1 观察原文。','ai_organized')`,
      [obsA, childA, classA],
    );
    const teacherA = await createSession(database, "a", "teacher", [classA, classB]);
    stage("seeded");

    /* ========================= A：对外响应不得包含受限标题/正文/provenance ========================= */

    const created = await respond(
      conversationsPost(req(teacherA.token, "POST", { title: null }, "/api/yaya/conversations")),
    );
    check("A 创建会话 201", created.status === 201);
    const convPrivate = (created.json.conversation as Record<string, unknown>).conversation_id as string;
    const privateSaved = await withRawTransaction(database, (tx) =>
      yayaDataRepository.saveRunTerminalMessage(tx, teacherA.principal, "single-school", {
        conversation_id: convPrivate,
        role: "assistant",
        message_kind: "text",
        execution_state: "none",
        fragments: [
          {
            fragment_id: "f-priv",
            text: PRIVATE_FRAGMENT,
            sources: [{ kind: "child", child_id: childC, current_class_id: null }],
            independently_readable: true,
            provenance: {
              kind: "child_fact",
              ref_id: obsA,
              label: PRIVATE_PROVENANCE,
              derived_from: null,
            },
          },
        ],
        attachment_ids: [],
        run: { run_id: `${RUN}-r1-m1`, client_request_id: `${RUN}-r1-m1-req` },
        binding_state: "bound",
        expected_conversation_revision: 1,
      }),
    );
    const privateMessage = {
      status: 201,
      json: privateSaved as unknown as Record<string, unknown>,
      text: JSON.stringify(privateSaved),
    };
    check("A 保存受限来源消息 201", privateMessage.status === 201);
    check("A 受限片段正文不得出现在消息响应", !privateMessage.text.includes(PRIVATE_FRAGMENT));
    check("A 受限片段 provenance.label 不得出现在消息响应", !privateMessage.text.includes(PRIVATE_PROVENANCE));

    const renamedPrivate = await respond(
      conversationPatch(
        req(
          teacherA.token,
          "PATCH",
          { title: PRIVATE_TITLE, expected_revision: 2, title_source_fragments: ["f-priv"] },
          `/api/yaya/conversations/${convPrivate}`,
        ),
        params(convPrivate),
      ),
    );
    check("A 改名 200", renamedPrivate.status === 200);
    check("A 改名响应不得含原始标题", !renamedPrivate.text.includes(PRIVATE_TITLE));

    const detail = await respond(
      conversationGet(req(teacherA.token, "GET", undefined, `/api/yaya/conversations/${convPrivate}`), params(convPrivate)),
    );
    check("A 详情 200", detail.status === 200);
    const detailConversation = detail.json.conversation as Record<string, unknown>;
    check("A 详情响应不得含原始标题", !detail.text.includes(PRIVATE_TITLE));
    check("A 详情响应不得含原始 title/title_source_fragments 字段", !("title" in detailConversation) && !("title_source_fragments" in detailConversation));
    check(
      "A 受限派生标题回退通用标题并标记受限",
      detailConversation.projected_title === "受限会话" && detailConversation.title_restricted === true,
    );
    check("A 详情响应不得含受限正文/provenance 标记", !detail.text.includes(PRIVATE_FRAGMENT) && !detail.text.includes(PRIVATE_PROVENANCE));

    const replaySaved = await withRawTransaction(database, (tx) =>
      yayaDataRepository.saveRunTerminalMessage(tx, teacherA.principal, "single-school", {
        conversation_id: convPrivate,
        role: "assistant",
        message_kind: "text",
        execution_state: "none",
        fragments: [
          {
            fragment_id: "f-priv",
            text: PRIVATE_FRAGMENT,
            sources: [{ kind: "child", child_id: childC, current_class_id: null }],
            independently_readable: true,
            provenance: {
              kind: "child_fact",
              ref_id: obsA,
              label: PRIVATE_PROVENANCE,
              derived_from: null,
            },
          },
        ],
        attachment_ids: [],
        run: { run_id: `${RUN}-r1-m1`, client_request_id: `${RUN}-r1-m1-req` },
        binding_state: "bound",
        expected_conversation_revision: 1,
      }),
    );
    const replay = {
      status: replaySaved.replayed ? 201 : 200,
      json: replaySaved as unknown as Record<string, unknown>,
      text: JSON.stringify(replaySaved),
    };
    check("A 幂等回放命中 replayed=true", replaySaved.replayed === true);
    check("A 幂等回放响应不得含原始标题", !replay.text.includes(PRIVATE_TITLE));

    const secondMessage = await respond(
      messagesPost(
        req(
          teacherA.token,
          "POST",
          {
            client_message_id: "r1-m2",
            role: "user",
            message_kind: "text",
            fragments: [],
            attachment_ids: [],
            expected_conversation_revision: 3,
          },
          `/api/yaya/conversations/${convPrivate}/messages`,
        ),
        params(convPrivate),
      ),
    );
    check("A 新消息响应不得含原始标题", secondMessage.status === 201 && !secondMessage.text.includes(PRIVATE_TITLE));

    const listed = await respond(conversationsGet(req(teacherA.token, "GET", undefined, "/api/yaya/conversations")));
    check("A 列表响应不得含原始标题", listed.status === 200 && !listed.text.includes(PRIVATE_TITLE));

    const messagesListed = await respond(
      messagesGet(req(teacherA.token, "GET", undefined, `/api/yaya/conversations/${convPrivate}/messages`), params(convPrivate)),
    );
    check("A 消息列表响应不得含原始标题/受限正文/provenance", !messagesListed.text.includes(PRIVATE_TITLE) && !messagesListed.text.includes(PRIVATE_FRAGMENT) && !messagesListed.text.includes(PRIVATE_PROVENANCE));

    // 损坏 / 缺失来源：不得当成“无来源手工标题”
    const corruptCreated = await respond(conversationsPost(req(teacherA.token, "POST", { title: null }, "/api/yaya/conversations")));
    const convCorrupt = (corruptCreated.json.conversation as Record<string, unknown>).conversation_id as string;
    await respond(
      conversationPatch(
        req(teacherA.token, "PATCH", { title: PRIVATE_TITLE, expected_revision: 1 }, `/api/yaya/conversations/${convCorrupt}`),
        params(convCorrupt),
      ),
    );
    await database.query(`UPDATE yaya_conversations SET title_source_fragments = '["ok", 1]'::jsonb WHERE id = $1`, [convCorrupt]);
    const corruptDetail = await respond(
      conversationGet(req(teacherA.token, "GET", undefined, `/api/yaya/conversations/${convCorrupt}`), params(convCorrupt)),
    );
    check(
      "A 损坏来源不得作为手工标题放行",
      !corruptDetail.text.includes(PRIVATE_TITLE) &&
        (corruptDetail.json.conversation as Record<string, unknown>).title_restricted === true,
    );
    await database.query(`UPDATE yaya_conversations SET title_source_fragments = '["f-does-not-exist"]'::jsonb WHERE id = $1`, [convCorrupt]);
    const missingDetail = await respond(
      conversationGet(req(teacherA.token, "GET", undefined, `/api/yaya/conversations/${convCorrupt}`), params(convCorrupt)),
    );
    check(
      "A 无法核验的派生来源不得作为手工标题放行",
      !missingDetail.text.includes(PRIVATE_TITLE) &&
        (missingDetail.json.conversation as Record<string, unknown>).title_restricted === true,
    );

    // 正向对照：合法手工标题、可读派生标题、普通正文
    const manualCreated = await respond(
      conversationsPost(req(teacherA.token, "POST", { title: "MANUAL_OK_TITLE" }, "/api/yaya/conversations")),
    );
    const convManual = (manualCreated.json.conversation as Record<string, unknown>).conversation_id as string;
    const manualDetail = await respond(
      conversationGet(req(teacherA.token, "GET", undefined, `/api/yaya/conversations/${convManual}`), params(convManual)),
    );
    const manualView = manualDetail.json.conversation as Record<string, unknown>;
    check("A 合法手工标题正向可读", manualView.projected_title === "MANUAL_OK_TITLE" && manualView.title_restricted === false);
    const fullCreated = await respond(conversationsPost(req(teacherA.token, "POST", { title: null }, "/api/yaya/conversations")));
    const convFull = (fullCreated.json.conversation as Record<string, unknown>).conversation_id as string;
    const fullMessage = await respond(
      messagesPost(
        req(
          teacherA.token,
          "POST",
          {
            client_message_id: "r1-full",
            role: "user",
            message_kind: "text",
            fragments: [
              {
                fragment_id: "f-full",
                text: "PUBLIC_OK_BODY",
                sources: [{ kind: "child", child_id: childA, current_class_id: null }],
                independently_readable: true,
                provenance: { kind: "raw_input", ref_id: null, label: "label-ok", derived_from: null },
              },
            ],
            attachment_ids: [],
            expected_conversation_revision: 1,
          },
          `/api/yaya/conversations/${convFull}/messages`,
        ),
        params(convFull),
      ),
    );
    check("A 完整来源正文正向可读", fullMessage.status === 201 && fullMessage.text.includes("PUBLIC_OK_BODY"));
    check("A 完整来源 provenance 保留", fullMessage.text.includes("label-ok"));
    await respond(
      conversationPatch(
        req(teacherA.token, "PATCH", { title: "DERIVED_OK_TITLE", expected_revision: 2, title_source_fragments: ["f-full"] }, `/api/yaya/conversations/${convFull}`),
        params(convFull),
      ),
    );
    const fullDetail = await respond(
      conversationGet(req(teacherA.token, "GET", undefined, `/api/yaya/conversations/${convFull}`), params(convFull)),
    );
    const fullView = fullDetail.json.conversation as Record<string, unknown>;
    check("A 可读派生标题正向可读", fullView.projected_title === "DERIVED_OK_TITLE" && fullView.title_restricted === false);

    // 删除响应同样不得携带原始标题
    const deleted = await respond(
      conversationDelete(req(teacherA.token, "DELETE", undefined, `/api/yaya/conversations/${convPrivate}?expected_revision=4`), params(convPrivate)),
    );
    check("A 删除响应不得含原始标题", deleted.status === 200 && !deleted.text.includes(PRIVATE_TITLE));
    stage("projection-a-done");

    /* ========================= B：引用写入与删除租约互斥（4 写入方 × 2 顺序） ========================= */

    const registerAttachment = async (attachmentId: string): Promise<void> => {
      await withRawTransaction(database, async (tx) => {
        await yayaDataRepository.registerAttachment(tx, {
          attachment_id: attachmentId,
          uploader_account_id: teacherA.accountId,
          conversation_id: null,
          object_key: `${RUN}/${attachmentId}`,
          media_type: "image/png",
          byte_size: 8,
          checksum_sha256: "e".repeat(64),
          source_kind: "raw_input",
          derived_from: null,
        });
      });
    };
    const appendConfirmedAt = "2026-03-01T00:00:00Z";
    const insertObservation = async (childId: string, classId: string): Promise<string> => {
      const observationId = randomUUID();
      await database.query(
        `INSERT INTO observations (id,child_id,class_id,observed_at,raw_text,status,confirmed_at)
         VALUES ($1,$2,$3,'2026-03-01','锁互斥夹具。','confirmed',$4)`,
        [observationId, childId, classId, appendConfirmedAt],
      );
      return observationId;
    };
    const createConversation = async (): Promise<string> => {
      const created = await withRawTransaction(database, (tx) =>
        yayaDataRepository.createConversation(tx, { owner_account_id: teacherA.accountId, title: null }),
      );
      return created.conversation_id;
    };

    interface Fixture {
      attachmentId: string;
      expectedLeaseRevision: number;
      run: (tx: TransactionClient) => Promise<unknown>;
      referenceQuery: () => Promise<number>;
      attachmentStatusQuery: () => Promise<string | null>;
    }

    const buildFixture = async (
      kind: WriterKind,
      index: number,
      options: { attachmentIds?: string[]; expectedLeaseRevision?: number } = {},
    ): Promise<Fixture> => {
      const attachmentId = randomUUID();
      await registerAttachment(attachmentId);
      const conversationId = await createConversation();
      const observationId = kind === "appendObservation" || kind === "linkRef" ? await insertObservation(childA, classA) : obsA;
      let run: (tx: TransactionClient) => Promise<unknown>;
      if (kind === "saveMessage") {
        const ids = options.attachmentIds ?? [attachmentId];
        const extraIds = ids.filter((id) => id !== attachmentId);
        for (const extra of extraIds) await registerAttachment(extra);
        run = (tx) =>
          yayaDataRepository.saveMessage(tx, teacherA.principal, "single-school", {
            conversation_id: conversationId,
            client_message_id: `r1-${kind}-${index}`,
            role: "user",
            message_kind: "image",
            execution_state: "none",
            fragments: [],
            attachment_ids: ids,
            expected_conversation_revision: 1,
          });
      } else if (kind === "prepareProposal") {
        run = (tx) =>
          yayaDataRepository.prepareProposal(tx, {
            conversation_id: conversationId,
            proposal_origin: "teacher_card",
            auth: { kind: "action", action: "observation.confirm", resource: "observation" },
            items: [
              {
                item_key: `r1-${kind}-${index}`,
                target_id: observationId,
                action: "observation.confirm",
                resource: "observation",
                resource_ref: { kind: "observation", observation_id: observationId },
                payload: { kind: "organize_observation", observation_id: observationId },
                attachment_associations: [{ attachment_id: attachmentId, target_id: observationId }],
                business_revision: null,
              },
            ],
            owner_account_id: teacherA.accountId,
          });
      } else if (kind === "appendObservation") {
        run = (tx) =>
          yayaDataRepository.appendObservationAttachments(tx, {
            observation_id: observationId,
            attachment_ids: [attachmentId],
            expected_attachment_revision: 0,
            appended_by_account_id: teacherA.accountId,
            approval_id: null,
            note: null,
            source_confirmed_at: appendConfirmedAt,
          });
      } else {
        run = (tx) =>
          yayaDataRepository.linkAttachmentRef(tx, {
            attachment_id: attachmentId,
            record_kind: "observation",
            record_id: observationId,
            linked_by_account_id: teacherA.accountId,
          });
      }
      const referenceQuery = async (): Promise<number> => {
        const rows = await poolQueryFor<{ count: string }>(
          containerUrl,
          kind === "linkRef" || kind === "appendObservation"
            ? "SELECT count(*)::text AS count FROM yaya_attachment_refs WHERE attachment_id = $1 AND record_kind = 'observation'"
            : kind === "prepareProposal"
              ? "SELECT count(*)::text AS count FROM yaya_attachment_refs WHERE attachment_id = $1 AND record_kind = 'proposal'"
              : "SELECT count(*)::text AS count FROM yaya_attachment_refs WHERE attachment_id = $1 AND record_kind = 'message'",
          [attachmentId],
        );
        return Number(rows[0]?.count ?? 0);
      };
      const attachmentStatusQuery = async (): Promise<string | null> => {
        const rows = await poolQueryFor<{ status: string }>(
          containerUrl,
          "SELECT status FROM yaya_attachments WHERE id = $1",
          [attachmentId],
        );
        return rows[0]?.status ?? null;
      };
      return {
        attachmentId,
        expectedLeaseRevision: options.expectedLeaseRevision ?? 1,
        run,
        referenceQuery,
        attachmentStatusQuery,
      };
    };

    const leaseCall = (fixture: Fixture) => {
      const client = clientFor(containerUrl);
      return client
        .connect()
        .then(() =>
          withRawTransaction(client, (tx) =>
            beginAttachmentDeletion(tx, {
              attachment_id: fixture.attachmentId,
              expected_revision: fixture.expectedLeaseRevision,
              actor_account_id: teacherA.accountId,
            }),
          ),
        )
        .finally(() => client.end().catch(() => undefined));
    };

    for (const kind of ["saveMessage", "prepareProposal", "appendObservation", "linkRef"] as const) {
      // 顺序 1：引用写入先成立（未提交），租约必须在附件行锁上等待且最终因引用被拒
      const writerFixture = await buildFixture(kind, 1);
      const writer = clientFor(containerUrl);
      await writer.connect();
      await writer.query("BEGIN");
      await writerFixture.run(writer as unknown as TransactionClient);
      const leaseContender = startAttempt(() => leaseCall(writerFixture));
      await new Promise((resolve) => setTimeout(resolve, 300));
      check(`${kind}/引用先成立：租约必须等待引用写入持锁`, leaseContender.state === "pending");
      await writer.query("COMMIT");
      await writer.end();
      await leaseContender.promise;
      check(`${kind}/引用先成立：租约最终被引用拒绝`, errorCode(leaseContender.error) === "attachment_referenced");
      check(`${kind}/引用先成立：引用已提交`, (await writerFixture.referenceQuery()) === 1);
      check(`${kind}/引用先成立：附件不得被回收`, (await writerFixture.attachmentStatusQuery()) === "ready");

      // 顺序 2：租约先成立（未提交），引用写入必须等待且在租约提交后被拒
      const leaseFixture = await buildFixture(kind, 2);
      const holder = clientFor(containerUrl);
      await holder.connect();
      await holder.query("BEGIN");
      await beginAttachmentDeletion(holder as unknown as TransactionClient, {
        attachment_id: leaseFixture.attachmentId,
        expected_revision: leaseFixture.expectedLeaseRevision,
        actor_account_id: teacherA.accountId,
      });
      const writerAttempt = startAttempt(async () => {
        const client = clientFor(containerUrl);
        await client.connect();
        try {
          return await withRawTransaction(client, (tx) => leaseFixture.run(tx));
        } finally {
          await client.end().catch(() => undefined);
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      check(`${kind}/租约先成立：引用写入必须等待租约持锁`, writerAttempt.state === "pending");
      await holder.query("COMMIT");
      await holder.end();
      await writerAttempt.promise;
      check(`${kind}/租约先成立：引用写入被拒绝`, errorCode(writerAttempt.error) === "attachment_conflict");
      check(`${kind}/租约先成立：不得留下半条引用`, (await leaseFixture.referenceQuery()) === 0);
      check(`${kind}/租约先成立：附件保持 deleting`, (await leaseFixture.attachmentStatusQuery()) === "deleting");
    }

    // 多附件稳定锁序：租约在第二个附件上，写入把该附件排在输入最后，仍必须等待（不并发死锁）
    const multiBase = randomUUID();
    await registerAttachment(multiBase);
    const multiLate = randomUUID();
    await registerAttachment(multiLate);
    const multiConversation = await createConversation();
    const multiHolder = clientFor(containerUrl);
    await multiHolder.connect();
    await multiHolder.query("BEGIN");
    await beginAttachmentDeletion(multiHolder as unknown as TransactionClient, {
      attachment_id: multiLate,
      expected_revision: 1,
      actor_account_id: teacherA.accountId,
    });
    const multiWriter = startAttempt(async () => {
      const client = clientFor(containerUrl);
      await client.connect();
      try {
        return await withRawTransaction(client, (tx) =>
          yayaDataRepository.saveMessage(tx, teacherA.principal, "single-school", {
            conversation_id: multiConversation,
            client_message_id: "r1-multi",
            role: "user",
            message_kind: "image",
            execution_state: "none",
            fragments: [],
            attachment_ids: [multiLate, multiBase],
            expected_conversation_revision: 1,
          }),
        );
      } finally {
        await client.end().catch(() => undefined);
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    check("多附件锁序：输入逆序写入仍在租约锁上等待", multiWriter.state === "pending");
    await multiHolder.query("COMMIT");
    await multiHolder.end();
    await multiWriter.promise;
    check("多附件锁序：租约提交后整体拒绝", errorCode(multiWriter.error) === "attachment_conflict");
    check(
      "多附件锁序：不得留下半条消息/引用",
      (
        await poolQueryFor<{ count: string }>(
          containerUrl,
          "SELECT count(*)::text AS count FROM yaya_attachment_refs WHERE record_id IN (SELECT id FROM yaya_messages WHERE client_message_id = 'r1-multi')",
        )
      )[0]?.count === "0",
    );
    stage("lock-b-done");

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
  console.log(
    JSON.stringify({ passed, total: passed + failures.length, failures, r1: true, run_id: RUN }),
  );
  assert.equal(failures.length, 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
