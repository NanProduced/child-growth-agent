/**
 * YAYA-DATA1 隔离 PostgreSQL 验收（真实 HTTP 路由与真实事务，无模型/搜索/S3/托管库）。
 *
 * 使用已获批 harness（scripts/harness-safety.ts）的一次性 Docker 容器：
 * - 迁移重复执行 + 现有业务表零变化；
 * - 账号私有路由真实 HTTP（NextRequest + Cookie/Origin/CSRF）；
 * - 真实业务 callback 写入与故障整单回滚；
 * - 两个真实连接按锁顺序受控交错：替代 vs 旧消费；
 * - 删除会话解除引用与新引用租约冲突。
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
import type { YayaApprovalSubmitter } from "../../src/lib/yaya/types";
import type {
  YayaExecuteApprovedInput,
  YayaPrepareItemInput,
} from "../../src/lib/yaya/storage-types";
import { executeApprovedOperations, supersedeWithReplacement } from "../../src/lib/yaya/data/operations";
import { yayaDataRepository } from "../../src/lib/yaya/data";
import { GET as conversationsGet, POST as conversationsPost } from "../../src/app/api/yaya/conversations/route";
import { DELETE as conversationDelete, GET as conversationGet, PATCH as conversationPatch } from "../../src/app/api/yaya/conversations/[id]/route";
import { GET as messagesGet, POST as messagesPost } from "../../src/app/api/yaya/conversations/[id]/messages/route";
import { GET as proposalsGet, POST as proposalsPost } from "../../src/app/api/yaya/proposals/route";
import { POST as approvalPost } from "../../src/app/api/yaya/proposals/[id]/approval/route";
import { GET as operationsGet } from "../../src/app/api/yaya/operations/route";
import type { TransactionClient } from "../../src/storage/database/pg-client";

const RUN = `data1-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ORIGIN = "http://data1-check.invalid";
const ids = {
  classA: randomUUID(),
  classB: randomUUID(),
  classC: randomUUID(),
  childA: randomUUID(),
  childM: randomUUID(),
  childC: randomUUID(),
  obsA: randomUUID(),
  obsM: randomUUID(),
  convA: "",
  convB: "",
  convD: "",
  attD: randomUUID(),
  attE: randomUUID(),
  attD2: randomUUID(),
  attE2: randomUUID(),
  attF: randomUUID(),
};

let passed = 0;
const evidence: string[] = [];
function check(label: string, condition: unknown): void {
  assert.ok(condition, label);
  passed += 1;
}
function note(label: string): void {
  evidence.push(label);
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
async function statusOf(response: Promise<Response>, expected: number): Promise<Record<string, unknown>> {
  const result = await response;
  const body: unknown = await result.json();
  assert.equal(result.status, expected, JSON.stringify(body));
  return body as Record<string, unknown>;
}

interface Session {
  accountId: string;
  token: string;
  sessionId: string;
  principal: Principal;
}
async function createSession(
  db: Client,
  name: string,
  role: "teacher" | "admin",
  classIds: string[],
): Promise<Session> {
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
    await db.query("INSERT INTO teacher_class_assignments (account_id, class_id) VALUES ($1,$2)", [
      accountId,
      classId,
    ]);
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

function submitter(session: Session, executionAt: string): YayaApprovalSubmitter {
  return {
    identity_state: "authenticated",
    principal: session.principal,
    session_id: session.sessionId,
    session_valid: true,
    csrf_verified: true,
    runtime_approved_state: false,
    execution_at: executionAt,
  };
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

async function expectDataError(work: () => Promise<unknown>, code: string, reason?: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    const candidate = error as { name?: string; code?: string; details?: { reasons?: string[] } };
    assert.equal(candidate.name, "YayaDataError", `expected YayaDataError, got ${String(error)}`);
    assert.equal(candidate.code, code);
    if (reason) assert.ok(candidate.details?.reasons?.includes(reason), `missing reason ${reason}`);
    return true;
  });
  passed += 1;
}

async function poolQueryFor<T>(url: string, sql: string, paramsList: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(sql, paramsList);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

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
      dbName: `cga_data1_${process.pid}`,
      labelKey: "child-growth-agent.data1",
      noteIssue: (label, detail) => cleanupIssues.push(`${label}: ${detail}`),
    });
    process.env.DATABASE_URL = isolated.url;
    delete process.env.PGDATABASE_URL;
    process.env.AUTH_TRUSTED_ORIGINS = ORIGIN;
    db = new Client({ connectionString: isolated.url });
    await db.connect();
    const database = db;
    const container = isolated;
    stage("db-ready");

    /* ------------------------- 迁移与现有表零变化 ------------------------- */
    const baselineTables = [
      "observations",
      "children",
      "classes",
      "child_class_enrollments",
      "app_accounts",
      "app_sessions",
      "teacher_class_assignments",
    ];
    const columnsOf = async (table: string): Promise<string> =>
      (
        await database.query<{ signature: string }>(
          `SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) AS signature
             FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
          [table],
        )
      ).rows[0]?.signature ?? "missing";

    await database.query(fs.readFileSync(`${ROOT}scripts/initialize-demo-db.sql`, "utf8"));
    await database.query(fs.readFileSync(`${ROOT}scripts/upgrade-auth-v1.sql`, "utf8"));
    // 业务表形状基线在 yaya 迁移之前采集（此时表已存在）
    const baseline = new Map<string, string>();
    for (const table of baselineTables) baseline.set(table, await columnsOf(table));
    const yayaSql = fs.readFileSync(`${ROOT}scripts/upgrade-yaya-v1.sql`, "utf8");
    await database.query(yayaSql);
    await database.query(yayaSql); // 幂等重复执行
    for (const table of baselineTables) {
      assert.equal(await columnsOf(table), baseline.get(table), `现有表 ${table} 形状被改动`);
    }
    passed += 1;
    note("migration_applied_twice");
    stage("migration-ok");
    const yayaTables = [
      "yaya_conversations",
      "yaya_messages",
      "yaya_proposals",
      "yaya_proposal_items",
      "yaya_approvals",
      "yaya_operations",
      "yaya_attachments",
      "yaya_attachment_refs",
      "yaya_observation_attachment_meta",
      "yaya_attachment_appends",
    ];
    for (const table of yayaTables) {
      const found = await database.query("SELECT to_regclass($1) AS rel", [`public.${table}`]);
      check(`yaya 表存在：${table}`, found.rows[0]?.rel === table);
    }

    /* ------------------------- 种子数据 ------------------------- */
    for (const [id, name] of [
      [ids.classA, "Data1 A"],
      [ids.classB, "Data1 B"],
      [ids.classC, "Data1 C"],
    ] as const) {
      await database.query("INSERT INTO classes (id,name,stage,school_year) VALUES ($1,$2,'small','2026')", [id, name]);
    }
    for (const [childId, classId] of [
      [ids.childA, ids.classA],
      [ids.childM, ids.classA],
      [ids.childC, ids.classC],
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
      [ids.obsA, ids.childA, ids.classA],
      [ids.obsM, ids.childM, ids.classA],
    ] as const) {
      await database.query(
        `INSERT INTO observations (id,child_id,class_id,observed_at,raw_text,status)
         VALUES ($1,$2,$3,'2026-01-02','幼儿把积木放在一起。','ai_organized')`,
        [observationId, childId, classId],
      );
    }
    const teacherA = await createSession(db, "a", "teacher", [ids.classA, ids.classB]);
    const teacherB = await createSession(db, "b", "teacher", [ids.classB]);
    const teacherC = await createSession(db, "c", "teacher", [ids.classC]);
    const admin = await createSession(db, "admin", "admin", []);
    note("seeded_accounts");
    stage("seeds-ok");

    /* ------------------------- 私有路由守门 ------------------------- */
    await statusOf(conversationsGet(req(null, "GET", undefined, "/api/yaya/conversations")), 401);
    await statusOf(conversationsPost(req(teacherA.token, "POST", { title: null }, "/api/yaya/conversations", { "x-csrf-token": "" })), 403);
    await statusOf(
      conversationsPost(req(teacherA.token, "POST", { title: null }, "/api/yaya/conversations", { origin: "null" })),
      403,
    );
    passed += 4;

    stage("auth-guard-ok");
    /* ------------------------- 会话 CRUD 与 owner 边界 ------------------------- */
    const created = await statusOf(
      conversationsPost(req(teacherA.token, "POST", { title: null }, "/api/yaya/conversations")),
      201,
    );
    const conversationA = created.conversation as Record<string, unknown>;
    ids.convA = conversationA.conversation_id as string;
    check("创建会话 owner 为当前账号", conversationA.owner_account_id === teacherA.accountId);
    check("创建会话初始 revision=1", conversationA.revision === 1);

    const renamed = await statusOf(
      conversationPatch(
        req(teacherA.token, "PATCH", { title: "积木观察", expected_revision: 1 }, `/api/yaya/conversations/${ids.convA}`),
        params(ids.convA),
      ),
      200,
    );
    check("改名后 revision=2", (renamed.conversation as Record<string, unknown>).revision === 2);
    await statusOf(
      conversationPatch(
        req(teacherA.token, "PATCH", { title: "过期改名", expected_revision: 1 }, `/api/yaya/conversations/${ids.convA}`),
        params(ids.convA),
      ),
      409,
    );
    passed += 3;

    const other = await statusOf(
      conversationGet(req(teacherB.token, "GET", undefined, `/api/yaya/conversations/${ids.convA}`), params(ids.convA)),
      404,
    );
    check("他人会话标题不泄漏", !JSON.stringify(other).includes("积木观察"));
    await statusOf(
      conversationPatch(
        req(teacherB.token, "PATCH", { title: "劫持", expected_revision: 2 }, `/api/yaya/conversations/${ids.convA}`),
        params(ids.convA),
      ),
      404,
    );
    const adminRead = await statusOf(
      conversationGet(req(admin.token, "GET", undefined, `/api/yaya/conversations/${ids.convA}`), params(ids.convA)),
      404,
    );
    check("管理员不自动拥有他人聊天", !JSON.stringify(adminRead).includes("积木观察"));
    passed += 4;

    stage("conversations-ok");
    /* ------------------------- 消息幂等、版本前提与投影 ------------------------- */
    const fragmentBase = {
      fragment_id: "f-1",
      text: "幼儿把积木放在一起。",
      sources: [{ kind: "child", child_id: ids.childA, current_class_id: null }],
      independently_readable: true,
      provenance: { kind: "raw_input", ref_id: null, label: null, derived_from: null },
    };
    const messageBody = {
      client_message_id: "m-1",
      role: "user",
      message_kind: "text",
      fragments: [fragmentBase],
      attachment_ids: [],
      expected_conversation_revision: 2,
    };
    const savedMessage = await statusOf(
      messagesPost(req(teacherA.token, "POST", messageBody, `/api/yaya/conversations/${ids.convA}/messages`), params(ids.convA)),
      201,
    );
    check("首次保存 replayed=false", savedMessage.replayed === false);
    check(
      "保存后会话 revision=3",
      (savedMessage.conversation as Record<string, unknown>).revision === 3,
    );
    const replay = await statusOf(
      messagesPost(req(teacherA.token, "POST", messageBody, `/api/yaya/conversations/${ids.convA}/messages`), params(ids.convA)),
      201,
    );
    check("client_message_id 幂等命中", replay.replayed === true);
    check("幂等命中不递增 revision", (replay.conversation as Record<string, unknown>).revision === 3);
    await statusOf(
      messagesPost(
        req(teacherA.token, "POST", { ...messageBody, fragments: [{ ...fragmentBase, text: "内容被改" }] }, `/api/yaya/conversations/${ids.convA}/messages`),
        params(ids.convA),
      ),
      409,
    );
    await statusOf(
      messagesPost(
        req(teacherA.token, "POST", { ...messageBody, client_message_id: "m-2", expected_conversation_revision: 2 }, `/api/yaya/conversations/${ids.convA}/messages`),
        params(ids.convA),
      ),
      409,
    );
    await statusOf(
      messagesPost(
        req(teacherA.token, "POST", { ...messageBody, client_message_id: "m-3", fragments: [{ ...fragmentBase, provenance: null }] }, `/api/yaya/conversations/${ids.convA}/messages`),
        params(ids.convA),
      ),
      400,
    );
    passed += 6;

    const ownList = await statusOf(
      messagesGet(req(teacherA.token, "GET", undefined, `/api/yaya/conversations/${ids.convA}/messages`), params(ids.convA)),
      200,
    );
    const ownMessages = ownList.messages as Record<string, unknown>[];
    check("owner 读到完整正文", JSON.stringify(ownMessages).includes("幼儿把积木放在一起。"));
    check("消息本体含投影与白名单元数据", typeof ownMessages[0]?.projection === "object");
    await statusOf(
      messagesGet(req(teacherB.token, "GET", undefined, `/api/yaya/conversations/${ids.convA}/messages`), params(ids.convA)),
      404,
    );
    passed += 3;

    // 来源越权：A 的会话引用 C 班幼儿 → 片段 denied，正文不出现
    const convC = await statusOf(
      conversationsPost(req(teacherA.token, "POST", { title: "跨班来源" }, "/api/yaya/conversations")),
      201,
    );
    const deniedConversationId = (convC.conversation as Record<string, unknown>).conversation_id as string;
    const deniedMessage = await statusOf(
      messagesPost(
        req(
          teacherA.token,
          "POST",
          {
            client_message_id: "m-denied",
            role: "assistant",
            message_kind: "text",
            fragments: [
              {
                fragment_id: "f-denied",
                text: "C 班幼儿的秘密正文",
                sources: [{ kind: "child", child_id: ids.childC, current_class_id: null }],
                independently_readable: true,
                provenance: { kind: "child_fact", ref_id: ids.childC, label: null, derived_from: null },
              },
            ],
            attachment_ids: [],
            expected_conversation_revision: 1,
          },
          `/api/yaya/conversations/${deniedConversationId}/messages`,
        ),
        params(deniedConversationId),
      ),
      201,
    );
    const deniedView = deniedMessage.message as Record<string, unknown>;
    check("越权来源正文不外泄", !JSON.stringify(deniedView).includes("C 班幼儿的秘密正文"));
    check(
      "越权来源片段 visibility 非 full",
      (deniedView.fragments as { visibility: string; text: string | null }[]).every(
        (fragment) => fragment.visibility !== "full" && fragment.text === null,
      ),
    );
    passed += 2;

    stage("messages-projection-ok");
    /* ------------------------- 附件引用与消息 ------------------------- */
    await withRawTransaction(db, async (tx) => {
      await yayaDataRepository.registerAttachment(tx, {
        attachment_id: ids.attD,
        uploader_account_id: teacherA.accountId,
        conversation_id: ids.convA,
        object_key: `${RUN}/att-d`,
        media_type: "image/png",
        byte_size: 12,
        checksum_sha256: "a".repeat(64),
        source_kind: "raw_input",
        derived_from: null,
      });
      await yayaDataRepository.registerAttachment(tx, {
        attachment_id: ids.attE,
        uploader_account_id: teacherA.accountId,
        conversation_id: ids.convA,
        object_key: `${RUN}/att-e`,
        media_type: "image/png",
        byte_size: 12,
        checksum_sha256: "b".repeat(64),
        source_kind: "raw_input",
        derived_from: null,
      });
      await yayaDataRepository.registerAttachment(tx, {
        attachment_id: ids.attF,
        uploader_account_id: teacherA.accountId,
        conversation_id: ids.convA,
        object_key: `${RUN}/att-f`,
        media_type: "image/png",
        byte_size: 12,
        checksum_sha256: "e".repeat(64),
        source_kind: "teacher_supplement",
        derived_from: null,
      });
    });
    await statusOf(
      messagesPost(
        req(
          teacherA.token,
          "POST",
          {
            client_message_id: "m-att",
            role: "user",
            message_kind: "image",
            fragments: [],
            attachment_ids: [ids.attD],
            expected_conversation_revision: 3,
          },
          `/api/yaya/conversations/${ids.convA}/messages`,
        ),
        params(ids.convA),
      ),
      201,
    );
    const refsForMessage = await poolQueryFor<{ count: string }>(
      container.url,
      "SELECT count(*)::text AS count FROM yaya_attachment_refs WHERE attachment_id = $1 AND record_kind = 'message'",
      [ids.attD],
    );
    check("消息附件建立引用", Number(refsForMessage[0]?.count ?? 0) === 1);
    await statusOf(
      messagesPost(
        req(
          teacherA.token,
          "POST",
          {
            client_message_id: "m-att-other",
            role: "user",
            message_kind: "image",
            fragments: [],
            attachment_ids: [ids.attD],
            expected_conversation_revision: 4,
          },
          `/api/yaya/conversations/${ids.convA}/messages`,
        ),
        params(ids.convA),
      ),
      201,
    );
    passed += 2;

    stage("attachments-messages-ok");
    /* ------------------------- prepare / approve ------------------------- */
    const prepareBody = (conversationId: string, item: unknown) => ({
      conversation_id: conversationId,
      proposal_origin: "teacher_card",
      auth: { kind: "action", action: "observation.confirm", resource: "observation" },
      items: [item],
    });
    const confirmItem: YayaPrepareItemInput = {
      item_key: "confirm-1",
      target_id: ids.obsA,
      action: "observation.confirm",
      resource: "observation",
      resource_ref: { kind: "observation", observation_id: ids.obsA },
      payload: { kind: "organize_observation", observation_id: ids.obsA },
      attachment_associations: [],
      business_revision: null,
    };
    const prepared = await statusOf(
      proposalsPost(req(teacherA.token, "POST", prepareBody(ids.convA, confirmItem), "/api/yaya/proposals")),
      201,
    );
    const proposal = prepared.proposal as {
      proposal_id: string;
      batch_id: string;
      items: { operation_id: string; item_key: string }[];
    };
    check("prepare 预分配 proposal/batch/operation 身份", Boolean(proposal.proposal_id && proposal.batch_id && proposal.items[0]?.operation_id));
    const operationId = proposal.items[0]!.operation_id;
    const plannedQuery = await statusOf(
      operationsGet(req(teacherA.token, "GET", undefined, `/api/yaya/operations?operation_id=${operationId}`)),
      200,
    );
    const plannedOutcome = plannedQuery.operation as { outcome: { kind: string }; status: null | string };
    check("planned 操作查询为 unknown(no_receipt)", plannedOutcome.outcome.kind === "unknown" && plannedOutcome.status === null);
    const forgedApproval = await statusOf(
      approvalPost(
        req(
          teacherA.token,
          "POST",
          {
            action: "approve",
            operation_ids: [operationId],
            approved: true,
            approval_source: "authenticated_entry",
            principal: { account_id: "attacker" },
            actor_account_id: "attacker",
            scope: "school",
            content_digest: "forged",
          },
          `/api/yaya/proposals/${proposal.proposal_id}/approval`,
        ),
        params(proposal.proposal_id),
      ),
      201,
    );
    const approval = forgedApproval.approval as {
      approval_id: string;
      actor_account_id: string;
      items: { resource_facts_at_approval: { current_class_id: string | null }; operation_id: string }[];
    };
    check("批准 actor 来自服务端会话", approval.actor_account_id === teacherA.accountId);
    check(
      "批准资源事实为服务端当前读取",
      approval.items[0]?.resource_facts_at_approval.current_class_id === ids.classA,
    );
    const approvalRow = await poolQueryFor<{ approval_source: string; session_id: string }>(
      container.url,
      "SELECT approval_source, session_id FROM yaya_approvals WHERE id = $1",
      [approval.approval_id],
    );
    check("approval_source 服务端固定为 authenticated_entry", approvalRow[0]?.approval_source === "authenticated_entry");
    check("批准绑定原 session", approvalRow[0]?.session_id === teacherA.sessionId);
    passed += 6;

    stage("prepare-approve-ok");
    /* ------------------------- 真实 callback 写入与重放 ------------------------- */
    let callbackCount = 0;
    const executedObservationId = randomUUID();
    const executeOnce = async (overrides: Partial<YayaExecuteApprovedInput> = {}) => {
      const client = new Client({ connectionString: container.url });
      await client.connect();
      try {
        return await withRawTransaction(client, (tx) =>
          executeApprovedOperations(tx, {
            approval_id: approval.approval_id,
            operation_ids: [operationId],
            submitter: submitter(teacherA, new Date().toISOString()),
            school_id: "single-school",
            callback: async (txClient) => {
              callbackCount += 1;
              await txClient.query(
                `INSERT INTO observations (id,child_id,class_id,observed_at,raw_text,status)
                 VALUES ($1,$2,$3,'2026-02-01','回调写入。','confirmed')`,
                [executedObservationId, ids.childA, ids.classA],
              );
              return {
                status: "saved",
                effect: "committed",
                business_object_id: executedObservationId,
                business_revision: null,
              };
            },
            ...overrides,
          }),
        );
      } finally {
        await client.end();
      }
    };
    const receipts = await executeOnce();
    check("执行返回 saved 回执与业务 id", receipts.length === 1 && receipts[0]?.business_object_id === executedObservationId);
    const written = await poolQueryFor<{ count: string }>(
      container.url,
      "SELECT count(*)::text AS count FROM observations WHERE id = $1",
      [executedObservationId],
    );
    check("真实 callback 业务写入提交", Number(written[0]?.count ?? 0) === 1);
    const replayed = await executeOnce();
    check("重复执行返回原回执", replayed[0]?.business_object_id === executedObservationId);
    check("重复执行不再调用 callback", callbackCount === 1);
    const consumed = await poolQueryFor<{ consumed_at: string | null }>(
      container.url,
      "SELECT consumed_at::text AS consumed_at FROM yaya_approvals WHERE id = $1",
      [approval.approval_id],
    );
    check("批准被原子消费", consumed[0]?.consumed_at !== null);
    const recovery = await statusOf(
      operationsGet(req(teacherA.token, "GET", undefined, `/api/yaya/operations?operation_id=${operationId}`)),
      200,
    );
    check(
      "响应丢失后按原 operation_id 恢复为 saved",
      (recovery.operation as { outcome: { kind: string } }).outcome.kind === "saved",
    );
    const otherRead = await statusOf(
      operationsGet(req(teacherB.token, "GET", undefined, `/api/yaya/operations?operation_id=${operationId}`)),
      404,
    );
    check("非 owner 读回不得看到他人操作", otherRead.error === "operation_not_found");
    passed += 8;

    stage("execute-ok");
    /* ------------------------- 故障整单回滚 ------------------------- */
    const rollbackProposal = await statusOf(
      proposalsPost(req(teacherA.token, "POST", prepareBody(ids.convA, { ...confirmItem, item_key: "confirm-rb" }), "/api/yaya/proposals")),
      201,
    );
    const rollbackProposalId = (rollbackProposal.proposal as { proposal_id: string }).proposal_id;
    const rollbackOperationId = (rollbackProposal.proposal as { items: { operation_id: string }[] }).items[0]!.operation_id;
    const rollbackApproval = await statusOf(
      approvalPost(
        req(teacherA.token, "POST", { action: "approve", operation_ids: [rollbackOperationId] }, `/api/yaya/proposals/${rollbackProposalId}/approval`),
        params(rollbackProposalId),
      ),
      201,
    );
    const rollbackApprovalId = (rollbackApproval.approval as { approval_id: string }).approval_id;
    const doomedObservationId = randomUUID();
    const rollbackClient = new Client({ connectionString: container.url });
    await rollbackClient.connect();
    await assert.rejects(
      withRawTransaction(rollbackClient, (tx) =>
        executeApprovedOperations(tx, {
          approval_id: rollbackApprovalId,
          operation_ids: [rollbackOperationId],
          submitter: submitter(teacherA, new Date().toISOString()),
          school_id: "single-school",
          callback: async (txClient) => {
            await txClient.query(
              `INSERT INTO observations (id,child_id,class_id,observed_at,raw_text,status)
               VALUES ($1,$2,$3,'2026-02-02','必须回滚。','confirmed')`,
              [doomedObservationId, ids.childA, ids.classA],
            );
            throw new Error("callback 故障");
          },
        }),
      ),
    );
    await rollbackClient.end();
    passed += 1;
    const rolledBack = await poolQueryFor<{ observations: string; consumed_at: string | null; started_at: string | null }>(
      container.url,
      `SELECT
         (SELECT count(*)::text FROM observations WHERE id = $1) AS observations,
         (SELECT consumed_at::text FROM yaya_approvals WHERE id = $2) AS consumed_at,
         (SELECT started_at::text FROM yaya_operations WHERE operation_id = $3) AS started_at`,
      [doomedObservationId, rollbackApprovalId, rollbackOperationId],
    );
    check("callback 故障回滚业务写入", Number(rolledBack[0]?.observations ?? 0) === 0);
    check("callback 故障回滚批准消费", rolledBack[0]?.consumed_at === null);
    check("callback 故障回滚执行开始", rolledBack[0]?.started_at === null);

    // 回执证明不完整：真实写入后返回无效成功 → 整单回滚
    const badProofObservationId = randomUUID();
    const badProofClient = new Client({ connectionString: container.url });
    await badProofClient.connect();
    await expectDataError(
      () =>
        withRawTransaction(badProofClient, (tx) =>
          executeApprovedOperations(tx, {
            approval_id: rollbackApprovalId,
            operation_ids: [rollbackOperationId],
            submitter: submitter(teacherA, new Date().toISOString()),
            school_id: "single-school",
            callback: async (txClient) => {
              await txClient.query(
                `INSERT INTO observations (id,child_id,class_id,observed_at,raw_text,status)
                 VALUES ($1,$2,$3,'2026-02-03','假成功。','draft')`,
                [badProofObservationId, ids.childA, ids.classA],
              );
              return {
                status: "saved",
                effect: "unknown",
                business_object_id: badProofObservationId,
                business_revision: null,
              };
            },
          }),
        ),
      "operation_unknown",
    );
    await badProofClient.end();
    const badProofRolledBack = await poolQueryFor<{ count: string }>(
      container.url,
      "SELECT count(*)::text AS count FROM observations WHERE id = $1",
      [badProofObservationId],
    );
    check("无效成功证明不得落账且整单回滚", Number(badProofRolledBack[0]?.count ?? 0) === 0);

    stage("rollback-ok");
    /* ------------------------- 内容变化 / 转班 / 取消 / 跨 session ------------------------- */
    const mutateBeforeExecute = async (
      itemKey: string,
      action: string,
      resource: string,
      ref: Record<string, unknown>,
      targetId: string,
      mutate?: (proposalId: string) => Promise<void>,
    ) => {
      const preparedBody = {
        conversation_id: ids.convA,
        proposal_origin: "model_suggestion",
        auth: { kind: "action", action, resource },
        items: [
          {
            item_key: itemKey,
            target_id: targetId,
            action,
            resource,
            resource_ref: ref,
            payload:
              action === "observation.write"
                ? {
                    kind: "create_observation",
                    child_id: targetId,
                    observed_at: "2026-02-04",
                    raw_text: "转班测试。",
                    context: null,
                    confirmed_class_id: null,
                    image_ids: [],
                    source_input: null,
                  }
                : { kind: "organize_observation", observation_id: targetId },
            attachment_associations: [],
            business_revision: null,
          },
        ],
      };
      const preparedResponse = await statusOf(proposalsPost(req(teacherA.token, "POST", preparedBody, "/api/yaya/proposals")), 201);
      const proposalId = (preparedResponse.proposal as { proposal_id: string }).proposal_id;
      const opId = (preparedResponse.proposal as { items: { operation_id: string }[] }).items[0]!.operation_id;
      const approvalResponse = await statusOf(
        approvalPost(req(teacherA.token, "POST", { action: "approve", operation_ids: [opId] }, `/api/yaya/proposals/${proposalId}/approval`), params(proposalId)),
        201,
      );
      const approvalId = (approvalResponse.approval as { approval_id: string }).approval_id;
      if (mutate) await mutate(proposalId);
      return { proposalId, opId, approvalId };
    };

    // 同权转班：A 同时拥有 A/B 班，childM 从 A 转到 B 后旧批准失效
    const transferCase = await mutateBeforeExecute(
      "transfer-1",
      "observation.write",
      "child",
      { kind: "child", child_id: ids.childM },
      ids.childM,
      async () => {
        await database.query(
          "UPDATE child_class_enrollments SET end_date = '2026-02-01' WHERE child_id = $1 AND end_date IS NULL",
          [ids.childM],
        );
        await database.query(
          "INSERT INTO child_class_enrollments (child_id,class_id,start_date) VALUES ($1,$2,'2026-02-01')",
          [ids.childM, ids.classB],
        );
      },
    );
    await expectDataError(
      async () => {
        const client = new Client({ connectionString: container.url });
        await client.connect();
        try {
          await withRawTransaction(client, (tx) =>
            executeApprovedOperations(tx, {
              approval_id: transferCase.approvalId,
              operation_ids: [transferCase.opId],
              submitter: submitter(teacherA, new Date().toISOString()),
              school_id: "single-school",
              callback: async () => ({
                status: "saved",
                effect: "committed",
                business_object_id: randomUUID(),
                business_revision: null,
              }),
            }),
          );
        } finally {
          await client.end();
        }
      },
      "approval_invalid",
      "attribution_changed",
    );

    // 批准后内容变化：直接篡改存储 payload，执行前重算 digest 不一致
    const contentCase = await mutateBeforeExecute(
      "content-1",
      "observation.confirm",
      "observation",
      { kind: "observation", observation_id: ids.obsM },
      ids.obsM,
      async (proposalId) => {
        await database.query(
          "UPDATE yaya_proposal_items SET payload = payload || '{\"tampered\":true}'::jsonb WHERE proposal_id = $1",
          [proposalId],
        );
      },
    );
    await expectDataError(
      async () => {
        const client = new Client({ connectionString: container.url });
        await client.connect();
        try {
          await withRawTransaction(client, (tx) =>
            executeApprovedOperations(tx, {
              approval_id: contentCase.approvalId,
              operation_ids: [contentCase.opId],
              submitter: submitter(teacherA, new Date().toISOString()),
              school_id: "single-school",
              callback: async () => ({
                status: "saved",
                effect: "committed",
                business_object_id: randomUUID(),
                business_revision: null,
              }),
            }),
          );
        } finally {
          await client.end();
        }
      },
      "approval_invalid",
      "content_changed",
    );

    // 取消：批准取消后迟到执行拒绝
    const cancelCase = await mutateBeforeExecute(
      "cancel-1",
      "observation.confirm",
      "observation",
      { kind: "observation", observation_id: ids.obsA },
      ids.obsA,
    );
    await statusOf(
      approvalPost(
        req(teacherA.token, "POST", { action: "cancel" }, `/api/yaya/proposals/${cancelCase.proposalId}/approval`),
        params(cancelCase.proposalId),
      ),
      200,
    );
    await expectDataError(
      async () => {
        const client = new Client({ connectionString: container.url });
        await client.connect();
        try {
          await withRawTransaction(client, (tx) =>
            executeApprovedOperations(tx, {
              approval_id: cancelCase.approvalId,
              operation_ids: [cancelCase.opId],
              submitter: submitter(teacherA, new Date().toISOString()),
              school_id: "single-school",
              callback: async () => ({
                status: "saved",
                effect: "committed",
                business_object_id: randomUUID(),
                business_revision: null,
              }),
            }),
          );
        } finally {
          await client.end();
        }
      },
      "approval_invalid",
      "approval_cancelled",
    );

    // 跨 session：同一账号新会话不继承旧批准
    const crossSessionCase = await mutateBeforeExecute(
      "session-1",
      "observation.confirm",
      "observation",
      { kind: "observation", observation_id: ids.obsA },
      ids.obsA,
    );
    await expectDataError(
      async () => {
        const client = new Client({ connectionString: container.url });
        await client.connect();
        try {
          await withRawTransaction(client, (tx) =>
            executeApprovedOperations(tx, {
              approval_id: crossSessionCase.approvalId,
              operation_ids: [crossSessionCase.opId],
              submitter: submitter({ ...teacherA, sessionId: randomUUID() }, new Date().toISOString()),
              school_id: "single-school",
              callback: async () => ({
                status: "saved",
                effect: "committed",
                business_object_id: randomUUID(),
                business_revision: null,
              }),
            }),
          );
        } finally {
          await client.end();
        }
      },
      "approval_invalid",
      "session_changed",
    );
    note("approval_rejections_covered");
    stage("rejections-ok");

    /* ------------------------- 受控双连接：替代 vs 旧消费 ------------------------- */
    const supersedeScenario = async (order: "execute-first" | "supersede-first") => {
      const prep = await statusOf(
        proposalsPost(req(teacherA.token, "POST", prepareBody(ids.convA, { ...confirmItem, item_key: `sup-${order}` }), "/api/yaya/proposals")),
        201,
      );
      const proposalId = (prep.proposal as { proposal_id: string }).proposal_id;
      const opId = (prep.proposal as { items: { operation_id: string }[] }).items[0]!.operation_id;
      const approvalResponse = await statusOf(
        approvalPost(req(teacherA.token, "POST", { action: "approve", operation_ids: [opId] }, `/api/yaya/proposals/${proposalId}/approval`), params(proposalId)),
        201,
      );
      const approvalId = (approvalResponse.approval as { approval_id: string }).approval_id;

      const holder = new Client({ connectionString: container.url });
      const contender = new Client({ connectionString: container.url });
      await holder.connect();
      await contender.connect();
      let callbackCalls = 0;
      const entered = (() => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => (resolve = done));
        return { promise, resolve };
      })();
      const release = (() => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => (resolve = done));
        return { promise, resolve };
      })();

      const executionBody: YayaExecuteApprovedInput = {
        approval_id: approvalId,
        operation_ids: [opId],
        submitter: submitter(teacherA, new Date().toISOString()),
        school_id: "single-school",
        callback: async (txClient) => {
          callbackCalls += 1;
          entered.resolve();
          if (order === "execute-first") await release.promise;
          await txClient.query(
            `INSERT INTO observations (id,child_id,class_id,observed_at,raw_text,status)
             VALUES ($1,$2,$3,'2026-03-01','交错写入。','confirmed')`,
            [randomUUID(), ids.childA, ids.classA],
          );
          return {
            status: "saved",
            effect: "committed",
            business_object_id: randomUUID(),
            business_revision: null,
          };
        },
      };
      const replacementBody = {
        conversation_id: ids.convA,
        proposal_origin: "teacher_card" as const,
        auth: { kind: "action" as const, action: "observation.confirm" as const, resource: "observation" as const },
        items: [{ ...confirmItem, item_key: `sup-new-${order}` }],
      };

      let holderResult: unknown = null;
      let contenderError: unknown = null;
      if (order === "execute-first") {
        const holderRun = withRawTransaction(holder, (tx) => executeApprovedOperations(tx, executionBody)).then(
          (value) => (holderResult = value),
          (error) => (holderResult = error),
        );
        await entered.promise; // 旧消费已持有操作行锁
        const contenderRun = withRawTransaction(contender, (tx) =>
          supersedeWithReplacement(tx, {
            operation_id: opId,
            actor_account_id: teacherA.accountId,
            replacement: replacementBody,
          }),
        ).then(
          () => undefined,
          (error) => (contenderError = error),
        );
        // 替代必须等待旧消费提交/回滚后再判定，不得双写
        await new Promise((resolve) => setTimeout(resolve, 300));
        check(`${order}: 替代在旧消费持锁期间等待`, contenderError === null);
        release.resolve();
        await holderRun;
        await contenderRun;
      } else {
        // 替代先完成但事务后提交：旧消费必须等待锁并最终被拒
        await holder.query("BEGIN");
        try {
          holderResult = await supersedeWithReplacement(holder as unknown as TransactionClient, {
            operation_id: opId,
            actor_account_id: teacherA.accountId,
            replacement: replacementBody,
          });
        } catch (error) {
          holderResult = error;
        }
        const contenderRun = withRawTransaction(contender, (tx) => executeApprovedOperations(tx, executionBody)).then(
          () => undefined,
          (error) => (contenderError = error),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        check(`${order}: 旧消费在替代持锁期间等待`, contenderError === null && callbackCalls === 0);
        await holder.query("COMMIT");
        await contenderRun;
      }
      await holder.end().catch(() => undefined);
      await contender.end().catch(() => undefined);

      if (order === "execute-first") {
        check("替代失败：旧执行已提交", holderResult instanceof Array);
        const contenderFailure = contenderError as { code?: string };
        check("替代拒绝已执行操作", contenderFailure?.code === "operation_started");
        const receipts = holderResult as { business_object_id: string }[];
        check("旧消费回执存在", receipts[0]?.business_object_id !== undefined);
      } else {
        check("替代成功发布新身份", typeof (holderResult as { superseded_operation_id?: string })?.superseded_operation_id === "string");
        const contenderFailure = contenderError as { code?: string };
        check("旧迟到消费被拒绝", contenderFailure?.code === "approval_invalid");
        check("替代后旧消费未调用 callback", callbackCalls === 0);
        const oldRow = await poolQueryFor<{ superseded_by: string | null; status: string | null }>(
          container.url,
          "SELECT superseded_by, status FROM yaya_operations WHERE operation_id = $1",
          [opId],
        );
        check("旧操作记录 superseded_by", oldRow[0]?.superseded_by !== null && oldRow[0]?.status === null);
        const newRow = await poolQueryFor<{ count: string }>(
          container.url,
          "SELECT count(*)::text AS count FROM yaya_operations WHERE operation_id = $1",
          [oldRow[0]?.superseded_by],
        );
        check("新身份已发布（planned）", Number(newRow[0]?.count ?? 0) === 1);
      }
    };
    await supersedeScenario("execute-first");
    stage("supersede-execute-first-ok");
    await supersedeScenario("supersede-first");
    stage("supersede-first-ok");

    stage("supersede-ok");
    /* ------------------------- 删除会话与新引用交错 ------------------------- */
    const convD = await statusOf(
      conversationsPost(req(teacherA.token, "POST", { title: "待删除" }, "/api/yaya/conversations")),
      201,
    );
    ids.convD = (convD.conversation as { conversation_id: string }).conversation_id;
    await withRawTransaction(db, async (tx) => {
      await yayaDataRepository.registerAttachment(tx, {
        attachment_id: ids.attD2,
        uploader_account_id: teacherA.accountId,
        conversation_id: ids.convD,
        object_key: `${RUN}/att-d2`,
        media_type: "image/png",
        byte_size: 12,
        checksum_sha256: "c".repeat(64),
        source_kind: "raw_input",
        derived_from: null,
      });
      await yayaDataRepository.registerAttachment(tx, {
        attachment_id: ids.attE2,
        uploader_account_id: teacherA.accountId,
        conversation_id: ids.convD,
        object_key: `${RUN}/att-e2`,
        media_type: "image/png",
        byte_size: 12,
        checksum_sha256: "d".repeat(64),
        source_kind: "raw_input",
        derived_from: null,
      });
      await tx.query(
        `INSERT INTO yaya_attachment_refs (attachment_id, record_kind, record_id, linked_by_account_id)
         VALUES ($1, 'observation', $2, $3)`,
        [ids.attE2, ids.obsA, teacherA.accountId],
      );
    });
    await statusOf(
      messagesPost(
        req(
          teacherA.token,
          "POST",
          {
            client_message_id: "m-d1",
            role: "user",
            message_kind: "image",
            fragments: [],
            attachment_ids: [ids.attD2, ids.attE2],
            expected_conversation_revision: 1,
          },
          `/api/yaya/conversations/${ids.convD}/messages`,
        ),
        params(ids.convD),
      ),
      201,
    );

    const deleted = await statusOf(
      conversationDelete(
        req(teacherA.token, "DELETE", undefined, `/api/yaya/conversations/${ids.convD}?expected_revision=2`),
        params(ids.convD),
      ),
      200,
    );
    const deleteResult = deleted as {
      detached_attachment_ids: string[];
      unreferenced_attachment_ids: string[];
      conversation: { deleted_at: string | null };
    };
    check(
      "删除会话解除本会话消息引用",
      deleteResult.detached_attachment_ids.includes(ids.attD2) &&
        deleteResult.detached_attachment_ids.includes(ids.attE2),
    );
    check("attD2 解除后无引用（回收候选）", deleteResult.unreferenced_attachment_ids.includes(ids.attD2));
    check("attE2 仍有观察引用不得回收", !deleteResult.unreferenced_attachment_ids.includes(ids.attE2));
    check("删除后会话不可读", deleteResult.conversation?.deleted_at !== null);
    await statusOf(
      messagesGet(req(teacherA.token, "GET", undefined, `/api/yaya/conversations/${ids.convD}/messages`), params(ids.convD)),
      404,
    );
    const receiptSurvivesDelete = await poolQueryFor<{ count: string }>(
      container.url,
      "SELECT count(*)::text AS count FROM yaya_operations WHERE operation_id = $1",
      [operationId],
    );
    check("删除会话保留操作核验记录", Number(receiptSurvivesDelete[0]?.count ?? 0) === 1);
    passed += 7;

    // 无引用附件进入 deleting 租约，并发新引用被 CAS/状态拒绝
    const leaseHolder = new Client({ connectionString: container.url });
    const leaseContender = new Client({ connectionString: container.url });
    await leaseHolder.connect();
    await leaseContender.connect();
    await leaseHolder.query("BEGIN");
    const lease = await yayaDataRepository.beginAttachmentDeletion(
      leaseHolder as unknown as TransactionClient,
      {
        attachment_id: ids.attD2,
        expected_revision: 1,
        actor_account_id: teacherA.accountId,
      },
    );
    check("无引用附件进入 deleting 租约", lease.status === "deleting" && lease.revision === 2);
    let contenderOutcome: unknown = null;
    // 受控交错：租约持锁期间发起新引用，引用必须先等待再被状态拒绝
    const leaseContenderRun = withRawTransaction(leaseContender, async (tx) => {
      try {
        await yayaDataRepository.linkAttachmentRef(tx, {
          attachment_id: ids.attD2,
          record_kind: "observation",
          record_id: ids.obsA,
          linked_by_account_id: teacherA.accountId,
        });
        contenderOutcome = "linked";
      } catch (error) {
        contenderOutcome = error;
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    check("deleting 持锁期间新引用等待", contenderOutcome === null);
    await leaseHolder.query("COMMIT");
    await leaseContenderRun;
    const leaseFailure = contenderOutcome as { code?: string };
    check("deleting 期间新引用被拒", leaseFailure?.code === "attachment_conflict");
    await leaseHolder.end();
    await leaseContender.end();

    // 已引用附件不得进入删除租约
    await withRawTransaction(db, async (tx) => {
      await expectDataError(
        () =>
          yayaDataRepository.beginAttachmentDeletion(tx, {
            attachment_id: ids.attE2,
            expected_revision: 1,
            actor_account_id: teacherA.accountId,
          }),
        "attachment_referenced",
      );
    });

    // 资料追加审计与 revision CAS（attF 未关联且 ready）
    // 宿主前提在保存事务锁内复核：先使 obsA 成为已确认归档（带确认时间）。
    const obsAConfirmedAt = "2026-05-01T00:00:00Z";
    await database.query(
      "UPDATE observations SET status = 'confirmed', confirmed_at = $2 WHERE id = $1",
      [ids.obsA, obsAConfirmedAt],
    );
    const appended = await withRawTransaction(db, async (tx) =>
      yayaDataRepository.appendObservationAttachments(tx, {
        observation_id: ids.obsA,
        attachment_ids: [ids.attF],
        expected_attachment_revision: 0,
        appended_by_account_id: teacherA.accountId,
        approval_id: null,
        note: "归档后资料",
        source_confirmed_at: obsAConfirmedAt,
      }),
    );
    check("资料追加写 audit 并递增 revision", appended.attachment_revision === 1);
    const audited = await poolQueryFor<{ count: string }>(
      container.url,
      "SELECT count(*)::text AS count FROM yaya_attachment_appends WHERE observation_id = $1 AND attachment_revision = 1",
      [ids.obsA],
    );
    check("资料追加有独立审计", Number(audited[0]?.count ?? 0) === 1);
    await withRawTransaction(db, async (tx) => {
      await expectDataError(
        () =>
          yayaDataRepository.appendObservationAttachments(tx, {
            observation_id: ids.obsA,
            attachment_ids: [ids.attD],
            expected_attachment_revision: 0,
            appended_by_account_id: teacherA.accountId,
            approval_id: null,
            note: "过期前提",
            source_confirmed_at: obsAConfirmedAt,
          }),
        "revision_conflict",
      );
    });

    stage("delete-ok");
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
  console.log(JSON.stringify({ passed, evidence, run_id: RUN, route_handler_http: true }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
