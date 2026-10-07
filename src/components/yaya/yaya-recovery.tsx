"use client";
import { useState } from 'react';
import type { DataMessagePartProps } from '@assistant-ui/react';
import { parseYayaChatRecoveryMark, type YayaChatRecoveryMark } from '@/lib/yaya/chat-bind-contract';
import { useTeacher } from '@/components/teacher-provider';
import { Button } from '@/components/ui/button';
import { lookupOriginalRun, queryOriginalOperation } from './client/actions';
import { receiptProvesSuccess } from '@/lib/yaya/types';
import { YayaMarkdown } from './yaya-markdown';
import { YayaProposalPanel } from './yaya-proposal';

/** 历史只读取原身份；不执行旧批准，不调用模型。 */
export function YayaRecoveryPart({ data }: DataMessagePartProps<YayaChatRecoveryMark>) {
  const { principal } = useTeacher();
  const parsed = parseYayaChatRecoveryMark(data);
  const [checking, setChecking] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [proposal, setProposal] = useState<string | null>(null);
  const [operations, setOperations] = useState<string[]>([]);
  if (!parsed.ok || principal?.account_id !== parsed.value.owner_account_id) return null;
  const mark = parsed.value;
  const check = async () => {
    if (!mark.run) return;
    setChecking(true); setText(null); setProposal(null); setNotice(null); setOperations([]);
    try {
      if (mark.proposal) {
        const original = mark.proposal;
        const results: string[] = [];
        for (const item of mark.operations) {
          const checked = await queryOriginalOperation(item.operation_id, {
            batch_id: original.batch_id, proposal_id: original.proposal_id, item_key: item.item_key,
            operation_id: item.operation_id, target_id: item.target_id, actor_account_id: mark.actor_account_id,
          });
          const outcome = checked.outcome;
          const success = (outcome.kind === 'saved' || outcome.kind === 'saved_detail_unavailable') && receiptProvesSuccess(outcome.receipt);
          results.push('原操作 ' + item.operation_id + '：' + (success ? '回执已核实保存' : outcome.kind === 'in_progress' ? '仍在进行中' : '当前结果尚不能证明已保存'));
        }
        setOperations(results);
      }
      const result = await lookupOriginalRun(mark.conversation_id, mark.run.client_request_id);
      if (!result || !('run_id' in result) || result.run_id !== mark.run.run_id) { setNotice('原运行目前无法核验；不会重新发送。'); return; }
      if (result.status !== 'finished') { setNotice('原运行尚未得到可核验的终态；仅保留原身份。'); return; }
      if (result.outcome.kind === 'answered') setText(result.outcome.content);
      else if (result.outcome.kind === 'clarified') setText(result.outcome.question);
      else if (result.outcome.kind === 'proposed' && mark.proposal && result.outcome.proposals.some(item => item.proposal_id === mark.proposal?.proposal_id && item.batch_id === mark.proposal.batch_id)) setProposal(mark.proposal.proposal_id);
      else setNotice('本次运行已停止；已提交操作不会因此回滚。');
    } catch { setNotice('读取暂未完成；不会把它当作未保存或自动重发。'); }
    finally { setChecking(false); }
  };
  return <div className="space-y-2 rounded-xl border p-3">
    <p className="text-sm text-muted-foreground">历史核对仅读取原运行，不会自动执行操作。</p>
    <Button className="min-h-11" variant="outline" disabled={checking} onClick={() => void check()}>{checking ? '正在核对…' : '核对原运行'}</Button>
    {notice ? <p role="status" className="text-sm">{notice}</p> : null}
    {operations.map(line => <p key={line} className="break-all text-sm">{line}</p>)}
    {text ? <YayaMarkdown text={text} /> : null}
    {proposal ? <YayaProposalPanel proposalId={proposal} origin="model_suggestion" /> : null}
  </div>;
}
