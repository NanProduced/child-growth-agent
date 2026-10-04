import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import {
  assertCleanupComplete,
  modelGuardEnv,
  restoreGeneratedArtifacts,
  runCleanupSteps,
  snapshotGeneratedArtifacts,
  startIsolatedPostgres,
  startModelRequestGuard,
  stopTrackedChildTree,
  trackChildProcess,
  waitForVerifiedService,
  type GeneratedArtifactSnapshot,
  type IsolatedPostgres,
  type ModelRequestGuard,
  type TrackedChild,
} from "./harness-safety";
import { FIXTURE_ACCESS_CASES } from "../src/lib/accounts/__fixtures__/contract-fixtures";
import { authorizeAction } from "../src/lib/accounts/authorize";
import { loadAccountsConfig } from "../src/lib/accounts/config";
import { evaluateLoginGuard } from "../src/lib/accounts/guards";
import { normalizeUsername } from "../src/lib/accounts/normalize";
import { hashPassword, parsePasswordHash, verifyPassword } from "../src/lib/accounts/password";
import { createLoginRateLimiter } from "../src/lib/accounts/rate-limit";
import { loginWithPassword, resetTeacherPassword, setTeacherStatus } from "../src/lib/accounts/repository";
import { computeCsrfToken, createSessionToken, csrfMatches } from "../src/lib/accounts/session";
import { safeQueryOne } from "../src/lib/accounts/pool-safety";

/**
 * AUTH1 验收：离线检查 + 一次性隔离 PostgreSQL + 真实 HTTP（next dev）+ 受控并发。
 *
 * 安全装置：唯一 RUN_ID、容器 ID+标签核验、回环端口+数据库身份核验（harness-safety）；
 * 模型出口改道本地守门（真实模型请求必须为 0）；失败路径同样清理并核验。
 * 本检查不覆盖业务路由接入（AUTH2），也不声称整个应用已受新认证保护。
 */

const RUN_ID = `auth1-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
const LABEL_KEY = "cga.auth1.check";
const CONTAINER_NAME = `cga-auth1-${RUN_ID}`;
const DB_NAME = "cga_auth1_check";
const STUDENT_PASSWORD = "Student-Password-1!";
const ADMIN_USERNAME = "checkadmin";
const ADMIN_PASSWORD = "Admin-Password-1!";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOG_FILE = path.join(os.tmpdir(), `${RUN_ID}-next.log`);

const DEMO_CLASS_SUNFLOWER = "c3c30000-0000-4000-8000-000000000001";
const DEMO_CLASS_RAINBOW = "c3c30000-0000-4000-8000-000000000002";
const DEMO_CLASS_DANDELION = "c3c30000-0000-4000-8000-000000000003";

interface ApiResponse {
  status: number;
  body: unknown;
  setCookies: string[];
}

function bodyAs<T>(response: ApiResponse): T {
  return response.body as T;
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

function assertNoSensitiveKeys(value: unknown, label: string): void {
  const forbidden = [
    "password",
    "password_hash",
    "initial_password",
    "new_password",
    "salt",
    "token_hash",
    "session_token",
  ];
  for (const key of collectKeys(value)) {
    assert.ok(!forbidden.includes(key), `${label}: 响应不得包含敏感字段 ${key}`);
  }
}

function cookieValue(setCookies: string[], name: string): string | null {
  for (const cookie of setCookies) {
    const pair = cookie.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1);
    }
  }
  return null;
}

function cookieHeader(setCookies: string[], name: string): string | null {
  const value = cookieValue(setCookies, name);
  return value === null ? null : `${name}=${value}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配回环端口"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

let passed = 0;

/* -------------------------------- 离线检查 -------------------------------- */

