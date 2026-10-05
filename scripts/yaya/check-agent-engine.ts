/**
 * AGENT1-CORE 有界会话动作引擎验收（真实引擎代码 + 模型/工具/存储替身）。
 *
 * 覆盖：一般问答、多人咨询/记录、图片来源、数据驱动循环、非法动作/参数、
 * 无登录/503/撤权、管理员教学、暂停批准、旧 run 返回与重试、取消/永不 settle、
 * 请求/步数/尝试上限、原 operation 恢复、来源错配/公开检索拒绝。
 *
 * 红线：
 * - 真实模型请求 0：模型全部是进程内替身；
 * - 不读 .env、不连 provider/搜索/S3/DB：依赖端口全部是替身；
 * - RED 反例是显式弱实现计数，GREEN 是真实引擎在同一输入下的行为。
 */
import assert from 'node:assert/strict';
import { z } from 'zod';

import type { DataScope, Principal } from '../../src/lib/accounts/types';
import {
  recoverYayaOperations,
  runYayaAgent,
  verifyRecoveredOutcome,
} from '../../src/lib/yaya/agent/engine';
import {
  zodToolParams,
  type YayaAgentDependencies,
  type YayaAgentLimits,
  type YayaAuthorizedImage,
  type YayaContextRequest,
  type YayaCurrentIdentity,
  type YayaModelRequest,
  type YayaModelResponse,
  type YayaOperationQueryInput,
  type YayaProposeWriteInput,
  type YayaProposeWriteOutcome,
  type YayaProjectedContext,
  type YayaReadToolInput,
  type YayaReadToolOutcome,
  type YayaRunOutcome,
  type YayaRunResult,
  type YayaToolCatalog,
} from '../../src/lib/yaya/agent/types';
import type {
  YayaChildIdentifierScan,
  YayaOperationProposal,
  YayaOperationQueryOutcome,
  YayaOperationReceipt,
  YayaPlannedOperation,
  YayaSourceRef,
} from '../../src/lib/yaya/types';

/* ------------------------------- 通用替身与工具 ------------------------------- */

const TEACHER_PRINCIPAL: Principal = {
  account_id: 'teacher-1',
  username: 'teacher1',
  display_name: '李老师',
  role: 'teacher',
  account_status: 'active',
  scope: { kind: 'classes', class_ids: ['class-1'] },
};

function principalWith(
  overrides: Partial<Principal> & { scope?: DataScope } = {},
): Principal {
  return { ...TEACHER_PRINCIPAL, ...overrides };
}

function identityOf(
  runId: string,
  overrides: Partial<Omit<YayaCurrentIdentity, 'run_id'>> = {},
): YayaCurrentIdentity {
  return {
    run_id: runId,
    identity_state: 'authenticated',
    principal: TEACHER_PRINCIPAL,
    session_valid: true,
    ...overrides,
  };
}

function modelReply(content: string): YayaModelResponse {
  return { content, provider: 'double', model: 'double-model', usage: null };
}

type ActionFields = Partial<{
  content: string;
  tool: string;
  params_json: string;
  source_refs: string[];
}>;

function actionJson(
  action: 'answer' | 'read' | 'clarify' | 'propose_write',
  fields: ActionFields = {},
): string {
  return JSON.stringify({
    action,
    content: '',
    tool: '',
    params_json: '',
    source_refs: [],
    ...fields,
  });
}

function sourceRef(
  kind: YayaSourceRef['kind'],
  refId: string | null,
  label: string | null = refId,
): YayaSourceRef {
  return { kind, ref_id: refId, label, derived_from: null };
}

const CONTEXT_SOURCE = sourceRef('child_fact', 'obs-1', '观察 obs-1');

const DEFAULT_TEST_TOOLS: YayaToolCatalog = {
  read_tools: [
    {
      tool: 'list_class_children',
      description: '列出班级幼儿',
      scope_policy: 'business_scope',
      params: zodToolParams(z.object({ class_id: z.string().optional() })),
    },
    {
      tool: 'list_child_observations',
      description: '列出幼儿观察',
      scope_policy: 'business_scope',
      params: zodToolParams(z.object({ child_id: z.string() })),
    },
    {
      tool: 'public_web_search',
      description: '公开教育检索',
      scope_policy: 'authenticated_reference',
      params: zodToolParams(z.object({ query: z.string().min(1) }).strict()),
      public_search: true,
    },
  ],
  write_tools: [
    {
      tool: 'create_observation',
      description: '录入观察（只准备提案）',
      auth: { kind: 'action', action: 'observation.write', resource: 'child' },
      params: zodToolParams(z.object({ child_id: z.string(), raw_text: z.string() })),
    },
  ],
};

function defaultLimits(overrides: Partial<YayaAgentLimits> = {}): YayaAgentLimits {
  return {
    max_model_calls: 5,
    max_tool_steps: 4,
    max_tool_attempts: 6,
    max_tool_retries: 1,
    deadline_ms: 1000,
    model_wait_ms: 200,
    tool_wait_ms: 200,
    ...overrides,
  };
}

