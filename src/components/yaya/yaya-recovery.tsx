"use client";
import { useState } from 'react';
import type { DataMessagePartProps } from '@assistant-ui/react';
import { History } from 'lucide-react';
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
  const [operations, setOperations] = useState<Array<{ id: string; text: string }>>([]);
  if (!parsed.ok || principal?.account_id !== parsed.value.owner_account_id) return null;
  const mark = parsed.value;
  const check = async () => {
    if (!mark.run) return;
    setChecking(true); setText(null); setProposal(null); setNotice(null); setOperations([]);
    try {
      if (mark.proposal) {
        const original = mark.proposal;
        const results: Array<{ id: string; text: string }> = [];
        for (const item of mark.operations) {
          const checked = await queryOriginalOperation(item.operation_id, {
            batch_id: original.batch_id, proposal_id: original.proposal_id, item_key: item.item_key,
            operation_id: item.operation_id, target_id: item.target_id, actor_account_id: mark.actor_account_id,
          });
          const outcome = checked.outcome;
          const success = (outcome.kind === 'saved' || outcome.kind === 'saved_detail_unavailable') && receiptProvesSuccess(outcome.receipt);
          results.push({ id: item.operation_id, text: success ? '已保存' : outcome.kind === 'in_progress' ? '仍在处理中' : '保存结果待核对' });
        }
        setOperations(results);
      }
      const result = await lookupOriginalRun(mark.conversation_id, mark.run.client_request_id);
      if (!result || !('run_id' in result) || result.run_id !== mark.run.run_id) { setNotice('暂时无法确认上次请求的结果，不会自动重发。'); return; }
      if (result.status !== 'finished') { setNotice('上次请求还没有可确认的结果，请稍后再核对。'); return; }
      if (result.outcome.kind === 'answered') setText(result.outcome.content);
      else if (result.outcome.kind === 'clarified') setText(result.outcome.question);
      else if (result.outcome.kind === 'proposed' && mark.proposal && result.outcome.proposals.some(item => item.proposal_id === mark.proposal?.proposal_id && item.batch_id === mark.proposal.batch_id)) setProposal(mark.proposal.proposal_id);
      else setNotice('上次回复已停止；已经保存的内容不会撤销。');
    } catch { setNotice('暂时读不到上次结果，不会自动重复提交。'); }
    finally { setChecking(false); }
  };
  return <div className="space-y-4">
    <section className="space-y-2 rounded-xl border border-border bg-card p-4 text-base leading-[1.65] text-foreground sm:text-sm" aria-busy={checking}>
      <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 font-semibold"><History className="size-4 text-muted-foreground" aria-hidden />上次请求的结果</h3>
      <Button className="min-h-11 rounded-xl shadow-none" variant="outline" disabled={checking} onClick={() => void check()}>{checking ? '正在核对…' : '核对上次结果'}</Button>
      </div>
      <p className="text-sm text-muted-foreground">只检查上次请求，不会再次执行操作。</p>
      {notice ? <p role="status">{notice}</p> : null}
      {operations.map((item, index) => <p key={item.id} role="status" className="text-sm">第 {index + 1} 项：{item.text}</p>)}
      <details className="text-xs leading-5 text-muted-foreground">
        <summary className="min-h-11 cursor-pointer content-center rounded-lg px-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">查看请求信息</summary>
        <div className="space-y-2 pb-2 [overflow-wrap:anywhere]">
          <p>原会话：{mark.conversation_id}</p>
          <p>历史所有者：{mark.owner_account_id}</p>
          <p>原执行账号：{mark.actor_account_id}</p>
          {mark.run ? <><p>原运行：{mark.run.run_id}</p><p>原请求：{mark.run.client_request_id}</p></> : null}
          {mark.proposal ? <><p>原提案：{mark.proposal.proposal_id}</p><p>原批次：{mark.proposal.batch_id}</p></> : null}
          {mark.operations.map((item) => <p key={item.operation_id}>原操作：{item.operation_id} · 项目：{item.item_key} · 原对象：{item.target_id ?? '未提供'}</p>)}
          {operations.map(item => <p key={item.id}>原操作 {item.id}：{item.text}</p>)}
        </div>
      </details>
    </section>
    {text ? <YayaMarkdown text={text} /> : null}
    {proposal ? <YayaProposalPanel proposalId={proposal} origin="model_suggestion" /> : null}
  </div>;
}
