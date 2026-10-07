import type { TransactionClient } from '@/storage/database/pg-client';
import type { Principal } from '@/lib/accounts/types';
import { readAccessResourceFacts } from '@/lib/yaya/data/access-facts';
import { projectMessageRow } from '@/lib/yaya/data/projection';
import { parseStoredFragments, type YayaMessageRow } from '@/lib/yaya/data/rows';
import { yayaDataRepository } from '@/lib/yaya/data';
import { buildYayaRunSourceBinding, resolveYayaAssistantFragmentPolicy } from '@/lib/yaya/chat-bind-contract';
import { yayaRunOutcomeSchema } from '@/lib/yaya/api-contract';
import type { YayaMessageSourceRef, YayaSourceRef } from '@/lib/yaya/types';
import type { YayaRunRecord } from './store';

/** 使用完整持久化依赖，不以最终模型引用代替授权依据；无法映射保持 unknown。 */
async function messagePolicy(client: TransactionClient, principal: Principal, schoolId: string, run: YayaRunRecord) {
  const refs = new Map<string, YayaMessageSourceRef>();
  let unmapped = run.dependencies_corrupt ? 1 : 0;
  const add = (source: YayaMessageSourceRef) => refs.set(JSON.stringify(source), source);
  for (const dependency of run.dependencies) {
    if (dependency.image_id !== null) { unmapped++; continue; }
    if (dependency.message_id !== null) {
      const rows = await client.query<YayaMessageRow>('SELECT * FROM yaya_messages WHERE id=$1 AND conversation_id=$2 AND owner_account_id=$3 AND deleted_at IS NULL', [dependency.message_id, run.conversation_id, principal.account_id]);
      const row = rows.rows[0];
      if (!row) { unmapped++; continue; }
      const projected = await projectMessageRow(client, principal, schoolId, row);
      const stored = parseStoredFragments(row.fragments).fragments.find(fragment => fragment.fragment_id === dependency.fragment_id);
      const visible = projected.fragments.find(fragment => fragment.fragment_id === dependency.fragment_id);
      if (!stored || visible?.visibility !== 'full' || (stored.sources.length === 0 && !stored.independently_readable)) { unmapped++; continue; }
      for (const source of stored.sources) add(source);
      continue;
    }
    const ref = dependency.ref?.ref_id;
    if (!ref) { unmapped++; continue; }
    if (ref.startsWith('guide_')) continue;
    if (['children:current_scope', 'observations:current_scope', 'classes:assigned'].includes(ref)) {
      const classes = principal.role === 'admin' ? (await client.query<{ id: string }>('SELECT id FROM classes')).rows.map(row => row.id) : principal.scope.kind === 'classes' ? principal.scope.class_ids : [];
      if (classes.length === 0) unmapped++;
      for (const class_id of classes) add({ kind: 'class', class_id });
      continue;
    }
    const split = ref.indexOf(':'); const kind = ref.slice(0, split), id = ref.slice(split + 1);
    if (split < 1 || !id || !['child', 'class', 'observation'].includes(kind)) { unmapped++; continue; }
    const resource = kind === 'child' ? { kind: 'child' as const, child_id: id } : kind === 'class' ? { kind: 'class' as const, class_id: id } : { kind: 'observation' as const, observation_id: id };
    const facts = await readAccessResourceFacts(client, resource, schoolId);
    if (!facts) { unmapped++; continue; }
    if (facts.kind === 'class') add({ kind: 'class', class_id: facts.class_id });
    else if (facts.kind === 'child') add({ kind: 'child', child_id: facts.child_id, current_class_id: facts.current_class_id });
    else if (facts.kind === 'observation') add({ kind: 'observation', observation_id: facts.observation_id, child_id: facts.child_id, current_class_id: facts.current_class_id, observed_class_id: facts.observed_class_id });
  }
  return resolveYayaAssistantFragmentPolicy(buildYayaRunSourceBinding({ resource_dependencies: [...refs.values()], unmapped_dependency_count: unmapped, private_dependency_proven_absent: unmapped === 0 && refs.size === 0 }));
}

export async function persistRunTerminalMessage(client: TransactionClient, principal: Principal, schoolId: string, run: YayaRunRecord): Promise<void> {
  const parsed = yayaRunOutcomeSchema.safeParse(run.outcome);
  if (!parsed.success) throw Error('终态形状不可核验。');
  const outcome = parsed.data;
  const policy = await messagePolicy(client, principal, schoolId, run);
  const provenance: YayaSourceRef = { kind: outcome.kind === 'answered' || outcome.kind === 'clarified' ? 'model_text' : 'tool_result', ref_id: run.run_id, label: '芽芽', derived_from: null };
  const proposals = outcome.kind === 'proposed' ? outcome.proposals : [null];
  for (let index = 0; index < proposals.length; index++) {
    const proposal = proposals[index];
    const operations = proposal === null ? [] : (await client.query<{ operation_id: string; item_key: string; target_id: string; content_digest: string }>('SELECT operation_id,item_key,target_id,content_digest FROM yaya_proposal_items WHERE proposal_id=$1 ORDER BY item_key', [proposal.proposal_id])).rows;
    const text = outcome.kind === 'answered' ? outcome.content : outcome.kind === 'clarified' ? outcome.question : outcome.kind === 'proposed' ? '已准备操作，请核对内容后再批准。' : '本次处理已停止，请按原运行核对。';
    await yayaDataRepository.saveRunTerminalMessage(client, principal, schoolId, {
      conversation_id: run.conversation_id, role: 'assistant', part: proposal === null ? 'assistant' : 'proposal-' + index,
      message_kind: proposal === null ? 'text' : 'tool_result', execution_state: outcome.kind === 'proposed' ? 'pending_approval' : outcome.kind === 'stopped' ? 'unknown' : 'none',
      fragments: [{ fragment_id: run.run_id + ':f' + index, text, sources: policy.sources, independently_readable: policy.independently_readable, provenance }],
      attachment_ids: [], run: { run_id: run.run_id, client_request_id: run.client_request_id }, binding_state: policy.binding_state,
      recovery: { actor_account_id: run.owner_account_id, proposal: proposal === null ? null : { proposal_id: proposal.proposal_id, batch_id: proposal.batch_id }, operations },
    });
  }
}
