import type { HeaderCarrier } from '@/lib/accounts/guards';
import { AccountsError } from '@/lib/accounts/errors';
import { parseCookieHeader, hashSessionToken, SESSION_COOKIE_NAME } from '@/lib/accounts/session';
import { withPrivateRead } from '@/lib/yaya/data';
import { createYayaToolkit } from '@/lib/yaya/tools/write';
import { absorbYayaRunDependencies, type YayaRunRuntimeState } from './context';
import { assertYayaRunActive, loadYayaRun, type YayaRunDependency } from './store';
import type { YayaRunWriteBinding } from './deps';
import { parseResourceRef } from '@/lib/yaya/data/rows';

/** 只准备提案；批准与业务执行仍由独立 CSRF 接口完成。 */
export function createPlatformWriteBinding(state: YayaRunRuntimeState, carrier: HeaderCarrier): YayaRunWriteBinding {
  const token = parseCookieHeader(carrier.headers.get('cookie')).get(SESSION_COOKIE_NAME) ?? '';
  const toolkit = createYayaToolkit({
    request: carrier,
    resolveConversationId: async (runId) => {
      if (runId !== state.run.run_id) return null;
      const current = await loadYayaRun(runId);
      return current?.owner_account_id === state.run.owner_account_id ? current.conversation_id : null;
    },
    verifyRun: async ({ client, run_id, principal }) => {
      if (principal.account_id !== state.run.owner_account_id || run_id !== state.run.run_id) throw new AccountsError('out_of_scope', '运行不属于当前账号。');
      await assertYayaRunActive(client, run_id, state.owner_instance);
      const original = await client.query<{ valid: boolean }>(
        `SELECT s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AS valid
           FROM yaya_runs r JOIN app_sessions s ON s.id = r.session_id
          WHERE r.id = $1 AND r.owner_account_id = $2 AND r.conversation_id = $3 AND s.token_hash = $4`,
        [run_id, principal.account_id, state.run.conversation_id, hashSessionToken(token)],
      );
      if (original.rows[0]?.valid !== true) throw new AccountsError('unauthenticated', '原运行会话已失效。');
    },
  });
  return {
    write_tools: toolkit.toolkit.tools.write_tools,
    proposeWrite: async (input) => {
      const result = await toolkit.toolkit.proposeWrite(input);
      if (result.ok) {
        // 提案准备读取的业务对象也属于运行依赖，不能只登记最终模型引用。
        const additions = await withPrivateRead(carrier, async ({ client, principal }) => {
          const refs: YayaRunDependency[] = [];
          for (const proposal of result.proposals) {
            const rows = await client.query<{ resource_ref: unknown; payload: { image_ids?: string[] } }>('SELECT resource_ref,payload FROM yaya_proposal_items WHERE proposal_id=$1', [proposal.proposal_id]);
            for (const row of rows.rows) {
              const resource = parseResourceRef(row.resource_ref);
              const ids: string[] = [];
              if (resource?.kind === 'child' || resource?.kind === 'transfer') ids.push('child:' + resource.child_id);
              if (resource?.kind === 'transfer') ids.push('class:' + resource.target_class_id);
              if (resource?.kind === 'observation') ids.push('observation:' + resource.observation_id);
              if (resource?.kind === 'class' && resource.class_id !== null) ids.push('class:' + resource.class_id);
              if (resource?.kind === 'school') ids.push('teacher_accounts:school');
              for (const ref_id of ids) refs.push({ ref: { kind: 'tool_result', ref_id, label: null, derived_from: null }, tool: input.tool, image_id: null, message_id: null, fragment_id: null, projection: 'full' });
              for (const image_id of row.payload.image_ids ?? []) refs.push({ ref: null, tool: input.tool, image_id, message_id: null, fragment_id: null, projection: 'full' });
            }
          }
          if (principal.account_id !== state.run.owner_account_id) throw new AccountsError('unauthenticated', '账号已变化。');
          return refs;
        });
        await absorbYayaRunDependencies(state, additions);
      }
      return result;
    },
  };
}
