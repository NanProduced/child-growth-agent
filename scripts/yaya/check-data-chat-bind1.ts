/**
 * YAYA-DATA-CHAT-BIND1 反例检查（DATA 专属新增，不改既有检查）
 *
 * 结构：
 * - P 段（纯检查，无数据库 / 无网络）：确定性消息身份派生、读侧绑定策略、
 *   HTTP 禁字段清单、迁移文件与内部原语存在性；
 * - D 段（隔离 PostgreSQL + 直调真实 route handler）：迁移幂等与旧行字节不变、
 *   HTTP/内部写入分离、owner 与管理员隔离、旧助手消息受限、bound/unknown 绑定读侧、
 *   撤权与转班降级、恢复标记往返、同事务回滚、并发同身份一行、幂等与冲突、
 *   共享保存边界默认通道。
 *
 * 在基线上整体应 RED（反例先行）；实现完成后全绿。
 * 只用获批 harness（scripts/harness-safety.ts，blob 6702f2dd…）：
 * 不读 .env、不连托管库、不发真实模型请求（结束时守门计数必须为 0）。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-data-chat-bind1.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { NextRequest } from "next/server";
import {
  assertCleanupComplete,
  modelGuardEnv,
  runCleanupSteps,
  sleep,
  startIsolatedPostgres,
  startModelRequestGuard,
  type IsolatedPostgres,
} from "../harness-safety";
import { buildPrincipal } from "../../src/lib/accounts/repository";
import { computeCsrfToken, createSessionToken } from "../../src/lib/accounts/session";
import type { Principal } from "../../src/lib/accounts/types";
import { yayaDataRepository } from "../../src/lib/yaya/data";
import * as yayaInvariants from "../../src/lib/yaya/data/invariants";
import * as yayaMessagesRepo from "../../src/lib/yaya/data/messages";
import {
  parseYayaChatRecoveryMark,
  verifyYayaRecoveryIdentity,
  yayaRecoveryLookupRequests,
  type YayaChatRecoveryMark,
} from "../../src/lib/yaya/chat-bind-contract";
import type { TransactionClient } from "../../src/storage/database/pg-client";
import { POST as conversationsPost } from "../../src/app/api/yaya/conversations/route";
import { GET as conversationGet, PATCH as conversationPatch } from "../../src/app/api/yaya/conversations/[id]/route";
import { GET as messagesGet, POST as messagesPost } from "../../src/app/api/yaya/conversations/[id]/messages/route";

const RUN = `dcb1-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ORIGIN = "http://data-chat-bind1.invalid";
const SCHOOL = "single-school";
const MIGRATION_FILE = path.join(ROOT, "scripts", "upgrade-yaya-chat-bind-v1.sql");

const LEGACY_BODY = "LEGACY_ASSISTANT_BODY";
const LEGACY_PROVENANCE = "LEGACY_PROVENANCE_LABEL";
const LEGACY_TITLE = "LEGACY_DERIVED_TITLE";
const BOUND_BODY = "BOUND_ASSISTANT_BODY";
const BOUND_PROVENANCE = "BOUND_PROVENANCE_LABEL";
const BOUND_TITLE = "BOUND_DERIVED_TITLE";
const UNKNOWN_BODY = "UNKNOWN_BINDING_BODY";
const USER_CONTROL_BODY = "USER_CONTROL_BODY";

/** HTTP 通道必须拒绝的绑定伪造字段（服务端语义字段，客户端一律不得自报） */
const FORBIDDEN_HTTP_KEYS: readonly Record<string, unknown>[] = [
  { run_id: "run-1" },
  { binding_state: "bound" },
  { binding: { state: "bound", dependencies: [] } },
  { recovery: { mark: "yaya-recovery-v1" } },
  { recovery_mark: { mark: "yaya-recovery-v1" } },
  { channel: "run_terminal" },
  { write_channel: "run_terminal" },
  { internal_channel: "run_terminal" },
  { run: { run_id: "run-1", client_request_id: "req-1" } },
  { writer: "AGENT-APP1" },
  { sources: [] },
  { independently_readable: true },
  { general_qa_proven: true },
  { private_dependency_proven_absent: true },
  { resource_dependencies: [] },
  { unmapped_dependency_count: 0 },
];

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
  method: "GET" | "POST" | "PATCH",
  body: unknown,
  requestPath: string,
): NextRequest {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (token) {
    headers.cookie ??= `cga_session=${token}`;
    if (method !== "GET") headers["x-csrf-token"] ??= computeCsrfToken(token);
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`${ORIGIN}${requestPath}`, {
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
function errorCode(error: unknown): string | null {
  const candidate = error as { name?: string; code?: string };
  return candidate?.name === "YayaDataError" ? candidate.code ?? null : null;
}
function throwsWithCode(work: () => unknown, code: string): boolean {
  try {
    work();
    return false;
  } catch (error) {
    return errorCode(error) === code;
  }
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
      SCHOOL,
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
async function poolQueryFor<T>(url: string, sql: string, values: unknown[] = []): Promise<T[]> {
  const client = clientFor(url);
  await client.connect();
  try {
    const result = await client.query(sql, values);
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
    (error: unknown) => {
      attempt.state = "done";
      attempt.error = error;
    },
  );
  return attempt;
}

/* ---------------- 基线上不存在的新 API：只经运行时查找访问，保证基线可编译 ---------------- */

interface SavedFragmentView {
  fragment_id: string;
  visibility: string;
  text: string | null;
  provenance: unknown;
}
interface SavedMessageView {
  message_id: string;
  role: string;
  projection: { visibility: string; fragments: { visibility: string }[] };
  fragments: SavedFragmentView[];
  attachment_ids: string[];
  recovery?: unknown;
}
interface SavedConversationView {
  conversation_id: string;
  revision: number;
  projected_title: string;
  title_restricted: boolean;
}
interface RunSaveResult {
  message: SavedMessageView;
  conversation: SavedConversationView;
  replayed: boolean;
}
type DeriveMessageId = (runId: string, role: string, part?: string) => string;
type ReadPolicy = (
  bindingState: string | null | undefined,
  fragments: readonly unknown[],
) => { binding_state: string; sources: readonly unknown[]; independently_readable: boolean };
type ForbiddenKeys = (body: unknown) => string[];
type RunTerminalSave = (
  client: TransactionClient,
  principal: Principal,
  schoolId: string,
  input: Record<string, unknown>,
) => Promise<RunSaveResult>;

const invariantsModule = yayaInvariants as unknown as Record<string, unknown>;
const messagesModule = yayaMessagesRepo as unknown as Record<string, unknown>;
const deriveFn: DeriveMessageId | null =
  typeof invariantsModule.deriveYayaRunClientMessageId === "function"
    ? (invariantsModule.deriveYayaRunClientMessageId as DeriveMessageId)
    : null;
const policyFn: ReadPolicy | null =
  typeof invariantsModule.yayaAssistantReadPolicy === "function"
    ? (invariantsModule.yayaAssistantReadPolicy as ReadPolicy)
    : null;
const forbiddenFn: ForbiddenKeys | null =
  typeof invariantsModule.findForbiddenHttpMessageKeys === "function"
    ? (invariantsModule.findForbiddenHttpMessageKeys as ForbiddenKeys)
    : null;
const runTerminalFn: RunTerminalSave | null =
  typeof messagesModule.saveRunTerminalMessage === "function"
    ? (messagesModule.saveRunTerminalMessage as RunTerminalSave)
    : null;

/* ------------------------------ 工具 ------------------------------ */

function frag(
  fragmentId: string,
  text: string,
  sources: readonly Record<string, unknown>[],
  independentlyReadable: boolean,
  provenanceKind: string,
  label: string,
): Record<string, unknown> {
  return {
    fragment_id: fragmentId,
    text,
    sources,
    independently_readable: independentlyReadable,
    provenance: { kind: provenanceKind, ref_id: null, label, derived_from: null },
  };
}
function childSource(childId: string): Record<string, unknown> {
  return { kind: "child", child_id: childId, current_class_id: null };
}
function terminalInput(conversationId: string, runId: string): Record<string, unknown> {
  return {
    conversation_id: conversationId,
    role: "assistant",
    message_kind: "text",
    execution_state: "none",
    fragments: [],
    attachment_ids: [],
    run: { run_id: runId, client_request_id: `${runId}-req` },
    binding_state: "bound",
  };
}
function assistantOf(messages: readonly SavedMessageView[]): SavedMessageView | null {
  return messages.find((entry) => entry.role === "assistant") ?? null;
}
function provenanceLabel(fragment: SavedFragmentView | undefined): string | null {
  const record = fragment?.provenance as { label?: unknown } | null | undefined;
  return typeof record?.label === "string" ? record.label : null;
}

/* ------------------------------ P 段：纯检查 ------------------------------ */

function pureChecks(): void {
  stage("P 纯检查");

  check("P1 确定性消息身份原语已发布", deriveFn !== null);
  if (deriveFn !== null) {
    const base = deriveFn("run-plain", "assistant");
    check("P1 同参数派生同身份", base === deriveFn("run-plain", "assistant"));
    check("P2 省略 part 与显式 part=role 等价", base === deriveFn("run-plain", "assistant", "assistant"));
    check("P2 不同 run 派生不同身份", base !== deriveFn("run-other", "assistant"));
    check("P2 同 run 不同 part 派生不同身份", deriveFn("run-plain", "assistant", "p2") !== base);
    check("P2 同 run 不同角色派生不同身份", base !== deriveFn("run-plain", "tool"));
    check(
      "P2 派生身份不超 128 字符",
      base.length <= 128 && deriveFn("r".repeat(64), "assistant", "p".repeat(44)).length <= 128,
    );
    check("P2 run_id 含冒号拒绝", throwsWithCode(() => deriveFn("a:b", "assistant"), "invalid_request"));
    check("P2 part 空白拒绝", throwsWithCode(() => deriveFn("run-plain", "assistant", " "), "invalid_request"));
    check("P2 run_id 超长拒绝", throwsWithCode(() => deriveFn("r".repeat(65), "assistant"), "invalid_request"));
  }

  check("P3 读侧绑定策略原语已发布", policyFn !== null);
  if (policyFn !== null) {
    const legacy = policyFn(null, []);
    check(
      "P3 旧消息按 unknown 读取",
      legacy.binding_state === "unknown" && legacy.sources.length === 0 && legacy.independently_readable === false,
    );
    const weird = policyFn("weird", []);
    check("P3 非法绑定值按 unknown 读取", weird.binding_state === "unknown");
    const withChild = policyFn("bound", [
      frag("f1", "t", [childSource("child-x")], false, "model_text", null as unknown as string),
    ]);
    check(
      "P3 bound 继承片段服务端来源",
      withChild.binding_state === "bound" &&
        withChild.sources.length === 1 &&
        withChild.independently_readable === false,
    );
    const general = policyFn("bound", [frag("f2", "t", [], true, "model_text", null as unknown as string)]);
    check(
      "P3 bound 一般问答保持独立可读",
      general.binding_state === "bound" && general.sources.length === 0 && general.independently_readable === true,
    );
    const empty = policyFn("bound", []);
    check("P3 bound 空片段不误伤", empty.binding_state === "bound" && empty.independently_readable === true);
  }

  check("P4 HTTP 禁字段清单原语已发布", forbiddenFn !== null);
  if (forbiddenFn !== null) {
    for (const entry of FORBIDDEN_HTTP_KEYS) {
      const key = Object.keys(entry)[0] ?? "?";
      check(`P4 检出禁字段 ${key}`, forbiddenFn(entry).includes(key));
    }
    const legalUserBody = {
      client_message_id: "legal-1",
      role: "user",
      message_kind: "text",
      fragments: [frag("f-legal", "t", [childSource("child-x")], true, "raw_input", "L")],
      attachment_ids: [],
      expected_conversation_revision: 1,
    };
    check("P4 合法 user 请求体不误伤", forbiddenFn(legalUserBody).length === 0);
    check("P4 空请求体不误伤", forbiddenFn(null).length === 0);
  }

  const hasMigration = fs.existsSync(MIGRATION_FILE);
  check("P5 迁移文件存在", hasMigration);
  if (hasMigration) {
    const sql = fs.readFileSync(MIGRATION_FILE, "utf8");
    check("P5 迁移包含绑定列", sql.includes("binding_state") && sql.includes("run_id") && sql.includes("recovery_mark"));
    check("P5 迁移可重复执行", sql.includes("IF NOT EXISTS"));
  }

  check("P6 内部原语已发布（messages 模块）", runTerminalFn !== null);
  check("P6 内部原语已挂到 repository", "saveRunTerminalMessage" in yayaDataRepository);
}

/* ------------------------------ D 段 ------------------------------ */

let dbUrl = "";

async function withDbTx<T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> {
  const client = clientFor(dbUrl);
  await client.connect();
  try {
    return await withRawTransaction(client, work);
  } finally {
    await client.end().catch(() => undefined);
  }
}
async function tryRunSave(
  principal: Principal,
  input: Record<string, unknown>,
  label: string,
): Promise<RunSaveResult | null> {
  if (runTerminalFn === null) {
    check(label, false);
    return null;
  }
  return await withDbTx((tx) => runTerminalFn(tx, principal, SCHOOL, input));
}
async function countMessages(conversationId: string): Promise<number> {
  const rows = await poolQueryFor<{ count: string }>(
    dbUrl,
    "SELECT count(*)::text AS count FROM yaya_messages WHERE conversation_id = $1 AND deleted_at IS NULL",
    [conversationId],
  );
  return Number(rows[0]?.count ?? "0");
}
async function createConversation(token: string, title: string | null = null): Promise<string> {
  const created = await respond(conversationsPost(req(token, "POST", { title }, "/api/yaya/conversations")));
  if (created.status !== 201) {
    throw new Error(`create conversation failed: ${created.status} ${created.text}`);
  }
  const conversation = created.json.conversation as Record<string, unknown> | undefined;
  const id = conversation?.conversation_id;
  if (typeof id !== "string") throw new Error("conversation_id missing");
  return id;
}
async function conversationDetail(token: string, conversationId: string): Promise<Record<string, unknown>> {
  const detail = await respond(
    conversationGet(req(token, "GET", undefined, `/api/yaya/conversations/${conversationId}`), params(conversationId)),
  );
  if (detail.status !== 200) throw new Error(`conversation detail failed: ${detail.status} ${detail.text}`);
  return (detail.json.conversation ?? {}) as Record<string, unknown>;
}
async function revisionOf(token: string, conversationId: string): Promise<number> {
  const view = await conversationDetail(token, conversationId);
  return typeof view.revision === "number" ? view.revision : Number.NaN;
}
async function getMessages(
  token: string,
  conversationId: string,
): Promise<{ status: number; text: string; messages: SavedMessageView[] }> {
  const res = await respond(
    messagesGet(req(token, "GET", undefined, `/api/yaya/conversations/${conversationId}/messages`), params(conversationId)),
  );
  const messages = (res.json.messages ?? []) as unknown as SavedMessageView[];
  return { status: res.status, text: res.text, messages };
}

interface ColumnShape {
  table_name: string;
  column_name: string;
  data_type: string;
  character_maximum_length: number | string | null;
}
function shapeKey(entry: ColumnShape): string {
  return `${entry.table_name}.${entry.column_name}`;
}
function sameShape(a: ColumnShape, b: ColumnShape): boolean {
  return a.data_type === b.data_type && String(a.character_maximum_length) === String(b.character_maximum_length);
}

async function migrationStage(database: Client, legacySnapshotSql: string): Promise<void> {
  stage("D1 迁移幂等与旧行不变");
  const beforeRows = await poolQueryFor<Record<string, unknown>>(dbUrl, legacySnapshotSql);
  const shapeSql =
    "SELECT table_name, column_name, data_type, character_maximum_length FROM information_schema.columns " +
    "WHERE table_schema = 'public' AND table_name LIKE 'yaya_%' ORDER BY table_name, column_name";
  const shapeBefore = await poolQueryFor<ColumnShape>(dbUrl, shapeSql);

  if (!fs.existsSync(MIGRATION_FILE)) {
    check("D1 迁移文件可执行", false);
    return;
  }
  const migrationSql = fs.readFileSync(MIGRATION_FILE, "utf8");
  await database.query(migrationSql);
  await database.query(migrationSql);

  const afterRows = await poolQueryFor<Record<string, unknown>>(dbUrl, legacySnapshotSql);
  check("D1 重复执行后旧行字节不变", JSON.stringify(afterRows) === JSON.stringify(beforeRows));

  const shapeAfter = await poolQueryFor<ColumnShape>(dbUrl, shapeSql);
  const beforeByKey = new Map(shapeBefore.map((entry) => [shapeKey(entry), entry]));
  const afterByKey = new Map(shapeAfter.map((entry) => [shapeKey(entry), entry]));
  const removed = shapeBefore.filter((entry) => !afterByKey.has(shapeKey(entry)));
  const changed = shapeBefore.filter((entry) => {
    const now = afterByKey.get(shapeKey(entry));
    return now !== undefined && !sameShape(entry, now);
  });
  const added = shapeAfter.filter((entry) => !beforeByKey.has(shapeKey(entry)));
  check("D1 不删除或改写既有列", removed.length === 0 && changed.length === 0);
  check(
    "D1 只新增绑定三列",
    added.length === 3 &&
      added.every(
        (entry) =>
          entry.table_name === "yaya_messages" &&
          ["run_id", "binding_state", "recovery_mark"].includes(entry.column_name),
      ),
  );
  const constraints = await poolQueryFor<{ count: string }>(
    dbUrl,
    "SELECT count(*)::text AS count FROM pg_constraint WHERE conname = 'yaya_messages_binding_state_check' AND contype = 'c'",
  );
  check("D1 绑定值检查约束唯一存在", constraints[0]?.count === "1");
}

async function httpBoundaryStage(teacherA: Session): Promise<void> {
  stage("D2-D5 HTTP 通道边界");
  const convHttp = await createConversation(teacherA.token);

  const assistantBody = {
    client_message_id: "http-a1",
    role: "assistant",
    message_kind: "text",
    fragments: [],
    attachment_ids: [],
    expected_conversation_revision: 1,
  };
  const assistantPost = await respond(
    messagesPost(
      req(teacherA.token, "POST", assistantBody, `/api/yaya/conversations/${convHttp}/messages`),
      params(convHttp),
    ),
  );
  check("D2 HTTP 拒绝 assistant 400", assistantPost.status === 400);
  check("D2 HTTP assistant 拒绝码 invalid_request", assistantPost.json.error === "invalid_request");
  check("D2 assistant 拒绝后无消息落库", (await countMessages(convHttp)) === 0);

  const toolPost = await respond(
    messagesPost(
      req(
        teacherA.token,
        "POST",
        { ...assistantBody, client_message_id: "http-t1", role: "tool" },
        `/api/yaya/conversations/${convHttp}/messages`,
      ),
      params(convHttp),
    ),
  );
  check("D3 HTTP 拒绝 tool 400", toolPost.status === 400);
  check("D3 tool 拒绝码 invalid_request", toolPost.json.error === "invalid_request");
  check("D3 tool 拒绝后无消息落库", (await countMessages(convHttp)) === 0);

  for (const entry of FORBIDDEN_HTTP_KEYS) {
    const key = Object.keys(entry)[0] ?? "?";
    const conv = await createConversation(teacherA.token);
    const forged = await respond(
      messagesPost(
        req(
          teacherA.token,
          "POST",
          {
            client_message_id: `http-fk-${key}`,
            role: "user",
            message_kind: "text",
            fragments: [],
            attachment_ids: [],
            expected_conversation_revision: 1,
            ...entry,
          },
          `/api/yaya/conversations/${conv}/messages`,
        ),
        params(conv),
      ),
    );
    check(`D4 HTTP 拒绝伪造字段 ${key}`, forged.status === 400 && forged.json.error === "invalid_request");
    check(`D4 伪造字段 ${key} 未落库`, (await countMessages(conv)) === 0);
  }

  const convPositive = await createConversation(teacherA.token);
  const userPost = await respond(
    messagesPost(
      req(
        teacherA.token,
        "POST",
        {
          client_message_id: "http-u1",
          role: "user",
          message_kind: "text",
          fragments: [frag("f-u1", USER_CONTROL_BODY, [], true, "raw_input", "USER_LABEL")],
          attachment_ids: [],
          expected_conversation_revision: 1,
        },
        `/api/yaya/conversations/${convPositive}/messages`,
      ),
      params(convPositive),
    ),
  );
  check("D5 正常 user 消息 201", userPost.status === 201);
  const userMessages = await getMessages(teacherA.token, convPositive);
  const userView = userMessages.messages.find((entry) => entry.role === "user");
  check("D5 user 正文可读", userView?.fragments[0]?.text === USER_CONTROL_BODY);
}

async function ownerIsolationStage(teacherA: Session, teacherB: Session, admin: Session): Promise<void> {
  stage("D6 owner 与管理员隔离");
  const conv = await createConversation(teacherA.token);
  const byTeacherB = await getMessages(teacherB.token, conv);
  check("D6 非 owner GET 404", byTeacherB.status === 404);
  const byAdmin = await getMessages(admin.token, conv);
  check("D6 管理员 GET 404", byAdmin.status === 404);

  const postBody = {
    client_message_id: "iso-b1",
    role: "user",
    message_kind: "text",
    fragments: [],
    attachment_ids: [],
    expected_conversation_revision: 1,
  };
  const postB = await respond(
    messagesPost(req(teacherB.token, "POST", postBody, `/api/yaya/conversations/${conv}/messages`), params(conv)),
  );
  check("D6 非 owner POST 404", postB.status === 404);
  const postAdmin = await respond(
    messagesPost(req(admin.token, "POST", postBody, `/api/yaya/conversations/${conv}/messages`), params(conv)),
  );
  check("D6 管理员 POST 404", postAdmin.status === 404);
  check("D6 隔离后零消息", (await countMessages(conv)) === 0);
}

async function legacyReadStage(teacherA: Session, legacyConversationId: string): Promise<void> {
  stage("D7 旧助手消息受限");
  const legacyRevision = await revisionOf(teacherA.token, legacyConversationId);
  const renamed = await respond(
    conversationPatch(
      req(
        teacherA.token,
        "PATCH",
        { title: LEGACY_TITLE, expected_revision: legacyRevision, title_source_fragments: ["f-legacy"] },
        `/api/yaya/conversations/${legacyConversationId}`,
      ),
      params(legacyConversationId),
    ),
  );
  check("D7 旧会话改名 200", renamed.status === 200);

  const detail = await conversationDetail(teacherA.token, legacyConversationId);
  check(
    "D7 旧助手派生标题降级通用",
    detail.projected_title !== LEGACY_TITLE && detail.title_restricted === true,
  );

  const list = await getMessages(teacherA.token, legacyConversationId);
  check("D7 消息列表 200", list.status === 200);
  const legacyView = assistantOf(list.messages);
  check("D7 找到旧助手消息", legacyView !== null);
  if (legacyView !== null) {
    check("D7 旧助手正文不下发", legacyView.fragments[0]?.text === null);
    check("D7 旧助手片段非 full", legacyView.fragments[0]?.visibility !== "full");
    check("D7 旧助手 provenance 不下发", legacyView.fragments[0]?.provenance === null);
    check("D7 旧助手消息级降级", legacyView.projection.visibility !== "full");
    check("D7 旧助手无恢复标记", "recovery" in legacyView && legacyView.recovery === null);
  }
  check(
    "D7 响应不含旧正文与标签",
    !list.text.includes(LEGACY_BODY) && !list.text.includes(LEGACY_PROVENANCE),
  );
  check("D7 标题响应不含原派生标题", !(JSON.stringify(detail).includes(LEGACY_TITLE)));
}

async function unknownBindingStage(teacherA: Session, childA: string): Promise<void> {
  stage("D9 bound/unknown 绑定读侧");
  const conv = await createConversation(teacherA.token);
  const saved = await tryRunSave(
    teacherA.principal,
    {
      ...terminalInput(conv, `${RUN}-unknown`),
      binding_state: "unknown",
      fragments: [frag("f-unknown", UNKNOWN_BODY, [childSource(childA)], true, "model_text", "UNKNOWN_PROVENANCE")],
    },
    "D9 内部原语可用（unknown 绑定）",
  );
  if (saved === null) return;
  check("D9 unknown 绑定保存成功", saved.replayed === false);

  const list = await getMessages(teacherA.token, conv);
  const view = assistantOf(list.messages);
  check("D9 unknown 绑定正文不下发", view?.fragments[0]?.text === null);
  check("D9 unknown 绑定 provenance 不下发", view?.fragments[0]?.provenance === null);
  check("D9 unknown 绑定消息级 unavailable", view?.projection.visibility === "unavailable");
}

async function boundLifecycleStage(
  database: Client,
  teacherA: Session,
  childA: string,
  classA: string,
  classC: string,
): Promise<void> {
  stage("D8 bound 绑定写读与撤权/转班降级");
  const conv = await createConversation(teacherA.token);
  const runId = `${RUN}-bound`;
  const saved = await tryRunSave(
    teacherA.principal,
    {
      ...terminalInput(conv, runId),
      fragments: [frag("f-bound", BOUND_BODY, [childSource(childA)], false, "model_text", BOUND_PROVENANCE)],
    },
    "D8 内部原语可用（bound 绑定）",
  );
  if (saved === null) return;
  check("D8 bound 保存 revision 递增", saved.conversation.revision === 2);

  const rows = await poolQueryFor<{ run_id: string | null; binding_state: string | null }>(
    dbUrl,
    "SELECT run_id, binding_state FROM yaya_messages WHERE conversation_id = $1 AND role = 'assistant'",
    [conv],
  );
  check("D8 落库 run_id 与 binding_state", rows[0]?.run_id === runId && rows[0]?.binding_state === "bound");

  const full = await getMessages(teacherA.token, conv);
  const fullView = assistantOf(full.messages);
  check("D8 bound 正文可读", fullView?.fragments[0]?.text === BOUND_BODY);
  check("D8 bound provenance 可读", provenanceLabel(fullView?.fragments[0]) === BOUND_PROVENANCE);

  const boundRevision = await revisionOf(teacherA.token, conv);
  const renamed = await respond(
    conversationPatch(
      req(
        teacherA.token,
        "PATCH",
        { title: BOUND_TITLE, expected_revision: boundRevision, title_source_fragments: ["f-bound"] },
        `/api/yaya/conversations/${conv}`,
      ),
      params(conv),
    ),
  );
  check("D8 bound 改名 200", renamed.status === 200);
  const titleView = await conversationDetail(teacherA.token, conv);
  check(
    "D8 bound 派生标题全量",
    titleView.projected_title === BOUND_TITLE && titleView.title_restricted === false,
  );

  await database.query("DELETE FROM teacher_class_assignments WHERE account_id = $1 AND class_id = $2", [
    teacherA.accountId,
    classA,
  ]);
  const revoked = await getMessages(teacherA.token, conv);
  const revokedView = assistantOf(revoked.messages);
  check("D8 撤权后正文不下发", revokedView?.fragments[0]?.text === null);
  check("D8 撤权后 provenance 不下发", revokedView?.fragments[0]?.provenance === null);
  check("D8 撤权后片段非 full", revokedView?.fragments[0]?.visibility !== "full");
  const revokedDetail = await conversationDetail(teacherA.token, conv);
  check(
    "D8 撤权后标题降级通用",
    revokedDetail.projected_title !== BOUND_TITLE && revokedDetail.title_restricted === true,
  );
  check("D8 撤权后响应不含正文", !revoked.text.includes(BOUND_BODY));

  await database.query("INSERT INTO teacher_class_assignments (account_id, class_id) VALUES ($1,$2)", [
    teacherA.accountId,
    classA,
  ]);
  const regranted = await getMessages(teacherA.token, conv);
  const regrantedView = assistantOf(regranted.messages);
  check("D8 恢复授权后正文可读", regrantedView?.fragments[0]?.text === BOUND_BODY);

  await database.query(
    "UPDATE child_class_enrollments SET end_date = '2026-10-01' WHERE child_id = $1 AND end_date IS NULL",
    [childA],
  );
  await database.query(
    "INSERT INTO child_class_enrollments (child_id, class_id, start_date) VALUES ($1,$2,'2026-10-02')",
    [childA, classC],
  );
  const transferred = await getMessages(teacherA.token, conv);
  const transferredView = assistantOf(transferred.messages);
  check("D8 转班后正文不下发", transferredView?.fragments[0]?.text === null);
  check("D8 转班后片段非 full", transferredView?.fragments[0]?.visibility !== "full");
}

async function recoveryStage(teacherA: Session): Promise<void> {
  stage("D10 恢复标记往返");
  const conv = await createConversation(teacherA.token);
  const runId = `${RUN}-rec`;
  const requestId = `${RUN}-rec-req`;
  const saved = await tryRunSave(
    teacherA.principal,
    {
      ...terminalInput(conv, runId),
      execution_state: "executed",
      fragments: [frag("f-rec", "RECOVERY_BODY", [], true, "model_text", "RECOVERY_LABEL")],
      recovery: { actor_account_id: teacherA.accountId, proposal: null, operations: [] },
    },
    "D10 内部原语可用（恢复标记）",
  );
  if (saved === null) return;

  check("D10 恢复标记随保存投影", "recovery" in saved.message && saved.message.recovery !== null);
  const parsed = parseYayaChatRecoveryMark(saved.message.recovery);
  check("D10 恢复标记解析通过", parsed.ok === true);
  if (parsed.ok) {
    const mark: YayaChatRecoveryMark = parsed.value;
    check(
      "D10 标记身份为会话与 owner",
      mark.conversation_id === conv &&
        mark.owner_account_id === teacherA.accountId &&
        mark.actor_account_id === teacherA.accountId,
    );
    check("D10 标记保留 run 身份", mark.run?.run_id === runId && mark.run?.client_request_id === requestId);
    const verdict = verifyYayaRecoveryIdentity(mark, {
      conversation_id: conv,
      owner_account_id: teacherA.accountId,
      run: { run_id: runId, client_request_id: requestId },
      operations: [],
    });
    check("D10 身份核验可核", verdict.verifiable === true);
    const lookups = yayaRecoveryLookupRequests(mark);
    check(
      "D10 恢复查询首条为消息历史",
      lookups[0]?.method === "GET" && lookups[0]?.path === `/api/yaya/conversations/${conv}/messages`,
    );
    check("D10 恢复查询全部只读 GET", lookups.length === 2 && lookups.every((entry) => entry.method === "GET"));
  }

  const list = await getMessages(teacherA.token, conv);
  const listView = assistantOf(list.messages);
  const parsedGet = parseYayaChatRecoveryMark(listView?.recovery);
  check("D10 GET 恢复标记往返一致", parsedGet.ok === true && parsedGet.value.run?.run_id === runId);

  const rows = await poolQueryFor<{ recovery_mark: { mark?: string } | null }>(
    dbUrl,
    "SELECT recovery_mark FROM yaya_messages WHERE conversation_id = $1 AND role = 'assistant'",
    [conv],
  );
  check("D10 recovery_mark 落库为标记对象", rows[0]?.recovery_mark?.mark === "yaya-recovery-v1");
}

async function rollbackStage(teacherA: Session): Promise<void> {
  stage("D11 同事务回滚");
  const conv = await createConversation(teacherA.token);
  if (runTerminalFn === null) {
    check("D11 内部原语可用（同事务回滚）", false);
    check("D11 调用方事务回滚生效", false);
    check("D11 回滚后无消息", false);
    check("D11 回滚后 revision 不变", false);
    return;
  }
  const client = clientFor(dbUrl);
  await client.connect();
  let sawForced = false;
  try {
    await withRawTransaction(client, async (tx) => {
      await runTerminalFn(tx, teacherA.principal, SCHOOL, {
        ...terminalInput(conv, `${RUN}-roll`),
        fragments: [frag("f-roll", "ROLLBACK_BODY", [], true, "model_text", "ROLL_LABEL")],
      });
      throw new Error("forced-rollback");
    });
  } catch (error) {
    sawForced = error instanceof Error && error.message === "forced-rollback";
  } finally {
    await client.end().catch(() => undefined);
  }
  check("D11 调用方事务回滚生效", sawForced);
  check("D11 回滚后无消息", (await countMessages(conv)) === 0);
  check("D11 回滚后 revision 不变", (await revisionOf(teacherA.token, conv)) === 1);
}

async function concurrencyStage(teacherA: Session): Promise<void> {
  stage("D12-D14 并发同身份、幂等与派生");
  const conv = await createConversation(teacherA.token);
  const runId = `${RUN}-conc`;
  const input = {
    ...terminalInput(conv, runId),
    fragments: [frag("f-conc", "CONC_BODY", [], true, "model_text", "CONC_LABEL")],
  };
  if (runTerminalFn === null) {
    check("D12 内部原语可用（并发同身份）", false);
    check("D12 并发只落一行", false);
    check("D13 同身份重放返回 replayed", false);
    check("D13 同身份异内容拒绝", false);
    check("D14 落库身份等于派生值", false);
    check("D14 同 run 不同 part 新增一行", false);
    return;
  }

  const holder = clientFor(dbUrl);
  await holder.connect();
  await holder.query("BEGIN");
  await runTerminalFn(holder as unknown as TransactionClient, teacherA.principal, SCHOOL, input);
  const second = startAttempt(() =>
    withDbTx((tx) => runTerminalFn(tx, teacherA.principal, SCHOOL, input)),
  );
  await sleep(300);
  check("D12 并发写者在会话锁上等待", second.state === "pending");
  await holder.query("COMMIT");
  await holder.end();
  await second.promise;
  check("D12 后到者幂等回放", second.error === undefined && second.value?.replayed === true);
  check("D12 并发只落一行", (await countMessages(conv)) === 1);

  const replayed = await withDbTx((tx) => runTerminalFn(tx, teacherA.principal, SCHOOL, input));
  check("D13 同身份重放返回 replayed", replayed.replayed === true);
  check("D13 重放不重复落库", (await countMessages(conv)) === 1);
  try {
    await withDbTx((tx) =>
      runTerminalFn(tx, teacherA.principal, SCHOOL, {
        ...input,
        fragments: [frag("f-conc", "CONFLICTING_BODY", [], true, "model_text", "CONC_LABEL")],
      }),
    );
    check("D13 同身份异内容拒绝", false);
  } catch (error) {
    check("D13 同身份异内容拒绝", errorCode(error) === "idempotency_conflict");
  }

  const derivedExpected = deriveFn === null ? null : deriveFn(runId, "assistant");
  const idRows = await poolQueryFor<{ client_message_id: string | null }>(
    dbUrl,
    "SELECT client_message_id FROM yaya_messages WHERE conversation_id = $1 ORDER BY created_at, id",
    [conv],
  );
  check(
    "D14 落库身份等于派生值",
    derivedExpected !== null && idRows.some((row) => row.client_message_id === derivedExpected),
  );
  const partSaved = await withDbTx((tx) =>
    runTerminalFn(tx, teacherA.principal, SCHOOL, {
      ...input,
      part: "p2",
      fragments: [frag("f-conc-p2", "CONC_PART_TWO_BODY", [], true, "model_text", "CONC_LABEL")],
    }),
  );
  check("D14 同 run 不同 part 新增一行", partSaved.replayed === false && (await countMessages(conv)) === 2);
  const partExpected = deriveFn === null ? null : deriveFn(runId, "assistant", "p2");
  check(
    "D14 part 身份派生一致",
    partExpected !== null && idRows.length >= 0 && (await poolQueryFor<{ client_message_id: string | null }>(
      dbUrl,
      "SELECT client_message_id FROM yaya_messages WHERE conversation_id = $1",
      [conv],
    )).some((row) => row.client_message_id === partExpected),
  );
}

async function channelDefaultsStage(teacherA: Session): Promise<void> {
  stage("D15-D16 共享保存边界");
  const convUser = await createConversation(teacherA.token);
  if (runTerminalFn === null) {
    check("D15 内部通道拒绝 user 角色", false);
  } else {
    try {
      await withDbTx((tx) =>
        runTerminalFn(tx, teacherA.principal, SCHOOL, {
          ...terminalInput(convUser, `${RUN}-user-role`),
          role: "user",
        }),
      );
      check("D15 内部通道拒绝 user 角色", false);
    } catch (error) {
      check("D15 内部通道拒绝 user 角色", errorCode(error) === "invalid_request");
    }
    check("D15 user 角色拒绝后无落库", (await countMessages(convUser)) === 0);
  }

  const convDirect = await createConversation(teacherA.token);
  try {
    await withDbTx((tx) =>
      yayaDataRepository.saveMessage(tx, teacherA.principal, SCHOOL, {
        conversation_id: convDirect,
        client_message_id: "direct-a1",
        role: "assistant",
        message_kind: "text",
        execution_state: "none",
        fragments: [],
        attachment_ids: [],
        expected_conversation_revision: 1,
      }),
    );
    check("D16 直接 saveMessage 默认通道拒绝助手", false);
  } catch (error) {
    check("D16 直接 saveMessage 默认通道拒绝助手", errorCode(error) === "invalid_request");
  }
  check("D16 拒绝后无消息落库", (await countMessages(convDirect)) === 0);
}

async function main(): Promise<void> {
  const cleanupIssues: string[] = [];
  const guard = await startModelRequestGuard();
  Object.assign(process.env, modelGuardEnv(guard));

  pureChecks();

  let isolated: IsolatedPostgres | null = null;
  let db: Client | null = null;
  try {
    isolated = await startIsolatedPostgres({
      runId: RUN,
      containerName: `cga-${RUN}`,
      dbName: `cga_dcb1_${process.pid}`,
      labelKey: "child-growth-agent.data-chat-bind1",
      noteIssue: (label, detail) => cleanupIssues.push(`${label}: ${detail}`),
    });
    dbUrl = isolated.url;
    process.env.DATABASE_URL = isolated.url;
    delete process.env.PGDATABASE_URL;
    process.env.AUTH_TRUSTED_ORIGINS = ORIGIN;
    db = clientFor(dbUrl);
    await db.connect();
    const database = db;

    await database.query(fs.readFileSync(path.join(ROOT, "scripts", "initialize-demo-db.sql"), "utf8"));
    await database.query(fs.readFileSync(path.join(ROOT, "scripts", "upgrade-auth-v1.sql"), "utf8"));
    await database.query(fs.readFileSync(path.join(ROOT, "scripts", "upgrade-yaya-v1.sql"), "utf8"));

    const classA = randomUUID();
    const classB = randomUUID();
    const classC = randomUUID();
    const childA = randomUUID();
    for (const [id, name] of [
      [classA, "DCB1 A"],
      [classB, "DCB1 B"],
      [classC, "DCB1 C"],
    ] as const) {
      await database.query("INSERT INTO classes (id,name,stage,school_year) VALUES ($1,$2,'small','2026')", [id, name]);
    }
    await database.query(
      "INSERT INTO children (id,name,gender,birth_date,class_name) VALUES ($1,'DCB1 child','女','2022-01-01','fixture')",
      [childA],
    );
    await database.query(
      "INSERT INTO child_class_enrollments (child_id,class_id,start_date) VALUES ($1,$2,'2026-01-01')",
      [childA, classA],
    );
    const teacherA = await createSession(database, "a", "teacher", [classA]);
    const teacherB = await createSession(database, "b", "teacher", [classB]);
    const admin = await createSession(database, "admin", "admin", []);
    stage("seeded");

    // 旧助手消息：仅用基线列直插，迁移必须把未绑定消息读为 unknown
    const legacyConversationId = await createConversation(teacherA.token);
    const legacyFragments = [frag("f-legacy", LEGACY_BODY, [childSource(childA)], true, "model_text", LEGACY_PROVENANCE)];
    await database.query(
      `INSERT INTO yaya_messages (conversation_id, owner_account_id, client_message_id, role, message_kind, fragments)
       VALUES ($1,$2,'legacy-1','assistant','text',$3::jsonb)`,
      [legacyConversationId, teacherA.accountId, JSON.stringify(legacyFragments)],
    );
    const legacySnapshotSql =
      "SELECT id, client_message_id, client_digest, role, message_kind, fragments::text AS fragments, " +
      "attachment_ids::text AS attachment_ids, execution_state, revision FROM yaya_messages ORDER BY id";

    await migrationStage(database, legacySnapshotSql);
    await httpBoundaryStage(teacherA);
    await ownerIsolationStage(teacherA, teacherB, admin);
    await legacyReadStage(teacherA, legacyConversationId);
    await unknownBindingStage(teacherA, childA);
    await boundLifecycleStage(database, teacherA, childA, classA, classC);
    await recoveryStage(teacherA);
    await rollbackStage(teacherA);
    await concurrencyStage(teacherA);
    await channelDefaultsStage(teacherA);

    check("模型网关未被调用", guard.hits === 0);
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
    JSON.stringify({ passed, total: passed + failures.length, failures, chat_bind1: true, run_id: RUN }),
  );
  assert.equal(failures.length, 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
