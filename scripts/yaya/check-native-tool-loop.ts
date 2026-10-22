import assert from 'node:assert/strict';
import { z } from 'zod';

import { runYayaAgent } from '../../src/lib/yaya/agent/engine';
import { zodToolParams, type YayaAgentDependencies, type YayaModelResponse, type YayaToolCatalog } from '../../src/lib/yaya/agent/types';
import type { Principal } from '../../src/lib/accounts/types';

const principal: Principal = {
  account_id: 'teacher-1',
  username: 'teacher',
  display_name: '测试教师',
  role: 'teacher',
  account_status: 'active',
  scope: { kind: 'classes', class_ids: ['class-1'] },
};

const identity = {
  run_id: 'native-loop-run',
  identity_state: 'authenticated' as const,
  principal,
  session_valid: true,
};

const source = (ref_id: string, label: string) => ({
  kind: 'tool_result' as const,
  ref_id,
  label,
  derived_from: null,
});

const tools: YayaToolCatalog = {
  read_tools: [
    {
      tool: 'list_children',
      description: '读取当前授权范围内的幼儿',
      scope_policy: 'business_scope',
      params: zodToolParams(z.strictObject({})),
    },
    {
      tool: 'list_observations',
      description: '读取指定幼儿的观察记录',
      scope_policy: 'business_scope',
      params: zodToolParams(z.strictObject({ child_id: z.string().min(1) })),
    },
  ],
  write_tools: [
    {
      tool: 'organize_observation',
      description: '准备一条观察整理提案',
      auth: { kind: 'action', action: 'observation.organize', resource: 'observation' },
      params: zodToolParams(z.strictObject({ observation_id: z.string().min(1) })),
    },
  ],
};

function toolCall(id: string, name: string, args: unknown) {
  return { id, type: 'function' as const, name, arguments: JSON.stringify(args) };
}

async function main(): Promise<void> {
  let modelCalls = 0;
  const readCalls: string[] = [];
  const seenMessages: Array<readonly { role: string; text: string; tool_call_id?: string }[]> = [];

  const modelResponses: YayaModelResponse[] = [
    { content: '', provider: 'coze', model: 'fixture-doubao', usage: null, tool_calls: [toolCall('call-children', 'list_children', {})] },
    { content: '', provider: 'coze', model: 'fixture-doubao', usage: null, tool_calls: [toolCall('call-observations', 'list_observations', { child_id: 'child-1' })] },
    { content: '', provider: 'coze', model: 'fixture-doubao', usage: null, tool_calls: [toolCall('call-organize', 'organize_observation', { observation_id: 'observation-1' })] },
  ];

  const deps: YayaAgentDependencies = {
    tools,
    model: {
      generate: async (request) => {
        seenMessages.push(request.messages.map((message) => ({
          role: message.role,
          text: message.text,
          ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        })));
        const response = modelResponses[modelCalls];
        assert.ok(response, `unexpected model call ${modelCalls + 1}`);
        if (modelCalls > 0) {
          const previous = request.messages.at(-2);
          const result = request.messages.at(-1);
          assert.equal(previous?.role, 'assistant');
          assert.equal(result?.role, 'tool');
          assert.ok(result?.tool_call_id);
        }
        modelCalls += 1;
        return response;
      },
    },
    resolveCurrentIdentity: async () => identity,
    loadProjectedContext: async () => ({ history: [], sources: [], images: [], guide_catalog: null }),
    revalidateProjectedContext: async () => ({ ok: true as const }),
    readTool: async ({ tool, params }) => {
      readCalls.push(tool);
      if (tool === 'list_children') {
        return { ok: true as const, data: { children: [{ child_id: 'child-1', name: '顾星辰' }] }, source: source('children:current_scope', '幼儿名册') };
      }
      assert.deepEqual(params, { child_id: 'child-1' });
      return { ok: true as const, data: { observations: [{ observation_id: 'observation-1', raw_text: '顾星辰完成了观察。' }] }, source: source('child:child-1:observations', '观察记录') };
    },
    proposeWrite: async ({ tool, params }) => {
      assert.equal(tool, 'organize_observation');
      assert.deepEqual(params, { observation_id: 'observation-1' });
      return {
        ok: true as const,
        proposals: [{
          proposal_id: 'proposal-1',
          batch_id: 'batch-1',
          proposal_origin: 'model_suggestion' as const,
          auth: { kind: 'action' as const, action: 'observation.organize' as const, resource: 'observation' as const },
          prepared_at: '2026-10-22T00:00:00.000Z',
          items: [{
            item_key: 'item-1',
            target_id: 'observation-1',
            content_digest: 'digest-1',
            attachment_associations: [],
            payload: { kind: 'organize_observation' as const, observation_id: 'observation-1' },
          }],
        }],
      };
    },
    queryOperation: async () => ({ kind: 'unknown' as const, reason: 'verification_required' as const }),
    publicSearchPolicy: { provider_enabled: false, scanChildIdentifiers: async () => 'unknown' as const },
  };

  const result = await runYayaAgent(deps, {
    run_id: identity.run_id,
    user_text: '请读取顾星辰并整理最近观察',
    attachment_ids: [],
  });

  assert.equal(result.outcome.kind, 'proposed');
  assert.deepEqual(readCalls, ['list_children', 'list_observations']);
  assert.equal(modelCalls, 3);
  assert.equal(seenMessages[1].at(-1)?.role, 'tool');
  assert.equal(seenMessages[2].at(-1)?.tool_call_id, 'call-observations');

  let recoveryCalls = 0;
  const recoveryDeps: YayaAgentDependencies = {
    ...deps,
    resolveCurrentIdentity: async () => ({ ...identity, run_id: 'native-loop-recovery' }),
    model: {
      generate: async (request) => {
        recoveryCalls += 1;
        if (recoveryCalls === 1) {
          return { content: '', provider: 'coze', model: 'fixture-doubao', usage: null, tool_calls: [toolCall('bad-read', 'list_observations', { include_content: true })] };
        }
        if (recoveryCalls === 2) {
          const toolResult = request.messages.at(-1);
          assert.equal(toolResult?.role, 'tool');
          assert.ok(toolResult?.text.includes('invalid_params'));
          return { content: '', provider: 'coze', model: 'fixture-doubao', usage: null, tool_calls: [toolCall('corrected-read', 'list_children', {})] };
        }
        return {
          content: JSON.stringify({ action: 'answer', content: '已读取当前授权范围内的幼儿名册。', tool: '', params_json: '', source_refs: ['children:current_scope'] }),
          provider: 'coze',
          model: 'fixture-doubao',
          usage: null,
        };
      },
    },
  };
  const recovered = await runYayaAgent(recoveryDeps, {
    run_id: 'native-loop-recovery',
    user_text: '读取幼儿名册',
    attachment_ids: [],
  });
  assert.equal(recovered.outcome.kind, 'answered');
  assert.equal(recoveryCalls, 3);
  console.log(JSON.stringify({ passed: 12, total: 12, native_tool_rounds: modelCalls, recovery_rounds: recoveryCalls, read_calls: readCalls }));
}

void main();