async function offlineChecks(): Promise<void> {
  // 1) 密码哈希：固定格式、正确/错误、独立盐、参数不可协商
  const hashA = await hashPassword("Correct-Password-1");
  const hashB = await hashPassword("Correct-Password-1");
  assert.match(hashA, /^scrypt\$/);
  const parsed = parsePasswordHash(hashA);
  assert.ok(parsed, "存储格式必须可严格解析");
  assert.equal(parsed.N, 32768);
  assert.equal(parsed.r, 8);
  assert.equal(parsed.p, 3);
  assert.ok(parsed.salt.length >= 16, "盐至少 16 字节");
  assert.ok(parsed.hash.length === 64, "派生密钥长度 64");
  assert.equal(await verifyPassword("Correct-Password-1", hashA), true);
  assert.equal(await verifyPassword("correct-password-1", hashA), false, "密码大小写敏感");
  assert.equal(await verifyPassword(" Correct-Password-1", hashA), false, "密码不 trim");
  assert.notEqual(
    hashA.split("$")[4],
    hashB.split("$")[4],
    "同一密码两次哈希必须使用独立随机盐",
  );
  assert.equal(parsePasswordHash(hashA.replace("$32768$", "$16384$")), null, "拒绝非冻结参数 N");
  assert.equal(parsePasswordHash(hashA.replace("$8$3$", "$8$1$")), null, "拒绝非冻结参数 p");
  assert.equal(parsePasswordHash(hashA.replace(/^scrypt\$/, "scrypt2$")), null, "拒绝其他算法");
  assert.equal(parsePasswordHash("scrypt$32768$8$3$AA$AA"), null, "拒绝过短盐/哈希");
  passed += 1;

  // 2) 用户名规范化与密码分离
  assert.equal(normalizeUsername("  LiLaoShi "), "lilaoshi");
  assert.equal(normalizeUsername("ＦＵＬＬ　ＷＩＤＴＨ"), "full width", "NFKC 将全角空格归一为普通空格");
  assert.equal(normalizeUsername("Ａdmin"), "admin");
  passed += 1;

  // 3) 会话令牌与 CSRF 绑定
  const sessionOne = createSessionToken();
  const sessionTwo = createSessionToken();
  assert.equal(sessionOne.token.length, 43, "32 字节 base64url");
  assert.match(sessionOne.tokenHash, /^[0-9a-f]{64}$/);
  assert.notEqual(sessionOne.token, sessionTwo.token);
  assert.notEqual(sessionOne.tokenHash, sessionTwo.tokenHash);
  const csrfOne = computeCsrfToken(sessionOne.token);
  assert.equal(csrfMatches(sessionOne.token, csrfOne), true);
  assert.equal(csrfMatches(sessionTwo.token, csrfOne), false, "另一会话 CSRF 不得通过");
  assert.equal(csrfMatches(sessionOne.token, null), false);
  passed += 1;

  // 4) 登录前保护：媒体类型精确匹配与 Origin
  const trusted = "https://yaya.example.edu";
  const guardFacts = {
    origin: trusted as string | null,
    auth_request_header: "1" as string | null,
    content_type: "application/json" as string | null,
  };
  const config = loadAccountsConfig({
    ...process.env,
    AUTH_TRUSTED_ORIGINS: trusted,
  });
  assert.ok(config);
  const guard = (overrides: Partial<{ origin: string | null; auth_request_header: string | null; content_type: string | null }> = {}) =>
    evaluateLoginGuard(
      {
        headers: {
          get: (name: string) => {
            if (name === "origin") return "origin" in overrides ? overrides.origin ?? null : guardFacts.origin;
            if (name === "x-cga-auth-request") {
              return "auth_request_header" in overrides
                ? overrides.auth_request_header ?? null
                : guardFacts.auth_request_header;
            }
            if (name === "content-type") {
              return "content_type" in overrides ? overrides.content_type ?? null : guardFacts.content_type;
            }
            return null;
          },
        },
      },
      config,
    );
  assert.deepEqual(guard({}), { ok: true });
  assert.deepEqual(guard({ content_type: "application/json; charset=utf-8" }), { ok: true });
  assert.deepEqual(guard({ content_type: "Application/JSON" }), { ok: true });
  assert.deepEqual(guard({ content_type: "application/jsonp" }), { ok: false, failure: "content_type_rejected" });
  assert.deepEqual(guard({ content_type: "application/json-seq" }), { ok: false, failure: "content_type_rejected" });
  assert.deepEqual(guard({ content_type: "application/jsonx" }), { ok: false, failure: "content_type_rejected" });
  assert.deepEqual(guard({ content_type: "text/plain" }), { ok: false, failure: "content_type_rejected" });
  assert.deepEqual(guard({ content_type: "" }), { ok: false, failure: "content_type_rejected" });
  assert.deepEqual(guard({ origin: "https://evil.example" }), { ok: false, failure: "origin_untrusted" });
  assert.deepEqual(guard({ origin: "null" }), { ok: false, failure: "origin_untrusted" });
  assert.deepEqual(guard({ origin: null }), { ok: false, failure: "same_origin_proof_missing" });
  assert.deepEqual(guard({ auth_request_header: null }), { ok: false, failure: "auth_request_header_missing" });
  passed += 1;

  // 5) 限流：固定窗口
  let now = 1_000_000;
  const limiter = createLoginRateLimiter(() => now);
  const policy = { maxFailures: 2, windowMs: 1000 };
  const key = "user|127.0.0.1";
  assert.equal(limiter.isBlocked(key, policy), false);
  limiter.recordFailure(key, policy);
  assert.equal(limiter.isBlocked(key, policy), false);
  limiter.recordFailure(key, policy);
  assert.equal(limiter.isBlocked(key, policy), true);
  now += 1001;
  assert.equal(limiter.isBlocked(key, policy), false, "窗口过期自动解除");
  passed += 1;

  // 6) 授权基础函数与冻结 fixture 的授权用例一致（authenticated 用例）
  let compared = 0;
  for (const entry of FIXTURE_ACCESS_CASES) {
    if (entry.auth.kind !== "authenticated") continue;
    const decision = authorizeAction(entry.auth.principal, entry.action, entry.resource);
    assert.equal(decision.allowed, entry.expected.allowed, `${entry.name}: allowed 不一致`);
    if (decision.allowed && entry.expected.allowed) {
      assert.equal(decision.via, entry.expected.via, `${entry.name}: via 不一致`);
      assert.equal(decision.projection, entry.expected.projection, `${entry.name}: projection 不一致`);
    }
    if (!decision.allowed && !entry.expected.allowed && entry.expected.deny) {
      assert.ok("deny" in decision, `${entry.name}: 期望 deny 拒绝`);
      assert.equal(decision.deny, entry.expected.deny, `${entry.name}: deny 不一致`);
    }
    if (!decision.allowed && entry.expected.invalid_request) {
      assert.ok("invalid_request" in decision, `${entry.name}: 期望 400 组合非法`);
    }
    compared += 1;
  }
  assert.ok(compared > 10, "必须与授权 fixture 交叉验证");
  passed += 1;

  // 7) 配置 fail closed：缺少可信源不产生配置
  assert.equal(loadAccountsConfig({} as NodeJS.ProcessEnv), null);
  passed += 1;
}

/* --------------------------- 数据库级并发与语义 --------------------------- */

async function applySqlFile(client: Client, file: string): Promise<void> {
  const sql = fs.readFileSync(path.join(ROOT, "scripts", file), "utf8");
  await client.query(sql);
}

