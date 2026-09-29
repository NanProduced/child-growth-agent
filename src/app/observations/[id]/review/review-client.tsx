'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  BadgeCheck,
  FileText,
  Loader2,
  Lock,
  MessageCircle,
  Quote,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AiBadge, DemoBadge, StatusBadge } from '@/components/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { useTeacher } from '@/components/teacher-provider';
import { formatDateCn, formatDateTimeCn } from '@/lib/format';
import { sameTeacherEditContent } from '@/lib/teacher-edit-review';
import {
  FIVE_DOMAINS,
  type AgentContext,
  type Child,
  type FollowUpAction,
  type Observation,
  type ObservationDraft,
  type TeacherEditContent,
  type TeacherEditReview,
  type TeacherEditReviewOutput,
} from '@/lib/types';

interface DraftForm {
  domain: string;
  sub_domain: string;
  objective_description: string;
  highlightText: string;
  suggestionText: string;
  highlight_quote: string;
}

const toLines = (v: string) =>
  v.split('\n').map((s) => s.trim().replace(/^[-•\d.、\s]+/, '')).filter(Boolean);

function draftToForm(d: ObservationDraft | null): DraftForm | null {
  if (!d) return null;
  return {
    domain: d.domain,
    sub_domain: d.sub_domain,
    objective_description: d.objective_description,
    highlightText: d.highlights.join('\n'),
    suggestionText: d.support_suggestions.join('\n'),
    highlight_quote: d.highlight_quote,
  };
}

function formToContent(form: DraftForm): TeacherEditContent {
  return {
    domain: form.domain,
    sub_domain: form.sub_domain.trim(),
    objective_description: form.objective_description.trim(),
    highlights: toLines(form.highlightText),
    support_suggestions: toLines(form.suggestionText),
    highlight_quote: form.highlight_quote.trim(),
  };
}

