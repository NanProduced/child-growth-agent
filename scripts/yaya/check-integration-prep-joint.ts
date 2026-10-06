/**
 * YAYA-PREP-INTEGRATE2 最小联合检查（组合候选专属，非正式聊天 API / 非浏览器闭环）
 *
 * 真实层：QA 种子一次性隔离 PG + 对象目录；真实 scoped 读取（AUTH 会话表）；
 *        真实 READ1 registry + 真实 Agent 内核；模型为进程内替身（0 真实 provider 请求）。
 * 替身层：模型输出与 APP 重核装配（正式 AGENT-APP1 装配仍是 NOT_RUN）。
 *
 * 覆盖接缝：
 * 1. QA 种子创建自有隔离数据（回读 62 项）
 * 2. 当前账号经真实 scoped 读取获得 READ1 结果（citable_source / 完整依赖）
 * 3. 内核循环：读取列表 → 再次读取后引用早先 citable_source → 回答；错引用拒绝
 * 4. 内核事件 → API0 线事件：编解码、run_id/seq、唯一终态、终态内容、停止详情脱敏
 * 5. 真实空列表 / 无权限(empty_scope/out_of_scope) / not_found 分离
 * 6. 重核依赖完整保留（成长档案依据为离线替身，明确标注）
 *
 * 运行：pnpm exec tsx scripts/yaya/check-integration-prep-joint.ts
 */
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { startModelRequestGuard, modelGuardEnv } from '../harness-safety';
import { createSessionToken } from '../../src/lib/accounts/session';
import { createAcceptanceSeed, type AcceptanceSeedHandle } from './acceptance/seed';
import { createYayaReadRegistry } from '../../src/lib/yaya/tools/read/index';
import { runYayaAgent, type YayaAgentDependencies, type YayaCurrentIdentity } from '../../src/lib/yaya/agent/index';
import {
  encodeYayaRunEventLine,
  parseYayaRunWireLine,
  projectYayaAgentEvent,
  projectYayaRunEnd,
  safeYayaStopDetail,
  validateYayaRunEventStream,
  type YayaRunWireEvent,
} from '../../src/lib/yaya/api-contract';

let passed = 0;
function check(condition: unknown, label: string): void {
  assert.ok(condition, label);
  passed += 1;
}

const carrier = (token: string) => ({
  headers: new Headers({ cookie: `cga_session=${token}` }),
});