async function databaseChecks(schoolId: string): Promise<void> {
  const adminExistsBefore = await safeQueryOne<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM app_accounts WHERE role = 'admin') AS exists`,
  );
  assert.equal(adminExistsBefore?.exists, false);

  // 8) 首位管理员并发初始化：唯一成功 + 重复拒绝
  const { createInitialAdmin, adminExists, createTeacherWithAssignments } = await import(
    "../src/lib/accounts/repository"
  );
  const bootstrapInput = async (username: string) => ({
    username,
    displayName: `管理员-${username}`,
    passwordHash: await hashPassword(ADMIN_PASSWORD),
  });
  const [first, second] = await Promise.allSettled([
    createInitialAdmin(await bootstrapInput(ADMIN_USERNAME), schoolId),
    createInitialAdmin(await bootstrapInput(`${ADMIN_USERNAME}-b`), schoolId),
  ]);
  const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
  const rejected = [first, second].filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1, "并发初始化只允许一个成功");
  assert.equal(rejected.length, 1, "另一个必须失败");
  assert.equal(
    (rejected[0] as PromiseRejectedResult).reason?.code,
    "admin_already_initialized",
    "冲突沿用 admin_already_initialized 语义",
  );
  assert.equal(await adminExists(), true);
  await assert.rejects(
    () => bootstrapInput(`${ADMIN_USERNAME}-c`).then((input) => createInitialAdmin(input, schoolId)),
    (error: unknown) => (error as { code?: string }).code === "admin_already_initialized",
    "已有管理员不得重复创建",
  );
  const adminRow = await safeQueryOne<{ id: string; password_hash: string; role: string }>(
    `SELECT id, password_hash, role FROM app_accounts WHERE username = $1`,
    [ADMIN_USERNAME],
  );
  assert.ok(adminRow);
  assert.equal(adminRow.role, "admin");
  assert.ok(parsePasswordHash(adminRow.password_hash), "数据库存储固定格式哈希");
  passed += 1;

  // 9) 登录：正确/错误密码、主权限定范围
  const adminLogin = await loginWithPassword(ADMIN_USERNAME, ADMIN_PASSWORD, schoolId);
  assert.equal(adminLogin.kind, "ok");
  if (adminLogin.kind === "ok") {
    assert.equal(adminLogin.principal.role, "admin");
    assert.deepEqual(adminLogin.principal.scope, { kind: "school", school_id: schoolId });
    const stored = await safeQueryOne<{ token_hash: string }>(
      `SELECT token_hash FROM app_sessions WHERE id = $1`,
      [adminLogin.session.session_id],
    );
    assert.ok(stored && stored.token_hash !== adminLogin.token, "数据库只存哈希，不存明文令牌");
  }
  const wrongAdmin = await loginWithPassword(ADMIN_USERNAME, "Wrong-Password-1", schoolId);
  assert.equal(wrongAdmin.kind, "invalid_credentials");
  const unknownUser = await loginWithPassword("nobody-here", "Wrong-Password-1", schoolId);
  assert.equal(unknownUser.kind, "invalid_credentials", "未知账号与错误密码同语义");
  passed += 1;

  const adminId = adminRow.id;
  const teacherHashA = await hashPassword(STUDENT_PASSWORD);
  const teacher = await createTeacherWithAssignments({
    username: "dbteacher",
    displayName: "数据库教师",
    passwordHash: teacherHashA,
    classIds: [DEMO_CLASS_SUNFLOWER, DEMO_CLASS_RAINBOW],
    assignedBy: adminId,
  });
  assert.deepEqual([...teacher.class_ids].sort(), [DEMO_CLASS_SUNFLOWER, DEMO_CLASS_RAINBOW].sort());
  passed += 1;

  // 10) 停用/重置撤销全部会话；空分配教师可登录
  const teacherLoginOne = await loginWithPassword("dbteacher", STUDENT_PASSWORD, schoolId);
  assert.equal(teacherLoginOne.kind, "ok");
  const disabled = await setTeacherStatus(teacher.account_id, "disabled");
  assert.ok(disabled.revokedSessionCount >= 1, "停用必须撤销全部会话");
  const disabledLogin = await loginWithPassword("dbteacher", STUDENT_PASSWORD, schoolId);
  assert.equal(disabledLogin.kind, "account_disabled");
  const disabledSession = await safeQueryOne<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM app_sessions WHERE id = $1`,
    [teacherLoginOne.kind === "ok" ? teacherLoginOne.session.session_id : ""],
  );
  assert.ok(disabledSession && disabledSession.revoked_at !== null, "停用后旧会话立即失效");
  await setTeacherStatus(teacher.account_id, "active");

  const teacherLoginTwo = await loginWithPassword("dbteacher", STUDENT_PASSWORD, schoolId);
  assert.equal(teacherLoginTwo.kind, "ok");
  const newHash = await hashPassword("Student-Password-2!");
  const reset = await resetTeacherPassword(teacher.account_id, newHash);
  assert.ok(reset.revokedSessionCount >= 1, "重置必须撤销全部会话");
  assert.equal((await loginWithPassword("dbteacher", STUDENT_PASSWORD, schoolId)).kind, "invalid_credentials");
  const afterReset = await loginWithPassword("dbteacher", "Student-Password-2!", schoolId);
  assert.equal(afterReset.kind, "ok");
  const revokedSession = await safeQueryOne<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM app_sessions WHERE id = $1`,
    [teacherLoginTwo.kind === "ok" ? teacherLoginTwo.session.session_id : ""],
  );
  assert.ok(revokedSession && revokedSession.revoked_at !== null);
  passed += 1;

  const emptyTeacher = await createTeacherWithAssignments({
    username: "emptyteacher",
    displayName: "空分配教师",
    passwordHash: await hashPassword(STUDENT_PASSWORD),
    classIds: [],
    assignedBy: adminId,
  });
  assert.deepEqual(emptyTeacher.class_ids, []);
  const emptyLogin = await loginWithPassword("emptyteacher", STUDENT_PASSWORD, schoolId);
  assert.equal(emptyLogin.kind, "ok");
  if (emptyLogin.kind === "ok") {
    assert.deepEqual(emptyLogin.principal.scope, { kind: "classes", class_ids: [] }, "空数组明确为空");
  }
  passed += 1;

  // 11) 任教关系：多班、同班多教师、撤销保留历史
  const { assignTeacherClass, unassignTeacherClass, listTeachers } = await import(
    "../src/lib/accounts/repository"
  );
  const teacherTwo = await createTeacherWithAssignments({
    username: "dbteacher2",
    displayName: "数据库教师二",
    passwordHash: await hashPassword(STUDENT_PASSWORD),
    classIds: [DEMO_CLASS_SUNFLOWER],
    assignedBy: adminId,
  });
  await assignTeacherClass(teacher.account_id, DEMO_CLASS_DANDELION, adminId);
  const summaryAfterAssign = await unassignTeacherClass(teacher.account_id, DEMO_CLASS_SUNFLOWER, adminId);
  assert.deepEqual(
    [...summaryAfterAssign.class_ids].sort(),
    [DEMO_CLASS_RAINBOW, DEMO_CLASS_DANDELION].sort(),
    "撤销后仍在任教的是其余班级",
  );
  const history = await safeQueryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM teacher_class_assignments
      WHERE account_id = $1 AND class_id = $2 AND removed_at IS NOT NULL`,
    [teacher.account_id, DEMO_CLASS_SUNFLOWER],
  );
  assert.equal(history?.count, 1, "撤销只写 removed_at，保留历史行");
  const teachers = await listTeachers();
  const sunflowerTeachers = teachers.filter((entry) => entry.class_ids.includes(DEMO_CLASS_SUNFLOWER));
  assert.ok(sunflowerTeachers.length >= 1);
  const teacherTwoSummary = teachers.find((entry) => entry.account_id === teacherTwo.account_id);
  assert.ok(teacherTwoSummary?.class_ids.includes(DEMO_CLASS_SUNFLOWER), "同班可有多名教师");
  passed += 1;

  // 12) 教师管理不得修改管理员；路径/请求体 ID 不一致由 HTTP 层覆盖
  await assert.rejects(
    () => setTeacherStatus(adminId, "disabled"),
    (error: unknown) => (error as { code?: string }).code === "forbidden_role",
    "教师管理接口不得通过传入管理员 ID 修改管理员",
  );
  passed += 1;

  // 13) 数据库不可用语义由 HTTP 末段覆盖；此处验证会话解析不续期
  if (afterReset.kind === "ok") {
    const before = await safeQueryOne<{ expires_at: Date; revoked_at: Date | null }>(
      `SELECT expires_at, revoked_at FROM app_sessions WHERE id = $1`,
      [afterReset.session.session_id],
    );
    const resolvedAgain = await loginWithPassword("dbteacher", "Student-Password-2!", schoolId);
    assert.equal(resolvedAgain.kind, "ok");
    const after = await safeQueryOne<{ expires_at: Date; revoked_at: Date | null }>(
      `SELECT expires_at, revoked_at FROM app_sessions WHERE id = $1`,
      [afterReset.session.session_id],
    );
    assert.deepEqual(before, after, "读取既有会话不修改会话行");
  }
  passed += 1;
}

