/**
 * TOOLS1 写工具离线检查（真实模块 + 纯函数/替身，无数据库、无网络、无模型请求）。
 *
 * 覆盖：
 * - 12 个写工具登记表、动作/资源组合、模型可见 JSON Schema 与校验同源；
 * - strict 参数：未知字段/自报批准/密码字段/越界图片集合一律拒绝；
 * - manage_teacher 不含教师创建/密码重置（安全控件入口）；
 * - 安全控件意图投影不携带秘密；
 * - 最小工具工厂 tools/readTool/proposeWrite 接线与 fail-closed 语义。
 *
 * 运行：pnpm exec tsx scripts/yaya/check-tools-write.ts
 */
import assert from 'node:assert/strict';

import { projectYayaSecureControlIntent } from '../../src/lib/yaya/api-contract';
import { isLegalToolCombination } from '../../src/lib/yaya/types';
import {
  createYayaToolkit,
  createYayaWriteRegistry,
  projectTeacherSecureControlIntent,
} from '../../src/lib/yaya/tools/write';

let passed = 0;
function check(condition: unknown, label: string): void {
  assert.ok(condition, label);
  passed += 1;
}

const EXPECTED_TOOLS = [
  'create_observation',
  'organize_observation',
  'follow_up_observation',
  'confirm_observation',
  'guide_decision',
  'create_child',
  'transfer_child',
  'manage_class',
  'manage_teacher',
  'refresh_growth_profile',
  'refresh_activity_support',
  'attach_observation_images',
];

function minimalParams(tool: string): Record<string, unknown> {
  const uuid = '00000000-0000-4000-8000-000000000000';
  switch (tool) {
    case 'create_observation':
      return { child_id: uuid, observed_at: '2026-09-01', raw_text: '这是足够长的观察原文内容。' };
    case 'organize_observation':
      return { observation_id: 'obs-1' };
    case 'follow_up_observation':
      return { observation_id: 'obs-1', action: 'skip' };
    case 'confirm_observation':
      return {
        observation_id: 'obs-1',
        input: {
          content: {
            domain: '健康',
            sub_domain: '动作发展',
            objective_description: '目标描述',
            highlights: ['亮点'],
            support_suggestions: ['建议'],
            highlight_quote: '金句',
          },
        },
      };
    case 'guide_decision':
      return { observation_id: 'obs-1', mutation: { action: 'suggest' } };
    case 'create_child':
      return { name: '测试幼儿', gender: '女', birth_date: '2022-01-01', target_class_id: uuid };
    case 'transfer_child':
      return { child_id: uuid, target_class_id: uuid };
    case 'manage_class':
      return { operation: 'create', name: '测试班', stage: 'small', school_year: '2026-2027' };
    case 'manage_teacher':
      return { operation: 'set_status', teacher_account_id: uuid, status: 'active' };
    case 'refresh_growth_profile':
      return { child_id: uuid };
    case 'refresh_activity_support':
      return { child_id: uuid };
    case 'attach_observation_images':
      return {
        observation_id: 'obs-1',
        image_ids: ['img-1'],
        expected_attachment_revision: 0,
        source_confirmed_at: null,
      };
    default:
      throw new Error(`unknown tool ${tool}`);
  }
}