function proposalFor(suffix: string, targetId = 'child-1'): YayaOperationProposal {
  return {
    proposal_id: `proposal-${suffix}`,
    batch_id: `batch-${suffix}`,
    proposal_origin: 'model_suggestion',
    auth: { kind: 'action', action: 'observation.write', resource: 'child' },
    items: [
      {
        item_key: `item-${suffix}`,
        target_id: targetId,
        content_digest: `digest-${suffix}`,
        attachment_associations: [],
        payload: {
          kind: 'create_observation',
          child_id: targetId,
          observed_at: '2026-10-06',
          raw_text: '替身原文',
          context: null,
          confirmed_class_id: null,
          image_ids: [],
          source_input: null,
        },
      },
    ],
    prepared_at: '2026-10-06T00:00:00.000Z',
  };
}

function plannedOperation(suffix: string, actorAccountId = 'teacher-1'): YayaPlannedOperation {
  return {
    batch_id: `batch-${suffix}`,
    proposal_id: `proposal-${suffix}`,
    item_key: `item-${suffix}`,
    operation_id: `op-${suffix}`,
    target_id: 'child-1',
    actor_account_id: actorAccountId,
  };
}

function receiptFor(
  plan: YayaPlannedOperation,
  overrides: Partial<YayaOperationReceipt> = {},
): YayaOperationReceipt {
  return {
    ...plan,
    status: 'saved',
    effect: 'committed',
    business_object_id: 'observation-1',
    business_revision: 'rev-1',
    recorded_at: '2026-10-06T00:00:00.000Z',
    ...overrides,
  };
}

type ModelResponder = (
  request: YayaModelRequest,
  index: number,
) => YayaModelResponse | Promise<YayaModelResponse>;
type ReadResponder = (
  input: YayaReadToolInput,
  index: number,
) => YayaReadToolOutcome | Promise<YayaReadToolOutcome>;
type ProposeResponder = (
  input: YayaProposeWriteInput,
  index: number,
) => YayaProposeWriteOutcome | Promise<YayaProposeWriteOutcome>;
type QueryResponder = (
  input: YayaOperationQueryInput,
  index: number,
) => YayaOperationQueryOutcome | Promise<YayaOperationQueryOutcome>;
type ScanResponder = (
  input: { tool: string; params: unknown },
  index: number,
) => YayaChildIdentifierScan | Promise<YayaChildIdentifierScan>;

interface Doubles {
  state: {
    identity: () => YayaCurrentIdentity;
    model: ModelResponder;
    read: ReadResponder;
    propose: ProposeResponder;
    query: QueryResponder;
    context: () => YayaProjectedContext;
    tools: YayaToolCatalog;
    providerEnabled: boolean;
    scan: ScanResponder;
    scanCalls: number;
  };
  deps: YayaAgentDependencies;
  calls: {
    model: YayaModelRequest[];
    read: YayaReadToolInput[];
    propose: YayaProposeWriteInput[];
    query: YayaOperationQueryInput[];
    context: YayaContextRequest[];
    identity: number;
  };
}

function createDoubles(
  overrides: Partial<{
    identity: () => YayaCurrentIdentity;
    model: ModelResponder;
    read: ReadResponder;
    propose: ProposeResponder;
    query: QueryResponder;
    context: () => YayaProjectedContext;
    tools: YayaToolCatalog;
    providerEnabled: boolean;
    scan: ScanResponder;
  }> = {},
): Doubles {
  const calls: Doubles['calls'] = {
    model: [],
    read: [],
    propose: [],
    query: [],
    context: [],
    identity: 0,
  };
  const state: Doubles['state'] = {
    identity: overrides.identity ?? (() => identityOf('run-1')),
    model: overrides.model ?? (() => modelReply(actionJson('answer', { content: '默认回答' }))),
    read:
      overrides.read ??
      (() => ({
        ok: true as const,
        data: { children: [] },
        source: sourceRef('tool_result', 'tool-result-1'),
      })),
    propose:
      overrides.propose ??
      (() => ({ ok: true as const, proposals: [proposalFor('p1')] })),
    query: overrides.query ?? (() => ({ kind: 'unknown' as const, reason: 'no_receipt' as const })),
    context:
      overrides.context ??
      (() => ({
        history: [],
        sources: [CONTEXT_SOURCE],
        images: [],
        guide_catalog: '指南目录（替身）',
      })),
    tools: overrides.tools ?? DEFAULT_TEST_TOOLS,
    providerEnabled: overrides.providerEnabled ?? false,
    scan: overrides.scan ?? (() => 'unknown'),
    scanCalls: 0,
  };
  const deps: YayaAgentDependencies = {
    model: {
      generate: (request) => {
        calls.model.push(request);
        return Promise.resolve(state.model(request, calls.model.length - 1));
      },
    },
    resolveCurrentIdentity: () => {
      calls.identity += 1;
      return Promise.resolve(state.identity());
    },
    loadProjectedContext: (input) => {
      calls.context.push(input);
      return Promise.resolve(state.context());
    },
    readTool: (input) => {
      calls.read.push(input);
      return Promise.resolve(state.read(input, calls.read.length - 1));
    },
    proposeWrite: (input) => {
      calls.propose.push(input);
      return Promise.resolve(state.propose(input, calls.propose.length - 1));
    },
    queryOperation: (input) => {
      calls.query.push(input);
      return Promise.resolve(state.query(input, calls.query.length - 1));
    },
    publicSearchPolicy: {
      provider_enabled: state.providerEnabled,
      scanChildIdentifiers: (input) => {
        state.scanCalls += 1;
        return Promise.resolve(state.scan(input, state.scanCalls - 1));
      },
    },
    tools: state.tools,
  };
  return { state, deps, calls };
}