/** 只读展示一张观察分析卡片 */
function DraftView({ draft }: { draft: ObservationDraft }) {
  return (
    <div className="space-y-4 text-sm leading-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="bg-violet-100 text-violet-700">{draft.domain}</Badge>
        <Badge variant="outline">{draft.sub_domain}</Badge>
      </div>
      <div>
        <div className="mb-1 font-medium text-slate-700">发展表现说明</div>
        <p className="text-slate-600">{draft.objective_description}</p>
      </div>
      <div>
        <div className="mb-1 font-medium text-slate-700">发展亮点</div>
        <ul className="list-disc space-y-1 pl-5 text-slate-600">
          {draft.highlights.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      </div>
      <div>
        <div className="mb-1 font-medium text-slate-700">支持建议</div>
        <ul className="list-decimal space-y-1 pl-5 text-slate-600">
          {draft.support_suggestions.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>
      {draft.highlight_quote ? (
        <div className="rounded-lg border-l-4 border-amber-300 bg-amber-50 px-3 py-2 text-slate-700">
          <Quote className="mb-1 inline size-3.5 text-amber-500" /> {draft.highlight_quote}
        </div>
      ) : null}
      {draft.teacher_note ? (
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-600">
          <span className="font-medium">教师备注：</span>
          {draft.teacher_note}
        </div>
      ) : null}
    </div>
  );
}

export function ReviewClient({
  observation,
  child,
}: {
  observation: Observation;
  child: Child;
}) {
  const router = useRouter();
  const { loading: authLoading, configured, isTeacher } = useTeacher();

  const [status, setStatus] = useState(observation.status);
  const [confirmedContent, setConfirmedContent] = useState<ObservationDraft | null>(
    observation.confirmed_content
  );
  const [confirmedAt, setConfirmedAt] = useState(observation.confirmed_at);
  const [aiModel, setAiModel] = useState(observation.ai_model);
  const [organizedAt, setOrganizedAt] = useState(observation.ai_organized_at);
  const [aiDraft, setAiDraft] = useState<ObservationDraft | null>(observation.ai_draft);
  const [agentContext, setAgentContext] = useState<AgentContext | null>(observation.agent_context);
  const [teacherEditReview, setTeacherEditReview] = useState<TeacherEditReview | null>(
    observation.agent_context?.teacher_edit_review ?? null,
  );
  const [form, setForm] = useState<DraftForm | null>(draftToForm(observation.ai_draft));
  const [teacherNote, setTeacherNote] = useState(
    observation.confirmed_content?.teacher_note ?? ''
  );
  const [followUpContent, setFollowUpContent] = useState('');
  const [busy, setBusy] = useState<null | 'organize' | 'follow-up' | 'confirm'>(null);

  const teacherReady = configured && isTeacher;

  function applyObservation(updated: Observation) {
    setAgentContext(updated.agent_context);
    setTeacherEditReview(updated.agent_context?.teacher_edit_review ?? null);
    setAiDraft(updated.ai_draft);
    setForm(draftToForm(updated.ai_draft));
    setAiModel(updated.ai_model);
    setOrganizedAt(updated.ai_organized_at);
    setStatus(updated.status);
  }

  async function handleOrganize() {
    setBusy('organize');
    try {
      const res = await fetch(`/api/observations/${observation.id}/organize`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as {
        observation?: Observation;
        message?: string;
      };
      if (!res.ok || !data.observation) {
        throw new Error(data.message ?? 'AI 整理失败，请稍后重试');
      }
      const updated = data.observation;
      applyObservation(updated);
      if (updated.status === 'needs_input') {
        toast.info('这条观察还缺一项必要信息，请补充或选择跳过。');
      } else {
        toast.success('AI 整理完成，请核对后确认归档');
      }
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'AI 整理失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  }

  async function handleFollowUp(action: FollowUpAction) {
    setBusy('follow-up');
    try {
      const res = await fetch(`/api/observations/${observation.id}/follow-up`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          content: action === 'answer' ? followUpContent.trim() : '',
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        observation?: Observation;
        message?: string;
      };
      if (!res.ok || !data.observation) {
        throw new Error(data.message ?? '补充信息处理失败，请稍后重试');
      }
      applyObservation(data.observation);
      setFollowUpContent('');
      if (data.observation.status === 'needs_input') {
        toast.info('已记录补充信息，Agent 还有一个必要问题。');
      } else {
        toast.success('已按当前信息生成 AI 整理草稿');
      }
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '补充信息处理失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  }

  async function handleConfirm() {
    if (!form) return;
    const payload = { content: formToContent(form), teacher_note: teacherNote.trim() || undefined };
    if (!payload.content.sub_domain || !payload.content.objective_description) {
      toast.error('请补全子领域与发展表现说明');
      return;
    }
    if (payload.content.highlights.length === 0 || payload.content.support_suggestions.length === 0) {
      toast.error('发展亮点与支持建议至少各一条');
      return;
    }
    setBusy('confirm');
    try {
      const res = await fetch(`/api/observations/${observation.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        observation?: Observation;
        message?: string;
        requiresAgentConfirmation?: boolean;
        agentReview?: TeacherEditReviewOutput;
        profileUpdateStatus?: 'updated' | 'failed';
        profileUpdateMessage?: string;
      };
      if (!res.ok || !data.observation) {
        throw new Error(data.message ?? '确认归档失败，请稍后重试');
      }
      if (data.requiresAgentConfirmation) {
        setAgentContext(data.observation.agent_context);
        setTeacherEditReview(data.observation.agent_context?.teacher_edit_review ?? null);
        setStatus(data.observation.status);
        toast.info(
          data.agentReview?.decision === 'clarify'
            ? 'Agent 需要你进一步澄清这处修改。'
            : 'Agent 已完成修改审核，请进行最终归档。',
        );
        return;
      }
      if (data.profileUpdateStatus === 'failed') {
        toast.info(data.profileUpdateMessage ?? '观察已确认，成长档案暂未更新，请稍后重试。');
      } else if (data.profileUpdateStatus === 'updated') {
        toast.success('已确认归档，成长档案已更新');
      } else {
        toast.success('已确认归档，内容进入幼儿正册');
      }
      router.push(`/children/${child.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '确认归档失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  }

  const updateForm = (patch: Partial<DraftForm>) =>
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));

  const workflowStage = status === 'draft' ? 0 : status === 'needs_input' ? 1 : status === 'ai_organized' ? 2 : 3;
  const workflowSteps = ['已保存', '补充信息（按需）', 'AI 整理', '教师确认'];
  const followUp = agentContext?.follow_up;
  const currentContent = form ? formToContent(form) : null;
  const contentChanged = Boolean(
    currentContent && observation.ai_draft && !sameTeacherEditContent(observation.ai_draft, currentContent),
  );
  const reviewMatchesCurrent = Boolean(
    currentContent &&
      teacherEditReview &&
      sameTeacherEditContent(teacherEditReview.content_snapshot, currentContent),
  );

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/children/${child.id}`}>
          <ArrowLeft className="size-4" />
          返回 {child.name} 的档案
        </Link>
      </Button>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xl">{child.avatar_emoji ?? '🧒'}</span>
            <CardTitle className="text-base">
              {child.name} · {formatDateCn(observation.observed_at)}
            </CardTitle>
            {observation.is_demo ? <DemoBadge /> : null}
            <span className="ml-auto flex items-center gap-2">
              <StatusBadge status={status} />
            </span>
          </div>
          {observation.context ? (
            <CardDescription>观察情境：{observation.context}</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
            <FileText className="size-3.5" />
            观察原文（保存后不可修改，作为追溯依据）
          </div>
          <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm leading-7 text-slate-700">
            {observation.raw_text}
          </p>
        </CardContent>
      </Card>

      <div
        aria-label="观察处理进度"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500"
      >
        {workflowSteps.map((step, index) => (
          <span
            key={step}
            aria-current={index === workflowStage ? 'step' : undefined}
            className={index <= workflowStage ? 'font-medium text-emerald-700' : undefined}
          >
            {index > 0 ? '→ ' : ''}{step}
          </span>
        ))}
      </div>

      {authLoading ? (
        <div className="flex justify-center py-8 text-slate-400">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : !teacherReady ? (
        <Alert>
          <Lock className="size-4" />
          <AlertTitle>访客只读模式</AlertTitle>
          <AlertDescription>
            {configured
              ? '生成 AI 整理与确认归档需要教师身份：请点击右上角「教师登录」输入通行口令。'
              : '服务端尚未配置教师口令（TEACHER_PASSCODE），写入与 AI 调用已默认禁用；配置环境变量并重启后可用。'}
          </AlertDescription>
        </Alert>
      ) : null}

      {status === 'needs_input' && followUp ? (
        <Card className="border-rose-200 bg-rose-50/50">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageCircle className="size-5 text-rose-600" />
              补充信息
              <Badge variant="outline" className="font-normal text-rose-700">
                第 {followUp.round} / 2 轮
              </Badge>
            </CardTitle>
            <CardDescription>
              Agent 只在补充内容会影响发展线索或支持建议时提问。原始观察保持不变。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg bg-white px-3 py-3">
              <p className="font-medium leading-6 text-slate-800">{followUp.question}</p>
              <p className="mt-1 text-sm leading-6 text-slate-600">为什么需要：{followUp.reason}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="follow-up-content">教师补充（可跳过）</Label>
              <Textarea
                id="follow-up-content"
                rows={3}
                value={followUpContent}
                onChange={(e) => setFollowUpContent(e.target.value)}
                placeholder="写下你记得的具体行为、原话或支持方式"
                maxLength={2000}
              />
            </div>
          </CardContent>
          {teacherReady ? (
            <CardFooter className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
              <Button
                onClick={() => void handleFollowUp('answer')}
                disabled={busy !== null || !followUpContent.trim()}
              >
                {busy === 'follow-up' ? <Loader2 className="size-4 animate-spin" /> : null}
                回答并继续
              </Button>
              <Button
                variant="outline"
                onClick={() => void handleFollowUp('skip')}
                disabled={busy !== null}
              >
                跳过，直接整理
              </Button>
              <Button
                variant="ghost"
                onClick={() => void handleFollowUp('stop')}
                disabled={busy !== null}
              >
                不再追问
              </Button>
            </CardFooter>
          ) : null}
        </Card>
      ) : null}

      {status === 'confirmed' && confirmedContent ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <BadgeCheck className="size-5 text-emerald-600" />
              教师确认稿（已进入正册）
            </CardTitle>
            <CardDescription>
              确认时间：{formatDateTimeCn(confirmedAt)}
              {aiModel ? ` · 整理模型：${aiModel}` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DraftView draft={confirmedContent} />
          </CardContent>
        </Card>
      ) : null}

      {status === 'confirmed' && aiDraft ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm text-slate-600">
              <Sparkles className="size-4 text-violet-500" />
              追溯：AI 原始草稿（确认前版本）
            </CardTitle>
            <CardDescription>保留 AI 草稿与教师确认稿，便于回顾整理过程。</CardDescription>
          </CardHeader>
          <CardContent>
            <DraftView draft={aiDraft} />
          </CardContent>
        </Card>
      ) : null}

      {status !== 'confirmed' && status !== 'needs_input' && !form ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <Sparkles className="size-8 text-violet-400" />
            <div className="text-sm text-slate-600">
              还没有 AI 整理结果。AI 将依据《3-6 岁儿童学习与发展指南》把原文整理为
              结构化分析卡片，产出仅为草稿，需教师核对确认。
            </div>
            {teacherReady ? (
              <Button onClick={() => void handleOrganize()} disabled={busy !== null}>
                {busy === 'organize' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                生成 AI 整理
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {status === 'ai_organized' && form ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AiBadge />
              AI 整理草稿（教师可修改）
            </CardTitle>
            <CardDescription>
              请核对以下内容，可直接修改；确认后进入正册。原文始终不可修改。
              {aiModel ? ` · 模型：${aiModel}` : ''}
              {organizedAt ? ` · 整理时间：${formatDateTimeCn(organizedAt)}` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {contentChanged && !reviewMatchesCurrent ? (
              <Alert className="border-amber-200 bg-amber-50/70">
                <Sparkles className="size-4 text-amber-600" />
                <AlertTitle>检测到你修改了 AI 整理内容</AlertTitle>
                <AlertDescription>
                  提交后 Agent 会先核对修改与原始观察，再完成归档；教师备注单独变化不会触发这一步。
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>发展领域（五大领域）</Label>
                <Select
                  value={form.domain}
                  onValueChange={(v) => updateForm({ domain: v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择领域" />
                  </SelectTrigger>
                  <SelectContent>
                    {FIVE_DOMAINS.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>子领域</Label>
                <Input
                  value={form.sub_domain}
                  onChange={(e) => updateForm({ sub_domain: e.target.value })}
                  placeholder="如：同伴交往 / 科学观察"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="objective-description">发展表现说明</Label>
              <Textarea
                id="objective-description"
                rows={3}
                value={form.objective_description}
                onChange={(e) => updateForm({ objective_description: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>发展亮点（每行一条）</Label>
              <Textarea
                rows={4}
                value={form.highlightText}
                onChange={(e) => updateForm({ highlightText: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>支持建议（每行一条）</Label>
              <Textarea
                rows={4}
                value={form.suggestionText}
                onChange={(e) => updateForm({ suggestionText: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>原文金句</Label>
              <Input
                value={form.highlight_quote}
                onChange={(e) => updateForm({ highlight_quote: e.target.value })}
              />
            </div>

            <Separator />

            <div className="space-y-1.5">
              <Label>教师备注（确认时可选填）</Label>
              <Input
                value={teacherNote}
                onChange={(e) => setTeacherNote(e.target.value)}
                placeholder="如：记录属实，已补充细节；或说明修改原因"
                maxLength={500}
              />
            </div>
          </CardContent>
          {teacherReady && !reviewMatchesCurrent ? (
            <CardFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                onClick={() => void handleOrganize()}
                disabled={busy !== null}
              >
                {busy === 'organize' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                重新生成
              </Button>
              <Button onClick={() => void handleConfirm()} disabled={busy !== null}>
                {busy === 'confirm' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <BadgeCheck className="size-4" />
                )}
                {contentChanged ? '提交修改审核' : '确认归档'}
              </Button>
            </CardFooter>
          ) : null}
        </Card>
      ) : null}

      {status === 'ai_organized' && reviewMatchesCurrent && teacherEditReview ? (
        <Card
          className={
            teacherEditReview.decision === 'accept'
              ? 'border-emerald-200 bg-emerald-50/50'
              : 'border-amber-200 bg-amber-50/60'
          }
        >
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              {teacherEditReview.decision === 'accept' ? (
                <BadgeCheck className="size-5 text-emerald-600" />
              ) : (
                <MessageCircle className="size-5 text-amber-600" />
              )}
              <AiBadge />
              Agent 修改审核
            </CardTitle>
            <CardDescription>
              审核结果绑定当前教师修改内容；再次修改后需要重新审核。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-6">
            <p className="text-slate-700">{teacherEditReview.summary}</p>
            {teacherEditReview.change_summary.length > 0 ? (
              <div>
                <div className="font-medium text-slate-700">修改摘要</div>
                <ul className="list-disc space-y-1 pl-5 text-slate-600">
                  {teacherEditReview.change_summary.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="text-slate-600">
              原始观察依据：
              <span className="ml-1 font-medium text-slate-800">
                {teacherEditReview.fact_check === 'supported'
                  ? '有依据'
                  : teacherEditReview.fact_check === 'partially_supported'
                    ? '部分有依据'
                    : '依据不足'}
              </span>
            </div>
            {teacherEditReview.decision === 'clarify' ? (
              <Alert className="border-amber-200 bg-white/70">
                <MessageCircle className="size-4 text-amber-600" />
                <AlertTitle>还需要澄清</AlertTitle>
                <AlertDescription>{teacherEditReview.question}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
          {teacherReady ? (
            <CardFooter className="justify-end">
              {teacherEditReview.decision === 'accept' ? (
                <Button onClick={() => void handleConfirm()} disabled={busy !== null}>
                  {busy === 'confirm' ? <Loader2 className="size-4 animate-spin" /> : <BadgeCheck className="size-4" />}
                  确认归档
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => document.getElementById('objective-description')?.focus()}
                  disabled={busy !== null}
                >
                  返回修改
                </Button>
              )}
            </CardFooter>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