async function runOffline(): Promise<number> {
  const registry = createYayaWriteRegistry();

  /* 1. 登记表与协议来源 */
  check(registry.definitions.length === 12, 'write registry registers 12 tools');
  const names = registry.definitions.map((definition) => definition.tool).sort();
  check(
    JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()),
    'write tool names are the frozen platform actions',
  );
  for (const definition of registry.definitions) {
    check(definition.description.length > 0, `${definition.tool}: has model-facing description`);
    check(
      isLegalToolCombination(definition.auth),
      `${definition.tool}: auth action/resource combination is legal`,
    );
    const schema = definition.params.describe().json_schema as Record<string, unknown>;
    check(Object.keys(schema).length > 0, `${definition.tool}: exports a non-empty JSON schema`);
  }

  /* 2. strict 参数 + 同源校验 */
  for (const definition of registry.definitions) {
    const valid = minimalParams(definition.tool);
    check(
      definition.params.validate(valid).ok,
      `${definition.tool}: accepts its minimal valid params`,
    );
    check(
      !definition.params.validate({ ...valid, approved: true }).ok,
      `${definition.tool}: rejects self-reported approved`,
    );
    check(
      !definition.params.validate({ ...valid, principal: { role: 'admin' } }).ok,
      `${definition.tool}: rejects self-reported principal`,
    );
    check(
      !definition.params.validate({ ...valid, password: 'x' }).ok,
      `${definition.tool}: rejects password fields`,
    );
  }

  /* 3. 具体参数边界 */
  const createObservation = registry.find('create_observation')!;
  check(
    !createObservation.definition.params.validate({
      child_id: '00000000-0000-4000-8000-000000000000',
      observed_at: '2026-02-30',
      raw_text: '这条原文长度足够但日期不存在。',
    }).ok,
    'create_observation: rejects an impossible calendar date',
  );
  check(
    !createObservation.definition.params.validate({
      child_id: '00000000-0000-4000-8000-000000000000',
      observed_at: '2026-09-01',
      raw_text: '这条原文长度足够。',
      image_ids: Array.from({ length: 9 }, (_, index) => `img-${index}`),
    }).ok,
    'create_observation: rejects more than 8 images',
  );
  check(
    !createObservation.definition.params.validate({
      child_id: '00000000-0000-4000-8000-000000000000',
      observed_at: '2026-09-01',
      raw_text: '这条原文长度足够。',
      image_ids: ['img-1', 'img-1'],
    }).ok,
    'create_observation: rejects duplicate image ids',
  );
  check(
    !createObservation.definition.params.validate({
      child_id: '00000000-0000-4000-8000-000000000000',
      observed_at: '2026-09-01',
      raw_text: '太短',
    }).ok,
    'create_observation: rejects raw_text shorter than 10 chars',
  );

  const confirm = registry.find('confirm_observation')!;
  const confirmValid = minimalParams('confirm_observation');
  check(
    !confirm.definition.params.validate({
      ...confirmValid,
      input: {
        ...(confirmValid.input as Record<string, unknown>),
        approved: true,
      },
    }).ok,
    'confirm_observation: rejects forged approval nested in input',
  );

  const manageTeacher = registry.find('manage_teacher')!;
  check(
    !manageTeacher.definition.params.validate({
      operation: 'create',
      username: 'teacher-x',
      display_name: 'X 老师',
      class_ids: [],
    }).ok,
    'manage_teacher: teacher creation is not an executable tool',
  );
  check(
    !manageTeacher.definition.params.validate({
      operation: 'reset_password',
      teacher_account_id: '00000000-0000-4000-8000-000000000000',
    }).ok,
    'manage_teacher: password reset is not an executable tool',
  );
  check(
    manageTeacher.definition.params.validate({
      operation: 'set_status',
      teacher_account_id: '00000000-0000-4000-8000-000000000000',
      status: 'disabled',
    }).ok,
    'manage_teacher: set_status stays executable without secrets',
  );

  /* 4. 安全控件意图（公开元数据，秘密不进协议） */
  const resetIntent = projectTeacherSecureControlIntent({
    operation: 'reset_password',
    teacher_account_id: 'teacher-2',
  });
  check(resetIntent.secure_control === 'teacher_password_reset', 'secure control: reset intent kind');
  check(resetIntent.target_account_id === 'teacher-2', 'secure control: reset target account');
  check(resetIntent.secrets_in_protocol === false, 'secure control: no secrets in protocol');
  const createIntent = projectTeacherSecureControlIntent({ operation: 'create' });
  check(createIntent.secure_control === 'teacher_account_create', 'secure control: create intent kind');
  check(createIntent.target_account_id === null, 'secure control: create target is null');
  const secretAttempt = projectYayaSecureControlIntent({
    kind: 'teacher_password_reset',
    target_account_id: 'teacher-2',
    password: 'must-not-pass',
  });
  check(secretAttempt.ok === false, 'secure control: projector rejects any secret field');

  /* 5. 工具工厂接线与 fail-closed */
  const toolkit = createYayaToolkit();
  check(toolkit.toolkit.tools.read_tools.length === 13, 'toolkit exposes the 13 READ1 read tools');
  check(toolkit.toolkit.tools.write_tools.length === 12, 'toolkit exposes the 12 write tools');
  check(typeof toolkit.toolkit.readTool === 'function', 'toolkit readTool is callable');
  check(typeof toolkit.toolkit.proposeWrite === 'function', 'toolkit proposeWrite is callable');
  check(typeof toolkit.executeOperations === 'function', 'toolkit exposes operations execution');

  {
    const baseIdentity = {
      run_id: 'run-offline',
      identity_state: 'authenticated' as const,
      session_valid: true,
      principal: {
        account_id: 'acct-1',
        username: 'teacher-a',
        display_name: '教师A',
        role: 'teacher' as const,
        account_status: 'active' as const,
        scope: { kind: 'classes' as const, class_ids: ['class-a'] },
      },
    };
    const noConversation = await toolkit.toolkit.proposeWrite({
      run_id: 'run-offline',
      tool: 'organize_observation',
      params: { observation_id: 'obs-1' },
      identity: baseIdentity,
      proposal_origin: 'model_suggestion',
    });
    check(
      !noConversation.ok && noConversation.code === 'failed',
      'proposeWrite fails closed without a run→conversation binding',
    );

    const noConversationTool = createYayaToolkit({ resolveConversationId: async () => 'conversation-1' });
    const unknownTool = await noConversationTool.toolkit.proposeWrite({
      run_id: 'run-offline',
      tool: 'delete_everything',
      params: {},
      identity: baseIdentity,
      proposal_origin: 'model_suggestion',
    });
    check(!unknownTool.ok && unknownTool.code === 'unsupported', 'proposeWrite rejects unknown tools');
    const badParams = await noConversationTool.toolkit.proposeWrite({
      run_id: 'run-offline',
      tool: 'organize_observation',
      params: { observation_id: 'obs-1', approved: true },
      identity: baseIdentity,
      proposal_origin: 'model_suggestion',
    });
    check(!badParams.ok && badParams.code === 'invalid_params', 'proposeWrite rejects forged params');

    const unauthenticated = await noConversationTool.toolkit.proposeWrite({
      run_id: 'run-offline',
      tool: 'organize_observation',
      params: { observation_id: 'obs-1' },
      identity: { ...baseIdentity, identity_state: 'unauthenticated', principal: null },
      proposal_origin: 'model_suggestion',
    });
    check(
      !unauthenticated.ok && unauthenticated.code === 'unauthenticated',
      'proposeWrite rejects anonymous callers',
    );

    const unavailable = await noConversationTool.toolkit.proposeWrite({
      run_id: 'run-offline',
      tool: 'organize_observation',
      params: { observation_id: 'obs-1' },
      identity: { ...baseIdentity, identity_state: 'unavailable', principal: null },
      proposal_origin: 'model_suggestion',
    });
    check(
      !unavailable.ok && unavailable.code === 'identity_unavailable',
      'proposeWrite surfaces identity service unavailable',
    );

    const disabled = await noConversationTool.toolkit.proposeWrite({
      run_id: 'run-offline',
      tool: 'organize_observation',
      params: { observation_id: 'obs-1' },
      identity: {
        ...baseIdentity,
        principal: { ...baseIdentity.principal, account_status: 'disabled', scope: { kind: 'none', reason: 'account_disabled' } },
      },
      proposal_origin: 'model_suggestion',
    });
    check(!disabled.ok && disabled.code === 'denied', 'proposeWrite rejects disabled accounts');

    const wrongOrigin = await noConversationTool.toolkit.proposeWrite({
      run_id: 'run-offline',
      tool: 'organize_observation',
      params: { observation_id: 'obs-1' },
      identity: baseIdentity,
      proposal_origin: 'teacher_card' as never,
    });
    check(!wrongOrigin.ok && wrongOrigin.code === 'unsupported', 'proposeWrite only accepts model origin');
  }

  return passed;
}

runOffline()
  .then((count: number) => {
    console.log(
      JSON.stringify({
        ok: true,
        passed: count,
        total: count,
        real_model_requests: 0,
        postgres_requests: 0,
        network_requests: 0,
      }),
    );
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