/* ------------------------------ 真实 HTTP ------------------------------ */

interface HttpContext {
  base: string;
  origin: string;
  adminCookie: string;
  adminCsrf: string;
}

async function api(
  context: HttpContext,
  pathname: string,
  init: {
    method?: string;
    json?: unknown;
    cookie?: string | null;
    csrf?: string | null;
    headers?: Record<string, string>;
    origin?: string | null;
  } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  const origin = init.origin === undefined ? context.origin : init.origin;
  if (origin !== null) headers.origin = origin;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  if (init.cookie) headers.cookie = init.cookie;
  if (init.csrf) headers["x-csrf-token"] = init.csrf;
  Object.assign(headers, init.headers ?? {});
  const response = await fetch(`${context.base}${pathname}`, {
    method: init.method ?? "GET",
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    redirect: "manual",
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 保持文本
  }
  return { status: response.status, body, setCookies: response.headers.getSetCookie() };
}

async function loginHttp(
  context: HttpContext,
  username: string,
  password: string,
  options: {
    contentType?: string;
    omitAuthHeader?: boolean;
    origin?: string | null;
    extraCookie?: string | null;
  } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (!options.omitAuthHeader) headers["x-cga-auth-request"] = "1";
  if (options.contentType) headers["content-type"] = options.contentType;
  if (options.extraCookie) headers.cookie = options.extraCookie;
  return api(context, "/api/auth/login", {
    method: "POST",
    json: { username, password },
    headers,
    origin: options.origin,
  });
}

async function httpChecks(context: HttpContext): Promise<void> {
  const { base, origin } = context;
  // 14) 登录前保护（真实 HTTP）
  const jsonp = await loginHttp(context, ADMIN_USERNAME, ADMIN_PASSWORD, { contentType: "application/jsonp" });
  assert.equal(jsonp.status, 400);
  const form = await loginHttp(context, ADMIN_USERNAME, ADMIN_PASSWORD, {
    contentType: "application/x-www-form-urlencoded",
  });
  assert.equal(form.status, 400, "普通表单必须拒绝");
  const crossOrigin = await loginHttp(context, ADMIN_USERNAME, ADMIN_PASSWORD, {
    origin: "https://evil.example",
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(bodyAs<{ error: string }>(crossOrigin).error, "csrf_rejected");
  const nullOrigin = await loginHttp(context, ADMIN_USERNAME, ADMIN_PASSWORD, { origin: null });
  assert.equal(nullOrigin.status, 403, "缺少 Origin 拒绝");
  const omitHeader = await loginHttp(context, ADMIN_USERNAME, ADMIN_PASSWORD, { omitAuthHeader: true });
  assert.equal(omitHeader.status, 400);
  passed += 1;

  // 15) 正确登录：Cookie 属性、非敏感响应、旧 Cookie 不阻断
  const legacyCookie = `cga_teacher=1750000000.deadbeef`;
  const adminLogin = await loginHttp(context, ADMIN_USERNAME, ADMIN_PASSWORD, { extraCookie: legacyCookie });
  assert.equal(adminLogin.status, 200);
  const loginBody = bodyAs<{
    state: { kind: string; principal: { role: string; scope: { kind: string } } };
    csrf: { token: string };
    session: { session_id: string; expires_at: string };
  }>(adminLogin);
  assert.equal(loginBody.state.kind, "authenticated");
  assert.equal(loginBody.state.principal.role, "admin");
  assert.equal(loginBody.state.principal.scope.kind, "school");
  assertNoSensitiveKeys(adminLogin.body, "login response");
  const sessionSetCookie = adminLogin.setCookies.find((cookie) => cookie.startsWith("cga_session="));
  assert.ok(sessionSetCookie, "必须设置会话 Cookie");
  assert.match(sessionSetCookie, /HttpOnly/i);
  assert.match(sessionSetCookie, /SameSite=Lax/i);
  assert.match(sessionSetCookie, /Path=\//i);
  assert.match(sessionSetCookie, /Max-Age=604800/);
  assert.ok(!/Secure/i.test(sessionSetCookie), "本地 http 配置不强制 Secure");
  const legacyClear = adminLogin.setCookies.find((cookie) => cookie.startsWith("cga_teacher="));
  assert.ok(legacyClear, "登录响应必须由服务端清除旧 Cookie");
  assert.match(legacyClear, /Max-Age=0/);
  assert.match(legacyClear, /Path=\//);
  const adminCookie = cookieHeader(adminLogin.setCookies, "cga_session");
  assert.ok(adminCookie);
  const adminCsrf = loginBody.csrf.token;
  assert.ok(!JSON.stringify(adminLogin.body).includes(cookieValue(adminLogin.setCookies, "cga_session") ?? ""), "响应体不得回传会话令牌");
  passed += 1;

  // 16) 旧 Cookie 单独出现：invalid_session legacy，不构成授权
  const legacyOnly = await api(context, "/api/auth/status", { cookie: legacyCookie });
  assert.equal(legacyOnly.status, 200);
  const legacyBody = bodyAs<{ state: { kind: string; reason?: string } }>(legacyOnly);
  assert.equal(legacyBody.state.kind, "invalid_session");
  assert.equal(legacyBody.state.reason, "legacy_cookie_not_accepted");
  passed += 1;

  // 17) status 不续期、不写数据库
  const sessionId = loginBody.session.session_id;
  const before = await safeQueryOne<{ expires_at: Date; revoked_at: Date | null; created_at: Date }>(
    `SELECT expires_at, revoked_at, created_at FROM app_sessions WHERE id = $1`,
    [sessionId],
  );
  const statusOne = await api(context, "/api/auth/status", { cookie: adminCookie });
  const statusTwo = await api(context, "/api/auth/status", { cookie: adminCookie });
  assert.equal(statusOne.status, 200);
  assert.equal(statusTwo.status, 200);
  const after = await safeQueryOne<{ expires_at: Date; revoked_at: Date | null; created_at: Date }>(
    `SELECT expires_at, revoked_at, created_at FROM app_sessions WHERE id = $1`,
    [sessionId],
  );
  assert.deepEqual(before, after, "GET/状态读取不得续期或写库");
  passed += 1;

  // 18) 会话绑定 CSRF：跨会话令牌拒绝
  const adminLoginTwo = await loginHttp(context, ADMIN_USERNAME, ADMIN_PASSWORD);
  assert.equal(adminLoginTwo.status, 200);
  const adminCookieTwo = cookieHeader(adminLoginTwo.setCookies, "cga_session");
  assert.ok(adminCookieTwo);
  const secondCsrf = bodyAs<{ csrf: { token: string } }>(adminLoginTwo).csrf.token;
  assert.notEqual(secondCsrf, adminCsrf, "登录建立新 CSRF 令牌");
  const teacherForCsrf = await api(context, "/api/admin/teachers", {
    method: "POST",
    json: {
      username: "csrftarget",
      display_name: "CSRF 目标",
      initial_password: STUDENT_PASSWORD,
      class_ids: [DEMO_CLASS_DANDELION],
    },
    cookie: adminCookie,
    csrf: adminCsrf,
  });
  assert.equal(teacherForCsrf.status, 201);
  const csrfTarget = bodyAs<{ teacher: { account_id: string } }>(teacherForCsrf).teacher;
  const wrongCsrf = await api(context, `/api/admin/teachers/${csrfTarget.account_id}/assignments`, {
    method: "POST",
    json: { account_id: csrfTarget.account_id, class_id: DEMO_CLASS_DANDELION },
    cookie: adminCookie,
    csrf: secondCsrf,
  });
  assert.equal(wrongCsrf.status, 403, "另一会话的 CSRF 令牌不得使用");
  const missingCsrf = await api(context, `/api/admin/teachers/${csrfTarget.account_id}/assignments`, {
    method: "POST",
    json: { account_id: csrfTarget.account_id, class_id: DEMO_CLASS_DANDELION },
    cookie: adminCookie,
  });
  assert.equal(missingCsrf.status, 403);
  const crossOriginWrite = await api(context, `/api/admin/teachers/${csrfTarget.account_id}/assignments`, {
    method: "POST",
    json: { account_id: csrfTarget.account_id, class_id: DEMO_CLASS_DANDELION },
    cookie: adminCookie,
    csrf: adminCsrf,
    origin: "https://evil.example",
  });
  assert.equal(crossOriginWrite.status, 403, "跨源写请求拒绝");
  passed += 1;

  // 19) 管理员权限与路径/请求体一致性
  const anonymousList = await api(context, "/api/admin/teachers");
  assert.equal(anonymousList.status, 401);
  const teacherLogin = await loginHttp(context, "dbteacher", "Student-Password-2!");
  assert.equal(teacherLogin.status, 200);
  const teacherCookie = cookieHeader(teacherLogin.setCookies, "cga_session");
  const teacherCsrf = bodyAs<{ csrf: { token: string } }>(teacherLogin).csrf.token;
  assert.ok(teacherCookie);
  const teacherList = await api(context, "/api/admin/teachers", { cookie: teacherCookie });
  assert.equal(teacherList.status, 403);
  assert.equal(bodyAs<{ error: string }>(teacherList).error, "forbidden_role");
  const mismatch = await api(context, "/api/admin/teachers/00000000-0000-4000-8000-000000000000", {
    method: "PATCH",
    json: { account_id: "11111111-1111-4111-8111-111111111111", status: "disabled" },
    cookie: adminCookie,
    csrf: adminCsrf,
  });
  assert.equal(mismatch.status, 400, "路径 ID 与请求体不一致必须拒绝");
  const adminAccount = await safeQueryOne<{ id: string }>(
    `SELECT id FROM app_accounts WHERE role = 'admin' LIMIT 1`,
  );
  assert.ok(adminAccount);
  const adminTarget = await api(context, `/api/admin/teachers/${adminAccount.id}`, {
    method: "PATCH",
    json: { account_id: adminAccount.id, status: "disabled" },
    cookie: adminCookie,
    csrf: adminCsrf,
  });
  assert.equal(adminTarget.status, 403, "教师接口不得修改管理员");
  passed += 1;

  // 20) 教师管理与任教：多班、同班多教师、撤销、空分配
  const createdHttp = await api(context, "/api/admin/teachers", {
    method: "POST",
    json: {
      username: "HttpTeacher",
      display_name: "HTTP 教师",
      initial_password: STUDENT_PASSWORD,
      class_ids: [DEMO_CLASS_SUNFLOWER, DEMO_CLASS_RAINBOW],
    },
    cookie: adminCookie,
    csrf: adminCsrf,
  });
  assert.equal(createdHttp.status, 201);
  assertNoSensitiveKeys(createdHttp.body, "teacher create");
  const httpTeacher = bodyAs<{ teacher: { account_id: string; class_ids: string[] } }>(createdHttp).teacher;
  assert.deepEqual([...httpTeacher.class_ids].sort(), [DEMO_CLASS_SUNFLOWER, DEMO_CLASS_RAINBOW].sort());
  const duplicate = await api(context, "/api/admin/teachers", {
    method: "POST",
    json: { username: "httpteacher", display_name: "重复", initial_password: STUDENT_PASSWORD },
    cookie: adminCookie,
    csrf: adminCsrf,
  });
  assert.equal(duplicate.status, 409, "用户名规范化后唯一");
  const assignAnother = await api(context, `/api/admin/teachers/${httpTeacher.account_id}/assignments`, {
    method: "POST",
    json: { account_id: httpTeacher.account_id, class_id: DEMO_CLASS_DANDELION },
    cookie: adminCookie,
    csrf: adminCsrf,
  });
  assert.equal(assignAnother.status, 200);
  const httpList = await api(context, "/api/admin/teachers", { cookie: adminCookie });
  assert.equal(httpList.status, 200);
  assertNoSensitiveKeys(httpList.body, "teacher list");
  const dandelionTeachers = bodyAs<{ teachers: { class_ids: string[] }[] }>(httpList).teachers.filter(
    (entry) => entry.class_ids.includes(DEMO_CLASS_DANDELION),
  );
  assert.ok(dandelionTeachers.length >= 3, "同班可有多名教师");
  const unassign = await api(
    context,
    `/api/admin/teachers/${httpTeacher.account_id}/assignments/${DEMO_CLASS_SUNFLOWER}`,
    {
      method: "DELETE",
      json: { account_id: httpTeacher.account_id, class_id: DEMO_CLASS_SUNFLOWER, reason: "调整" },
      cookie: adminCookie,
      csrf: adminCsrf,
    },
  );
  assert.equal(unassign.status, 200);
  assert.ok(
    !bodyAs<{ teacher: { class_ids: string[] } }>(unassign).teacher.class_ids.includes(DEMO_CLASS_SUNFLOWER),
    "撤销后不再任教该班",
  );
  const emptyCreated = await api(context, "/api/admin/teachers", {
    method: "POST",
    json: { username: "httpempty", display_name: "HTTP 空分配", initial_password: STUDENT_PASSWORD, class_ids: [] },
    cookie: adminCookie,
    csrf: adminCsrf,
  });
  assert.equal(emptyCreated.status, 201);
  const emptyLoginHttp = await loginHttp(context, "httpempty", STUDENT_PASSWORD);
  assert.equal(emptyLoginHttp.status, 200, "空分配教师可登录");
  assert.deepEqual(
    bodyAs<{ state: { principal: { scope: { kind: string; class_ids?: string[] } } } }>(emptyLoginHttp).state
      .principal.scope,
    { kind: "classes", class_ids: [] },
  );
  passed += 1;

  // 21) 启用/停用与重置：撤销全部会话、旧密码失效
  const httpTeacherLogin = await loginHttp(context, "httpempty", STUDENT_PASSWORD);
  assert.equal(httpTeacherLogin.status, 200);
  const httpTeacherCookie = cookieHeader(httpTeacherLogin.setCookies, "cga_session");
  const httpEmptyId = bodyAs<{ state: { principal: { account_id: string } } }>(httpTeacherLogin).state.principal
    .account_id;
  const disable = await api(context, `/api/admin/teachers/${httpEmptyId}`, {
    method: "PATCH",
    json: { account_id: httpEmptyId, status: "disabled" },
    cookie: adminCookie,
    csrf: adminCsrf,
  });
  assert.equal(disable.status, 200);
  assert.ok(bodyAs<{ revoked_session_count: number }>(disable).revoked_session_count >= 1);
  const disabledStatus = await api(context, "/api/auth/status", { cookie: httpTeacherCookie });
  assert.equal(bodyAs<{ state: { kind: string } }>(disabledStatus).state.kind, "invalid_session");
  const disabledLoginHttp = await loginHttp(context, "httpempty", STUDENT_PASSWORD);
  assert.equal(disabledLoginHttp.status, 403);
  const reEnable = await api(context, `/api/admin/teachers/${httpEmptyId}`, {
    method: "PATCH",
    json: { account_id: httpEmptyId, status: "active" },
    cookie: adminCookie,
    csrf: adminCsrf,
  });
  assert.equal(reEnable.status, 200);
  const loginBeforeReset = await loginHttp(context, "httpempty", STUDENT_PASSWORD);
  assert.equal(loginBeforeReset.status, 200);
  const resetHttp = await api(context, `/api/admin/teachers/${httpEmptyId}/password-reset`, {
    method: "POST",
    json: { account_id: httpEmptyId, new_password: "New-Password-9!" },
    cookie: adminCookie,
    csrf: adminCsrf,
  });
  assert.equal(resetHttp.status, 200);
  assertNoSensitiveKeys(resetHttp.body, "password reset");
  assert.match(JSON.stringify(resetHttp.body), /"revoked_session_count":\s*[1-9]/);
  const oldPasswordLogin = await loginHttp(context, "httpempty", STUDENT_PASSWORD);
  assert.equal(oldPasswordLogin.status, 401, "重置后旧密码失效");
  const newPasswordLogin = await loginHttp(context, "httpempty", "New-Password-9!");
  assert.equal(newPasswordLogin.status, 200);
  passed += 1;

  // 22) invalid_credentials 不泄露账号是否存在
  const unknownLogin = await loginHttp(context, "nobody-here-at-all", "Some-Password-1");
  const knownWrongLogin = await loginHttp(context, "httpempty", "Wrong-Password-1");
  assert.equal(unknownLogin.status, 401);
  assert.equal(knownWrongLogin.status, 401);
  assert.deepEqual(unknownLogin.body, knownWrongLogin.body, "失败响应必须一致");
  passed += 1;

  // 23) 登录限流（进程内固定窗口，max=3）
  let lastRateStatus = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await loginHttp(context, "ratelimituser", "Wrong-Password-1");
    lastRateStatus = response.status;
    if (attempt < 3) assert.equal(response.status, 401, `第 ${attempt + 1} 次失败应为 401`);
  }
  assert.equal(lastRateStatus, 429, "超过窗口上限返回 429");
  passed += 1;

  // 24) 退出：有效会话撤销、失效缺失幂等、服务端清理 Cookie
  const logoutLogin = await loginHttp(context, "httpempty", "New-Password-9!");
  assert.equal(logoutLogin.status, 200);
  const logoutCookie = cookieHeader(logoutLogin.setCookies, "cga_session");
  const logoutCsrf = bodyAs<{ csrf: { token: string } }>(logoutLogin).csrf.token;
  assert.ok(logoutCookie);
  const logout = await api(context, "/api/auth/logout", {
    method: "POST",
    cookie: logoutCookie,
    csrf: logoutCsrf,
  });
  assert.equal(logout.status, 200);
  assert.equal(bodyAs<{ state: { kind: string } }>(logout).state.kind, "anonymous");
  assert.ok(logout.setCookies.some((cookie) => cookie.startsWith("cga_session=") && /Max-Age=0/.test(cookie)));
  assert.ok(logout.setCookies.some((cookie) => cookie.startsWith("cga_teacher=") && /Max-Age=0/.test(cookie)));
  const afterLogoutStatus = await api(context, "/api/auth/status", { cookie: logoutCookie });
  assert.equal(bodyAs<{ state: { kind: string } }>(afterLogoutStatus).state.kind, "invalid_session");
  const logoutAgain = await api(context, "/api/auth/logout", { method: "POST", cookie: logoutCookie });
  assert.equal(logoutAgain.status, 200, "失效会话退出幂等");
  const logoutNoSession = await api(context, "/api/auth/logout", { method: "POST" });
  assert.equal(logoutNoSession.status, 200);
  passed += 1;

  // 25) 受控并发：登录与重置/停用交错，不签发基于旧前提的会话
  const { createTeacherWithAssignments } = await import("../src/lib/accounts/repository");
  const adminRow = await safeQueryOne<{ id: string }>(`SELECT id FROM app_accounts WHERE role = 'admin' LIMIT 1`);
  assert.ok(adminRow);
  for (let trial = 0; trial < 2; trial += 1) {
    const username = `interleave-reset-${trial}`;
    const account = await createTeacherWithAssignments({
      username,
      displayName: `交错重置 ${trial}`,
      passwordHash: await hashPassword(STUDENT_PASSWORD),
      classIds: [],
      assignedBy: adminRow.id,
    });
    const [loginResult, resetResult]: [ApiResponse, ApiResponse] = await Promise.all([
      loginHttp(context, username, STUDENT_PASSWORD),
      api(context, `/api/admin/teachers/${account.account_id}/password-reset`, {
        method: "POST",
        json: { account_id: account.account_id, new_password: `Rotated-Password-${trial}!` },
        cookie: adminCookie,
        csrf: adminCsrf,
      }),
    ]);
    assert.equal(resetResult.status, 200);
    assert.ok([200, 401].includes(loginResult.status), "登录要么失败要么成功");
    if (loginResult.status === 200) {
      const issuedSessionId = bodyAs<{ session: { session_id: string } }>(loginResult).session.session_id;
      const row = await safeQueryOne<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM app_sessions WHERE id = $1`,
        [issuedSessionId],
      );
      assert.ok(row && row.revoked_at !== null, "重置交错后旧密码签发的会话必须已被撤销");
    }
  }
  for (let trial = 0; trial < 2; trial += 1) {
    const username = `interleave-disable-${trial}`;
    const account = await createTeacherWithAssignments({
      username,
      displayName: `交错停用 ${trial}`,
      passwordHash: await hashPassword(STUDENT_PASSWORD),
      classIds: [],
      assignedBy: adminRow.id,
    });
    const [loginResult, disableResult]: [ApiResponse, ApiResponse] = await Promise.all([
      loginHttp(context, username, STUDENT_PASSWORD),
      api(context, `/api/admin/teachers/${account.account_id}`, {
        method: "PATCH",
        json: { account_id: account.account_id, status: "disabled" },
        cookie: adminCookie,
        csrf: adminCsrf,
      }),
    ]);
    assert.equal(disableResult.status, 200);
    assert.ok([200, 403].includes(loginResult.status), "登录要么被停用拒绝要么成功");
    if (loginResult.status === 200) {
      const issuedSessionId = bodyAs<{ session: { session_id: string } }>(loginResult).session.session_id;
      const row = await safeQueryOne<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM app_sessions WHERE id = $1`,
        [issuedSessionId],
      );
      assert.ok(row && row.revoked_at !== null, "停用交错后签发的会话必须已撤销");
    }
  }
  passed += 1;

  assert.ok(base.startsWith("http://127.0.0.1"), "只服务回环地址");
}

/* --------------------------------- 主流程 --------------------------------- */

async function main(): Promise<void> {
  const cleanupIssues: string[] = [];
  const note = (label: string, detail: string) => {
    cleanupIssues.push(`${label}: ${detail}`);
    console.error(`[cleanup] ${label}: ${detail}`);
  };

  let db: IsolatedPostgres | null = null;
  let guard: ModelRequestGuard | null = null;
  let server: TrackedChild | null = null;
  let artifacts: GeneratedArtifactSnapshot | null = null;
  let completed = false;
  let failure: unknown = null;

  try {
    await offlineChecks();

    guard = await startModelRequestGuard();
    db = await startIsolatedPostgres({
      runId: RUN_ID,
      containerName: CONTAINER_NAME,
      dbName: DB_NAME,
      labelKey: LABEL_KEY,
      noteIssue: note,
    });
    assert.match(db.url, /^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/cga_auth1_check$/);

    delete process.env.PGDATABASE_URL;
    process.env.DATABASE_URL = db.url;
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    process.env.AUTH_TRUSTED_ORIGINS = origin;
    process.env.AUTH_SCHOOL_ID = "check-school";
    process.env.AUTH_COOKIE_SECURE = "false";
    process.env.AUTH_LOGIN_RATE_LIMIT_MAX = "3";
    process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS = "300";

    const setupClient = new Client({ connectionString: db.url });
    await setupClient.connect();
    try {
      await applySqlFile(setupClient, "initialize-demo-db.sql");
      await applySqlFile(setupClient, "upgrade-auth-v1.sql");
      await applySqlFile(setupClient, "upgrade-auth-v1.sql"); // 幂等
    } finally {
      await setupClient.end();
    }

    await databaseChecks("check-school");

    // 真实 HTTP：next dev（仅回环），模型出口改道守门，生成物快照后恢复
    artifacts = snapshotGeneratedArtifacts(ROOT);
    const require = createRequire(import.meta.url);
    const nextBin = require.resolve("next/dist/bin/next");
    const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    const childEnv: NodeJS.ProcessEnv = {
      ...modelGuardEnv(guard, process.env),
      DATABASE_URL: db.url,
      AUTH_TRUSTED_ORIGINS: origin,
      AUTH_SCHOOL_ID: "check-school",
      AUTH_COOKIE_SECURE: "false",
      AUTH_LOGIN_RATE_LIMIT_MAX: "3",
      AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS: "300",
    };
    delete childEnv.PGDATABASE_URL;
    const child = spawn(process.execPath, [nextBin, "dev", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: ROOT,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    server = trackChildProcess(child, { logFile: LOG_FILE });
    await waitForVerifiedService({ base: origin, port, child: server, timeoutMs: 180_000 });

    // 管理员已由数据库级初始化创建
    const adminLogin = await loginHttp({ base: origin, origin, adminCookie: "", adminCsrf: "" }, ADMIN_USERNAME, ADMIN_PASSWORD);
    assert.equal(adminLogin.status, 200, `管理员 HTTP 登录失败：${JSON.stringify(adminLogin.body)}`);
    const adminCookie = cookieHeader(adminLogin.setCookies, "cga_session");
    const adminCsrf = bodyAs<{ csrf: { token: string } }>(adminLogin).csrf.token;
    assert.ok(adminCookie);
    const context: HttpContext = { base: origin, origin, adminCookie, adminCsrf };

    await httpChecks(context);

    // 26) 数据库不可用：503 identity_unavailable，不降级匿名
    // 先关闭本检查进程的连接池（不再需要直连查询），再停止数据库；
    // 服务端子进程的连接失效由 pool-safety 的监听器兜底，查询路径 fail closed。
    if (globalThis.__pgPool) {
      await globalThis.__pgPool.end();
      globalThis.__pgPool = undefined;
    }
    const teardownReport = db.teardown();
    assert.equal(teardownReport.ok, true, `停止隔离数据库失败：${teardownReport.detail}`);
    db = null;
    const downStatus = await api(context, "/api/auth/status", { cookie: adminCookie });
    assert.equal(downStatus.status, 503);
    assert.deepEqual(bodyAs<{ state: { kind: string; reason?: string } }>(downStatus).state, {
      kind: "unavailable",
      reason: "identity_service_unavailable",
    });
    const downLogin = await loginHttp(context, ADMIN_USERNAME, ADMIN_PASSWORD);
    assert.equal(downLogin.status, 503);
    assert.equal(bodyAs<{ error: string }>(downLogin).error, "identity_unavailable");
    passed += 1;

    assert.equal(guard.hits, 0, "不得触达真实模型 provider");
    completed = true;
  } catch (error) {
    failure = error;
  }

  await runCleanupSteps(
      [
        {
          label: "next-server",
          run: async () => {
            if (!server) return;
            const report = await stopTrackedChildTree(server);
            if (!report.ok) note("next-server", report.detail);
          },
        },
        {
          label: "generated-artifacts",
          run: () => {
            if (!artifacts) return;
            const report = restoreGeneratedArtifacts(artifacts, ROOT);
            for (const issue of report.issues) note("generated-artifacts", issue);
          },
        },
        {
          label: "postgres-container",
          run: () => {
            if (!db) return { ok: true, detail: "已提前停止" };
            const report = db.teardown();
            db = null;
            return report;
          },
        },
        {
          label: "model-guard",
          run: async () => {
            if (guard) await guard.close();
          },
        },
        {
          label: "log-file",
          run: () => {
            if (fs.existsSync(LOG_FILE)) fs.rmSync(LOG_FILE, { force: true });
          },
        },
      ],
      note,
  );

  if (guard && guard.hits > 0) note("model-guard-hits", `检测到 ${guard.hits} 次真实模型请求`);
  assertCleanupComplete(cleanupIssues);
  if (failure) throw failure;
  if (!completed) throw new Error("AUTH1 检查未完成");
  console.log(
    JSON.stringify({
      passed,
      total: passed,
      offline: true,
      real_db: true,
      real_http: true,
      controlled_concurrency: true,
      model_requests: 0,
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