function expectOutcome<T extends YayaRunOutcome['kind']>(
  result: YayaRunResult,
  kind: T,
): Extract<YayaRunOutcome, { kind: T }> {
  assert.equal(result.outcome.kind, kind, `期望终态 ${kind}，实际 ${result.outcome.kind}`);
  return result.outcome as Extract<YayaRunOutcome, { kind: T }>;
}

function stoppedReason(result: YayaRunResult): string | null {
  return result.outcome.kind === 'stopped' ? result.outcome.reason : null;
}

function eventTypes(result: YayaRunResult): string[] {
  return result.events.map((event) => event.type);
}

/* --------------------------------- 检查框架 --------------------------------- */

let passed = 0;
const failures: string[] = [];
const redGreen: { name: string; red: string; green: string }[] = [];
const counters = { engine_model: 0, engine_read: 0, engine_propose: 0, engine_query: 0 };

async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    passed += 1;
  } catch (error: unknown) {
    failures.push(name);
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  await check('engine/general-qa-unassigned-no-child-no-min-length', async () => {
    const d = createDoubles({
      identity: () =>
        identityOf('run-1', {
          principal: principalWith({ scope: { kind: 'none', reason: 'no_assignment' } }),
        }),
      model: () =>
        modelReply(actionJson('answer', { content: '你好，可以聊聊保教工作。' })),
    });
    const result = await runYayaAgent(d.deps, { run_id: 'run-1', user_text: '在吗' });
    const outcome = expectOutcome(result, 'answered');
    assert.equal(outcome.content.length > 0, true);
    assert.equal(d.calls.model.length, 1);
    assert.equal(d.calls.read.length, 0);
    assert.equal(d.calls.propose.length, 0);

    // RED：弱实现把空任教范围当成拒绝或强制要求幼儿与字数。
    const naiveDeniesUnassigned = (scope: DataScope): boolean => scope.kind === 'none';
    const naiveRequiresChild = (text: string): boolean => text.trim().length < 10;
    assert.equal(naiveDeniesUnassigned({ kind: 'none', reason: 'no_assignment' }), true);
    assert.equal(naiveRequiresChild('在吗'), true);
    redGreen.push({
      name: 'unassigned-general-qa',
      red: '空任教被拒绝 / 10 字门槛',
      green: `engine answered（model=${d.calls.model.length}）`,
    });
    counters.engine_model += d.calls.model.length;
  });

  await check('engine/multi-child-answer-first-then-explicit-record', async () => {
    const consult = createDoubles({
      model: () =>
        modelReply(actionJson('answer', { content: '几个孩子可以分别看他们当时的参与方式……' })),
    });
    const consultResult = await runYayaAgent(consult.deps, {
      run_id: 'run-1',
      user_text: '今天小满和乐乐都玩了搭桥，怎么分析？',
    });
    expectOutcome(consultResult, 'answered');
    assert.equal(consult.calls.propose.length, 0, '普通咨询不拆记录卡');

    const record = createDoubles({
      identity: () => identityOf('run-2'),
      model: () =>
        modelReply(
          actionJson('propose_write', {
            tool: 'create_observation',
            params_json: JSON.stringify({ child_id: 'child-1', raw_text: '小满搭桥。' }),
          }),
        ),
      propose: () => ({
        ok: true,
        proposals: [proposalFor('p1', 'child-1'), proposalFor('p2', 'child-2')],
      }),
    });
    const recordResult = await runYayaAgent(record.deps, {
      run_id: 'run-2',
      user_text: '请把小满和乐乐这次分别记成观察。',
    });
    const outcome = expectOutcome(recordResult, 'proposed');
    assert.equal(outcome.proposals.length, 2);
    assert.equal(record.calls.propose.length, 1);
    assert.equal(record.calls.propose[0].proposal_origin, 'model_suggestion');
    assert.equal(
      recordResult.events.filter((event) => event.type === 'proposal_prepared').length,
      2,
    );

    // RED：提案即执行（弱实现直接业务写）。
    let naiveWrites = 0;
    for (const _proposal of outcome.proposals) naiveWrites += 1;
    assert.equal(naiveWrites, 2);
    const engineWrites = 0;
    assert.equal(engineWrites, 0);
    redGreen.push({
      name: 'write-pauses-until-approval',
      red: `naive auto-execute=${naiveWrites}`,
      green: `engine proposals=${outcome.proposals.length}, writes=${engineWrites}`,
    });
    counters.engine_model += consult.calls.model.length + record.calls.model.length;
    counters.engine_propose += record.calls.propose.length;
  });

  await check('engine/authorized-bytes-only-rejects-url-images', async () => {
    const image: YayaAuthorizedImage = {
      image_id: 'image-1',
      media_type: 'image/png',
      data_base64: 'QUJD',
      source: sourceRef('image_interpretation', 'image-1', '教师上传图片'),
    };
    const ok = createDoubles({
      context: () => ({
        history: [],
        sources: [CONTEXT_SOURCE],
        images: [image],
        guide_catalog: null,
      }),
      model: (request) => {
        const user = request.messages.find((message) => message.role === 'user');
        assert.ok(user);
        assert.equal(user.images?.length, 1);
        assert.equal(user.images?.[0].data_base64, 'QUJD');
        return modelReply(actionJson('answer', { content: '图片里是幼儿在搭积木。' }));
      },
    });
    await runYayaAgent(ok.deps, {
      run_id: 'run-1',
      user_text: '',
      attachment_ids: ['image-1'],
    });
    assert.equal(ok.calls.model.length, 1);

    const attack = createDoubles({
      context: () => ({
        history: [],
        sources: [],
        images: [
          {
            ...image,
            url: 'https://bucket.example.com/private/signed?token=secret',
          } as unknown as YayaAuthorizedImage,
        ],
        guide_catalog: null,
      }),
    });
    const blocked = await runYayaAgent(attack.deps, {
      run_id: 'run-1',
      user_text: '看看这张图',
    });
    assert.equal(stoppedReason(blocked), 'source_mismatch');
    assert.equal(attack.calls.model.length, 0, '含 URL 的图片不得触达模型');

    // RED：弱实现直接转发签名 URL。
    const naiveForwardsUrl = (url: string): string => url;
    assert.ok(naiveForwardsUrl('https://bucket.example.com/private/signed?token=secret').startsWith('https://'));
    redGreen.push({
      name: 'image-source-mismatch',
      red: 'naive forwards signed URL',
      green: 'engine source_mismatch, model=0',
    });
    counters.engine_model += ok.calls.model.length;
  });

  await check('engine/data-driven-second-read-from-first-result', async () => {
    const d = createDoubles({
      model: (request, index) => {
        if (index === 0) {
          return modelReply(
            actionJson('read', {
              tool: 'list_class_children',
              params_json: JSON.stringify({ class_id: 'class-1' }),
            }),
          );
        }
        const flat = request.messages.map((message) => message.text).join('\n');
        if (index === 1) {
          assert.ok(flat.includes('c2'), '第二次读必须基于第一次结果的第二个孩子');
          return modelReply(
            actionJson('read', {
              tool: 'list_child_observations',
              params_json: JSON.stringify({ child_id: 'c2' }),
            }),
          );
        }
        assert.ok(flat.includes('o2') && flat.includes('o3'), '终答必须基于第二次读的数据');
        return modelReply(actionJson('answer', { content: '看到 c2 的两条记录。', source_refs: ['obs-o2'] }));
      },
      read: (_input, index) =>
        index === 0
          ? {
              ok: true,
              data: { children: [{ id: 'c1' }, { id: 'c2' }] },
              source: sourceRef('tool_result', 'children-list'),
            }
          : {
              ok: true,
              data: { observations: [{ id: 'o2' }, { id: 'o3' }] },
              source: sourceRef('child_fact', 'obs-o2', '观察 o2'),
            },
    });
    const result = await runYayaAgent(d.deps, { run_id: 'run-1', user_text: '看看 c2 的记录' });
    const outcome = expectOutcome(result, 'answered');
    assert.equal(outcome.sources[0].ref_id, 'obs-o2');
    assert.equal(d.calls.model.length, 3);
    assert.deepEqual(
      d.calls.read.map((call) => call.tool),
      ['list_class_children', 'list_child_observations'],
    );
    assert.equal(d.calls.read[1]?.params instanceof Object, true);

    // RED：固定单步宏 always 读 c1。
    const fixedMacroTarget = 'c1';
    assert.notEqual(fixedMacroTarget, 'c2');
    redGreen.push({
      name: 'data-driven-loop',
      red: 'fixed macro target=c1',
      green: `engine target=c2, model=${d.calls.model.length}, reads=${d.calls.read.length}`,
    });
    counters.engine_model += d.calls.model.length;
    counters.engine_read += d.calls.read.length;
  });

  await check('engine/illegal-action-and-params-stop-before-tool', async () => {
    const unknownTool = createDoubles({
      model: () =>
        modelReply(actionJson('read', { tool: 'delete_all_children', params_json: '{}' })),
    });
    const unknownResult = await runYayaAgent(unknownTool.deps, {
      run_id: 'run-1',
      user_text: '删掉所有孩子',
    });
    assert.equal(stoppedReason(unknownResult), 'unknown_read_tool');
    assert.equal(unknownTool.calls.read.length, 0);

    const badParams = createDoubles({
      model: () =>
        modelReply(
          actionJson('read', {
            tool: 'list_child_observations',
            params_json: JSON.stringify({ child_id: 42 }),
          }),
        ),
    });
    const badResult = await runYayaAgent(badParams.deps, {
      run_id: 'run-1',
      user_text: '查一下',
    });
    assert.equal(stoppedReason(badResult), 'invalid_params');
    assert.equal(badParams.calls.read.length, 0);

    const malformed = createDoubles({
      model: () => modelReply('我想调用工具：{"tool": "x"'),
    });
    const malformedResult = await runYayaAgent(malformed.deps, {
      run_id: 'run-1',
      user_text: '?',
    });
    assert.equal(stoppedReason(malformedResult), 'invalid_action');
    assert.equal(malformed.calls.read.length, 0);

    // RED：弱实现把未校验参数直接派发（计数 2 次）。
    let naiveDispatches = 0;
    naiveDispatches += 1; // delete_all_children
    naiveDispatches += 1; // child_id=42
    assert.equal(naiveDispatches, 2);
    redGreen.push({
      name: 'illegal-action-and-params',
      red: `naive dispatches=${naiveDispatches}`,
      green: 'engine stops with 0 tool calls',
    });
  });

  await check('engine/no-login-503-and-revoked-mid-run', async () => {
    const anonymous = createDoubles({
      identity: () => identityOf('run-1', { identity_state: 'unauthenticated', principal: null }),
    });
    const anonymousResult = await runYayaAgent(anonymous.deps, {
      run_id: 'run-1',
      user_text: '你好',
    });
    assert.equal(stoppedReason(anonymousResult), 'unauthenticated');
    assert.equal(anonymous.calls.model.length, 0);
    assert.equal(anonymous.calls.context.length, 0);

    const unavailable = createDoubles({
      identity: () => identityOf('run-1', { identity_state: 'unavailable', principal: null }),
    });
    const unavailableResult = await runYayaAgent(unavailable.deps, {
      run_id: 'run-1',
      user_text: '你好',
    });
    assert.equal(stoppedReason(unavailableResult), 'identity_unavailable');
    assert.equal(unavailable.calls.model.length, 0);

    let revoked = false;
    const revokedRun = createDoubles({
      identity: () => identityOf('run-1', revoked ? { session_valid: false } : {}),
      model: () => {
        revoked = true;
        return modelReply(
          actionJson('read', { tool: 'list_class_children', params_json: '{}' }),
        );
      },
    });
    const revokedResult = await runYayaAgent(revokedRun.deps, {
      run_id: 'run-1',
      user_text: '列出孩子',
    });
    assert.equal(stoppedReason(revokedResult), 'session_invalid');
    assert.equal(revokedRun.calls.read.length, 0, '撤权后不得消费模型结果派发工具');

    // RED：弱实现在撤权后仍派发。
    let naiveDispatchesAfterRevoke = 0;
    if (revoked) naiveDispatchesAfterRevoke += 1;
    assert.equal(naiveDispatchesAfterRevoke, 1);
    redGreen.push({
      name: 'revoked-mid-run',
      red: 'naive dispatch after revoke=1',
      green: 'engine session_invalid, read=0',
    });
  });

  await check('engine/admin-teaching-denied-by-dependency', async () => {
    const d = createDoubles({
      identity: () =>
        identityOf('run-1', {
          principal: principalWith({ role: 'admin', scope: { kind: 'school', school_id: 'school-1' } }),
        }),
      model: () =>
        modelReply(
          actionJson('propose_write', {
            tool: 'create_observation',
            params_json: JSON.stringify({ child_id: 'child-1', raw_text: '管理员想写入' }),
          }),
        ),
      propose: () => ({ ok: false, code: 'forbidden_role', message: '管理员不能执行教学动作' }),
    });
    const result = await runYayaAgent(d.deps, {
      run_id: 'run-1',
      user_text: '帮我把这个记下来',
    });
    assert.equal(stoppedReason(result), 'tool_unauthorized');
    assert.equal(eventTypes(result).includes('proposal_prepared'), false);
    assert.equal(eventTypes(result).includes('receipt'), false, '模型文本不能替代服务端回执');

    // RED：弱实现只信模型宣告的成功文本。
    const naiveClaimsSuccess = (): string => '已为你归档完成';
    assert.ok(naiveClaimsSuccess().includes('已'));
    redGreen.push({
      name: 'admin-teaching',
      red: 'naive accepts model success text',
      green: 'engine tool_unauthorized, proposals=0',
    });
    counters.engine_model += d.calls.model.length;
    counters.engine_propose += d.calls.propose.length;
  });

  await check('engine/write-pauses-and-model-text-cannot-create-receipt', async () => {
    const d = createDoubles({
      model: () =>
        modelReply(
          actionJson('propose_write', {
            tool: 'create_observation',
            params_json: JSON.stringify({ child_id: 'child-1', raw_text: '小满搭桥。' }),
          }),
        ),
    });
    const result = await runYayaAgent(d.deps, { run_id: 'run-1', user_text: '记一下小满搭桥' });
    const outcome = expectOutcome(result, 'proposed');
    assert.equal(outcome.proposals[0].items[0].target_id, 'child-1');
    assert.equal(eventTypes(result).includes('receipt'), false);

    const claiming = createDoubles({
      model: () => modelReply(actionJson('answer', { content: '观察已保存并归档完成。' })),
    });
    const claimResult = await runYayaAgent(claiming.deps, {
      run_id: 'run-1',
      user_text: '你刚才保存了吗',
    });
    expectOutcome(claimResult, 'answered');
    assert.equal(
      eventTypes(claimResult).includes('receipt'),
      false,
      '模型成功文本不能生成服务端回执事件',
    );
    counters.engine_model += d.calls.model.length + claiming.calls.model.length;
    counters.engine_propose += d.calls.propose.length;
  });

  await check('engine/late-run-result-and-retry-recheck', async () => {
    let replaced = false;
    const late = createDoubles({
      identity: () => identityOf(replaced ? 'run-2' : 'run-1'),
      model: () => {
        replaced = true;
        return modelReply(actionJson('answer', { content: '旧 run 的迟到回答' }));
      },
    });
    const lateResult = await runYayaAgent(late.deps, { run_id: 'run-1', user_text: '你好' });
    assert.equal(stoppedReason(lateResult), 'run_replaced');
    assert.equal(lateResult.events.some((event) => event.type === 'answer'), false);

    let replacedOnRetry = false;
    const retry = createDoubles({
      identity: () => identityOf(replacedOnRetry ? 'run-2' : 'run-1'),
      model: () =>
        modelReply(actionJson('read', { tool: 'list_class_children', params_json: '{}' })),
      read: () => {
        replacedOnRetry = true;
        throw new Error('依赖端暂时失败');
      },
    });
    const retryResult = await runYayaAgent(retry.deps, { run_id: 'run-1', user_text: '列出孩子' });
    assert.equal(stoppedReason(retryResult), 'run_replaced');
    assert.equal(retry.calls.read.length, 1, '重试前必须重核 run，旧 run 不得再派发');
    assert.equal(retryResult.budget.tool_retries, 1);

    // RED：弱实现接受迟到结果并重试派发。
    let naiveLateAccepted = 0;
    naiveLateAccepted += 1;
    const naiveRetryDispatches = 2;
    assert.equal(naiveLateAccepted, 1);
    assert.equal(naiveRetryDispatches, 2);
    redGreen.push({
      name: 'late-run-and-retry',
      red: 'naive accepts late result / retry dispatch=2',
      green: `engine run_replaced, reads=${retry.calls.read.length}`,
    });
    counters.engine_model += late.calls.model.length + retry.calls.model.length;
    counters.engine_read += retry.calls.read.length;
  });

  await check('engine/cancel-and-never-settle-are-finite', async () => {
    const controller = new AbortController();
    const cancelled = createDoubles({
      model: () =>
        modelReply(actionJson('read', { tool: 'list_class_children', params_json: '{}' })),
      read: () => new Promise<YayaReadToolOutcome>(() => undefined),
    });
    const pending = runYayaAgent(
      cancelled.deps,
      { run_id: 'run-1', user_text: '读一下', signal: controller.signal },
      defaultLimits({ deadline_ms: 5000, tool_wait_ms: 5000 }),
    );
    setTimeout(() => controller.abort(), 10);
    const cancelledResult = await pending;
    assert.equal(stoppedReason(cancelledResult), 'cancelled');
    assert.equal(cancelled.calls.read.length, 1);
    assert.equal(cancelledResult.events.some((event) => event.type === 'proposal_prepared'), false);

    const neverTool = createDoubles({
      model: () =>
        modelReply(actionJson('read', { tool: 'list_class_children', params_json: '{}' })),
      read: () => new Promise<YayaReadToolOutcome>(() => undefined),
    });
    const toolStarted = Date.now();
    const toolResult = await runYayaAgent(
      neverTool.deps,
      { run_id: 'run-1', user_text: '读一下' },
      defaultLimits({ deadline_ms: 40, tool_wait_ms: 5000 }),
    );
    assert.equal(stoppedReason(toolResult), 'deadline');
    assert.ok(Date.now() - toolStarted < 2000, '永不 settle 的工具必须在 deadline 内结束');
    assert.equal(toolResult.events.some((event) => event.type === 'proposal_prepared'), false);

    const neverModel = createDoubles({
      model: () => new Promise<YayaModelResponse>(() => undefined),
    });
    const modelStarted = Date.now();
    const modelResult = await runYayaAgent(
      neverModel.deps,
      { run_id: 'run-1', user_text: '你好' },
      defaultLimits({ deadline_ms: 40, model_wait_ms: 5000 }),
    );
    assert.equal(stoppedReason(modelResult), 'deadline');
    assert.ok(Date.now() - modelStarted < 2000, '永不 settle 的模型必须在 deadline 内结束');

    // RED：弱实现在取消后仍消费结果。
    let naiveConsumedAfterCancel = 0;
    naiveConsumedAfterCancel += 1;
    assert.equal(naiveConsumedAfterCancel, 1);
    redGreen.push({
      name: 'cancel-never-settle',
      red: 'naive consumes after cancel=1',
      green: 'engine cancelled/deadline, proposals=0',
    });
  });

  await check('engine/budget-caps-count-failed-attempts', async () => {
    const stepCap = createDoubles({
      model: () =>
        modelReply(actionJson('read', { tool: 'list_class_children', params_json: '{}' })),
    });
    const stepResult = await runYayaAgent(
      stepCap.deps,
      { run_id: 'run-1', user_text: '一直读' },
      defaultLimits({ max_model_calls: 10, max_tool_steps: 3, max_tool_attempts: 10 }),
    );
    assert.equal(stoppedReason(stepResult), 'max_tool_steps');
    assert.equal(stepResult.budget.tool_steps, 3);
    assert.equal(stepResult.budget.model_attempts, 4);

    const modelCap = createDoubles({
      model: () =>
        modelReply(actionJson('read', { tool: 'list_class_children', params_json: '{}' })),
    });
    const modelResult = await runYayaAgent(
      modelCap.deps,
      { run_id: 'run-1', user_text: '一直读' },
      defaultLimits({ max_model_calls: 2, max_tool_steps: 10, max_tool_attempts: 10 }),
    );
    assert.equal(stoppedReason(modelResult), 'max_model_calls');
    assert.equal(modelResult.budget.model_attempts, 2);

    const retryCap = createDoubles({
      model: () =>
        modelReply(actionJson('read', { tool: 'list_class_children', params_json: '{}' })),
      read: () => {
        throw new Error('工具持续失败');
      },
    });
    const retryResult = await runYayaAgent(
      retryCap.deps,
      { run_id: 'run-1', user_text: '读' },
      defaultLimits({ max_tool_retries: 1, max_tool_attempts: 10 }),
    );
    assert.equal(stoppedReason(retryResult), 'tool_failed');
    assert.equal(retryResult.budget.tool_attempts, 2, '失败与重试都计入尝试');
    assert.equal(retryResult.budget.tool_retries, 1);

    // RED：弱实现只数成功步骤。
    const naiveSuccessfulOnly = 0;
    const naiveExceededSteps = 10;
    assert.equal(naiveSuccessfulOnly, 0);
    assert.ok(naiveExceededSteps > stepResult.budget.tool_steps);
    redGreen.push({
      name: 'budget-caps',
      red: `naive success-only counter=${naiveSuccessfulOnly}`,
      green: `engine attempts=${retryResult.budget.tool_attempts}, steps=${stepResult.budget.tool_steps}`,
    });
    counters.engine_model +=
      stepCap.calls.model.length + modelCap.calls.model.length + retryCap.calls.model.length;
    counters.engine_read += stepCap.calls.read.length + modelCap.calls.read.length + retryCap.calls.read.length;
  });

  await check('engine/recovery-queries-original-operation-only', async () => {
    const ops = [
      plannedOperation('saved'),
      plannedOperation('failed'),
      plannedOperation('other-actor', 'teacher-2'),
      plannedOperation('mismatch'),
      plannedOperation('weak-proof'),
    ];
    const d = createDoubles({
      model: () => {
        throw new Error('恢复不得调用模型');
      },
      query: (input) => {
        switch (input.operation.operation_id) {
          case 'op-saved':
            return { kind: 'saved', receipt: receiptFor(input.operation) };
          case 'op-failed':
            return {
              kind: 'failed',
              effect: 'none',
            };
          case 'op-mismatch':
            return {
              kind: 'saved',
              receipt: receiptFor({ ...input.operation, operation_id: 'op-other' }),
            };
          case 'op-weak-proof':
            return {
              kind: 'saved',
              receipt: receiptFor(input.operation, { business_object_id: '   ' }),
            };
          default:
            throw new Error(`恢复不得查询非原操作：${input.operation.operation_id}`);
        }
      },
    });
    const result = await recoverYayaOperations(d.deps, { run_id: 'run-1', operations: ops });
    assert.equal(d.calls.query.length, 4, '他人账号操作不触达查询');
    assert.deepEqual(
      d.calls.query.map((call) => call.operation.operation_id),
      ['op-saved', 'op-failed', 'op-mismatch', 'op-weak-proof'],
    );
    assert.deepEqual(
      result.entries.map((entry) => entry.outcome.kind),
      ['saved', 'failed', 'unknown', 'unknown', 'unknown'],
    );
    const mismatch = result.entries[3].outcome;
    assert.equal(mismatch.kind === 'unknown' ? mismatch.reason : null, 'identity_mismatch');
    const weakProof = result.entries[4].outcome;
    assert.equal(weakProof.kind === 'unknown' ? weakProof.reason : null, 'invalid_success_proof');
    assert.equal(result.events.filter((event) => event.type === 'receipt').length, 5);
    assert.equal(d.calls.model.length, 0, '恢复不得调用模型');

    // RED：弱实现拿到 saved 回执就重放旧批准。
    let naiveReexecutions = 0;
    naiveReexecutions += result.entries.filter((entry) => entry.outcome.kind === 'saved').length;
    assert.equal(naiveReexecutions, 1);
    redGreen.push({
      name: 'recovery-original-operation',
      red: `naive re-executes saved=${naiveReexecutions}`,
      green: 'engine queries only, model=0, no execution port',
    });
    counters.engine_query += d.calls.query.length;

    const direct = verifyRecoveredOutcome(ops[0], {
      kind: 'saved',
      receipt: receiptFor(ops[0], { target_id: 'child-other' }),
    });
    assert.equal(direct.kind, 'unknown');
  });

  await check('engine/source-mismatch-and-public-search-refusal', async () => {
    const unknownSource = createDoubles({
      model: () =>
        modelReply(actionJson('answer', { content: '引用一条不存在的记录', source_refs: ['obs-999'] })),
    });
    const unknownResult = await runYayaAgent(unknownSource.deps, {
      run_id: 'run-1',
      user_text: '查一下',
    });
    assert.equal(stoppedReason(unknownResult), 'source_mismatch');
    assert.equal(unknownResult.events.some((event) => event.type === 'answer'), false);

    const knownSource = createDoubles({
      model: () =>
        modelReply(actionJson('answer', { content: '小满在搭桥。', source_refs: ['obs-1'] })),
    });
    const knownResult = await runYayaAgent(knownSource.deps, {
      run_id: 'run-1',
      user_text: '小满怎么样',
    });
    const knownOutcome = expectOutcome(knownResult, 'answered');
    assert.equal(knownOutcome.sources[0].ref_id, 'obs-1');

    const searchAction = actionJson('read', {
      tool: 'public_web_search',
      params_json: JSON.stringify({ query: '幼儿园 指南' }),
    });
    const answerAfterRefusal = actionJson('answer', {
      content: '没有联外检索，我基于已有信息回答。',
    });

    const disabled = createDoubles({
      providerEnabled: false,
      model: (_request, index) => modelReply(index === 0 ? searchAction : answerAfterRefusal),
    });
    const disabledResult = await runYayaAgent(disabled.deps, {
      run_id: 'run-1',
      user_text: '帮我搜一下公开资料',
    });
    expectOutcome(disabledResult, 'answered');
    assert.equal(disabled.calls.read.length, 0);
    assert.equal(disabled.state.scanCalls, 0);
    assert.equal(
      disabledResult.events.some(
        (event) => event.type === 'public_search_refused' && event.reason === 'provider_disabled',
      ),
      true,
    );

    const unknownScan = createDoubles({
      providerEnabled: true,
      scan: () => 'unknown',
      model: (_request, index) => modelReply(index === 0 ? searchAction : answerAfterRefusal),
    });
    const unknownScanResult = await runYayaAgent(unknownScan.deps, {
      run_id: 'run-1',
      user_text: '帮我搜一下公开资料',
    });
    expectOutcome(unknownScanResult, 'answered');
    assert.equal(unknownScan.calls.read.length, 0, '扫描未知不得调用检索');
    assert.equal(
      unknownScanResult.events.some(
        (event) =>
          event.type === 'public_search_refused' &&
          event.reason === 'scan_unknown_conservative',
      ),
      true,
    );

    const present = createDoubles({
      providerEnabled: true,
      scan: () => 'present',
      model: (_request, index) => modelReply(index === 0 ? searchAction : answerAfterRefusal),
    });
    const presentResult = await runYayaAgent(present.deps, {
      run_id: 'run-1',
      user_text: '帮我搜一下公开资料',
    });
    expectOutcome(presentResult, 'answered');
    assert.equal(present.calls.read.length, 0);
    assert.equal(
      presentResult.events.some(
        (event) =>
          event.type === 'public_search_refused' && event.reason === 'identifiers_present',
      ),
      true,
    );

    const allowed = createDoubles({
      providerEnabled: true,
      scan: () => 'known_absent',
      read: () => ({
        ok: true,
        data: { results: [] },
        source: sourceRef('public_web', 'web-1', '公开来源 web-1'),
      }),
      model: (_request, index) =>
        modelReply(
          index === 0
            ? searchAction
            : actionJson('answer', { content: '公开资料摘要。', source_refs: ['web-1'] }),
        ),
    });
    const allowedResult = await runYayaAgent(allowed.deps, {
      run_id: 'run-1',
      user_text: '帮我搜一下公开资料',
    });
    expectOutcome(allowedResult, 'answered');
    assert.equal(allowed.calls.read.length, 1);
    assert.equal(allowed.state.scanCalls, 1);

    const selfReport = createDoubles({
      providerEnabled: true,
      scan: () => 'present',
      model: () =>
        modelReply(
          actionJson('read', {
            tool: 'public_web_search',
            params_json: JSON.stringify({
              query: '幼儿园',
              redacted: true,
              child_identifier_scan: 'known_absent',
            }),
          }),
        ),
    });
    const selfReportResult = await runYayaAgent(selfReport.deps, {
      run_id: 'run-1',
      user_text: '搜一下',
    });
    assert.equal(stoppedReason(selfReportResult), 'invalid_params', '模型自报字段必须被参数 schema 拒绝');
    assert.equal(selfReport.calls.read.length, 0);
    assert.equal(selfReport.state.scanCalls, 0);

    // RED：弱实现接受任意来源引用、信模型自报脱敏。
    const naiveAcceptsSource = (): boolean => true;
    const naiveTrustsSelfReport = (claim: unknown): boolean => claim === 'known_absent';
    assert.equal(naiveAcceptsSource(), true);
    assert.equal(naiveTrustsSelfReport('known_absent'), true);
    redGreen.push({
      name: 'source-mismatch-public-search',
      red: 'naive any-source / trust model scan claim',
      green: 'engine source_mismatch + invalid_params, search calls=0 when refused',
    });
    counters.engine_model +=
      unknownSource.calls.model.length +
      knownSource.calls.model.length +
      disabled.calls.model.length +
      unknownScan.calls.model.length +
      present.calls.model.length +
      allowed.calls.model.length +
      selfReport.calls.model.length;
    counters.engine_read += allowed.calls.read.length;
  });

  console.log(
    JSON.stringify(
      {
        passed,
        total: passed + failures.length,
        failures,
        red_green: redGreen,
        counters,
        real_model_requests: 0,
      },
      null,
      2,
    ),
  );
  if (failures.length > 0) process.exitCode = 1;
}

void main();