async function runJoint(): Promise<number> {
  assert.equal(globalThis.__pgPool, undefined, 'joint check must run in a fresh process');
  const guard = await startModelRequestGuard();
  Object.assign(process.env, modelGuardEnv(guard));
  process.env.AUTH_TRUSTED_ORIGINS = 'http://127.0.0.1:3000';

  let seed: AcceptanceSeedHandle | null = null;
  let sessionClient: Client | null = null;
  const cleanupIssues: string[] = [];
  let failure: unknown = null;
  try {
    seed = await createAcceptanceSeed();
    const handle = seed;
    const manifest = handle.manifest;

    /* 1. 种子自行回读（真实隔离库事实） */
    check(handle.verification.failed === 0, 'QA seed verification has no failures');
    check(handle.verification.passed === 62, `QA seed read-back is 62 checks (got ${handle.verification.passed})`);

    /* 真实 AUTH 会话：种子账号 + app_sessions 会话表（读取路径的真实身份来源） */
    sessionClient = new Client({ connectionString: handle.database_url });
    await sessionClient.connect();
    const sessionFor = async (account: { account_id: string }) => {
      const token = createSessionToken();
      await sessionClient!.query(
        'INSERT INTO app_sessions (account_id,token_hash,expires_at) VALUES ($1,$2,now()+interval \'1 day\')',
        [account.account_id, token.tokenHash],
      );
      return token.token;
    };
    const teacherA = manifest.accounts.teacher_a;
    const teacherB = manifest.accounts.teacher_b;
    const teacherC = manifest.accounts.teacher_c;
    const admin = manifest.accounts.admin;
    const teacherAToken = await sessionFor(teacherA);
    const teacherBToken = await sessionFor(teacherB);
    const teacherCToken = await sessionFor(teacherC);
    const adminToken = await sessionFor(admin);

    const registry = createYayaReadRegistry();
    const run = (token: string, tool: string, params: unknown = {}) =>
      registry.dispatch({ tool, params }, { request: carrier(token) });

    /* 2. 真实 scoped 读取 + 来源协议（citable_source / recheck_dependencies） */
    const list = await run(teacherAToken, 'list_children');
    check(list.ok, 'teacher_a real scoped list_children is ok');
    if (!list.ok) throw new Error('list_children must succeed');
    const listPayload = list.data as {
      citable_source: { ref_id: string };
      recheck_dependencies: Array<{ ref_id: string }>;
      data: { children: Array<{ child_id: string }> };
    };
    check(listPayload.citable_source.ref_id === 'children:current_scope', 'list citable_source is the primary ref');
    const depRefs = listPayload.recheck_dependencies.map((entry) => entry.ref_id);
    check(depRefs[0] === 'children:current_scope', 'recheck_dependencies[0] is the citable source');
    for (const key of ['class_a_same_name', 'class_b_draft', 'fault_unreadable'] as const) {
      check(depRefs.includes(`child:${manifest.children[key].id}`), `list dependencies keep every child (${key})`);
    }
    check(
      listPayload.data.children.some((child) => child.child_id === manifest.children.class_a_same_name.id),
      'list returns the seeded child through real scope',
    );

    /* 5. 空列表 / 无权限 / not_found 分离 */
    const emptyList = await run(teacherAToken, 'list_observations', {
      child_id: manifest.children.class_b_draft.id,
      status: 'confirmed',
    });
    check(emptyList.ok, 'real empty list is ok, not an error');
    if (emptyList.ok) {
      const emptyPayload = emptyList.data as { data: { observations: unknown[] }; citable_source: { ref_id: string } };
      check(emptyPayload.data.observations.length === 0, 'real empty list carries no fabricated rows');
      check(emptyPayload.citable_source.ref_id === 'observations:current_scope', 'empty list still has a citable source');
    }
    const emptyScope = await run(teacherCToken, 'list_children');
    check(!emptyScope.ok && emptyScope.code === 'empty_scope', 'unassigned teacher is empty_scope, not an empty list');
    const outOfScope = await run(teacherBToken, 'get_class', { class_id: manifest.classes.class_a.id });
    check(!outOfScope.ok && outOfScope.code === 'out_of_scope', 'cross-class read is out_of_scope, not empty');
    const notFound = await run(adminToken, 'get_observation', { observation_id: '00000000-0000-4000-8000-000000000000' });
    check(!notFound.ok && notFound.code === 'not_found', 'unknown observation is not_found for admin, not an empty success');

    /* 3+4. 真实内核 + 进程内模型替身；事件 → API0 线事件 */
    const identity: YayaCurrentIdentity = {
      run_id: 'joint-run',
      identity_state: 'authenticated',
      session_valid: true,
      principal: {
        account_id: teacherA.account_id,
        username: teacherA.username,
        display_name: teacherA.display_name,
        role: 'teacher',
        account_status: 'active',
        scope: { kind: 'classes', class_ids: teacherA.current_class_keys.map((key) => manifest.classes[key].id) },
      },
    };
    const wireRoundTrip = (runId: string, result: Awaited<ReturnType<typeof runYayaAgent>>) => {
      const wire: YayaRunWireEvent[] = [
        ...result.events.map((event, index) => projectYayaAgentEvent(event, { run_id: runId, seq: index + 1 })),
        projectYayaRunEnd(result.outcome, { run_id: runId, seq: result.events.length + 1 }),
      ];
      const lines = wire.map(encodeYayaRunEventLine);
      check(lines.every((line) => line.endsWith('\n')), 'every wire line is NDJSON-terminated');
      const decoded = lines.map((line) => parseYayaRunWireLine(line.slice(0, -1)));
      check(decoded.every((entry) => entry.ok), 'every encoded line parses back');
      const events = decoded
        .map((entry) => (entry.ok ? entry.value : null))
        .filter((value): value is YayaRunWireEvent => value !== null);
      return { wire, verdict: validateYayaRunEventStream(events, runId) };
    };

    const engineRun = async (citedRef: string | null) => {
      const runId = `joint-${Math.random().toString(36).slice(2, 10)}`;
      let modelCalls = 0;
      const deps: YayaAgentDependencies = {
        model: {
          generate: async () => {
            modelCalls += 1;
            const content =
              modelCalls === 1
                ? { action: 'read', content: '', tool: 'list_children', params_json: '{}', source_refs: [] }
                : modelCalls === 2
                  ? { action: 'read', content: '', tool: 'list_observations', params_json: '{}', source_refs: [] }
                  : {
                      action: 'answer',
                      content: '已按当前范围列出可读幼儿。',
                      tool: '',
                      params_json: '',
                      source_refs: citedRef ? [citedRef] : [],
                    };
            return { provider: 'in-process-double', model: 'double', usage: null, content: JSON.stringify(content) };
          },
        },
        resolveCurrentIdentity: async ({ run_id }) => ({ ...identity, run_id }),
        loadProjectedContext: async () => ({ history: [], sources: [], images: [], guide_catalog: null }),
        revalidateProjectedContext: async () => ({ ok: true }),
        readTool: (input) =>
          registry.dispatch({ tool: input.tool, params: input.params }, { request: carrier(teacherAToken) }),
        proposeWrite: async () => ({ ok: false, code: 'unsupported', message: 'read-only joint check' }),
        queryOperation: async () => ({ kind: 'unknown', reason: 'no_receipt' }),
        publicSearchPolicy: { provider_enabled: false, scanChildIdentifiers: async () => 'unknown' },
        tools: { read_tools: registry.definitions, write_tools: [] },
      };
      const result = await runYayaAgent(deps, { run_id: runId, user_text: '列出可读幼儿' });
      return { runId, modelCalls, result };
    };

    const positive = await engineRun('children:current_scope');
    check(
      positive.result.outcome.kind === 'answered' &&
        positive.result.outcome.sources.some((source) => source.ref_id === 'children:current_scope'),
      'kernel: answer can cite the earlier citable source after a later read (no source eviction)',
    );
    const positiveWire = wireRoundTrip(positive.runId, positive.result);
    check(positiveWire.verdict.ok, 'API0 stream: encoded kernel stream validates');
    if (positiveWire.verdict.ok) {
      check(positiveWire.verdict.outcome.kind === 'answered', 'API0 stream: unique terminal matches the answered outcome');
      check(
        positiveWire.verdict.event_count === positive.result.events.length + 1,
        'API0 stream: run_id/seq of every event round-trips (plus the single run_end)',
      );
    }

    const negative = await engineRun(`child:${manifest.children.class_a_same_name.id}`);
    check(
      negative.result.outcome.kind === 'stopped' && negative.result.outcome.reason === 'source_mismatch',
      'kernel: dependency id citation stays rejected (source_mismatch)',
    );
    const negativeWire = wireRoundTrip(negative.runId, negative.result);
    check(negativeWire.verdict.ok, 'API0 stream: stopped stream validates with a single terminal');
    if (negativeWire.verdict.ok && negativeWire.verdict.outcome.kind === 'stopped') {
      check(
        negativeWire.verdict.outcome.reason === 'source_mismatch' &&
          negativeWire.verdict.outcome.detail === safeYayaStopDetail('source_mismatch'),
        'API0 stream: stopped detail is redacted to the protocol text',
      );
    }

    /* 6. 重核依赖完整保留（本段为替身探测：正式 APP 重核装配仍 NOT_RUN） */
    const observation = await run(teacherAToken, 'get_observation', { observation_id: manifest.observations.a1_h1.id });
    check(observation.ok, 'observation read is ok');
    if (observation.ok) {
      const payload = observation.data as {
        citable_source: { ref_id: string };
        recheck_dependencies: Array<{ ref_id: string }>;
        data: { content_sources: Record<string, { kind: string } | null> };
      };
      check(
        payload.citable_source.ref_id === `observation:${manifest.observations.a1_h1.id}`,
        'observation primary source is the object itself',
      );
      check(
        payload.recheck_dependencies.some((entry) => entry.ref_id === `observation:${manifest.observations.a1_h1.id}`),
        'observation dependencies keep the object ref',
      );
      check(
        payload.data.content_sources.raw_text?.kind === 'child_fact' &&
          payload.data.content_sources.ai_draft?.kind === 'model_text',
        'observation layers raw fact vs AI draft instead of folding them',
      );
    }

    check(guard.hits === 0, 'joint check made zero real provider requests');
  } catch (error) {
    failure = error;
  } finally {
    if (sessionClient) {
      await sessionClient.end().catch((error: unknown) => cleanupIssues.push(`session-client: ${String(error)}`));
    }
    if (seed) {
      await seed.teardown().catch((error: unknown) => cleanupIssues.push(`seed-teardown: ${String(error)}`));
    }
    await guard.close().catch((error: unknown) => cleanupIssues.push(`model-guard: ${String(error)}`));
  }
  if (failure) throw failure;
  if (cleanupIssues.length > 0) throw new Error(`joint check cleanup incomplete: ${cleanupIssues.join('; ')}`);
  return passed;
}

runJoint()
  .then((count) => {
    console.log(
      JSON.stringify({
        ok: true,
        passed: count,
        layers: {
          seed: 'QA acceptance seed (real isolated PostgreSQL + object root, 62 read-backs)',
          reads: 'real READ1 registry over real AUTH sessions/scoped reads',
          kernel: 'real runYayaAgent with in-process model double',
          wire: 'real API0 encode/decode/stream validation',
          recheck_substitute: 'dependency presence probe only; formal AGENT-APP1 recheck assembly is NOT_RUN',
          growth_profile_recheck: 'offline substitute in check-tools-read (seed has no AI growth summary)',
        },
        real_model_requests: 0,
        cleanup: 'verified',
        not_formal_chat_api: true,
        not_browser_loop: true,
      }),
    );
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
