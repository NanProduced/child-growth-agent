'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  BadgeCheck,
  FileText,
  Loader2,
  Lock,
  MessageCircle,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AiBadge, StatusBadge } from '@/components/status-badges';
import { Badge } from '@/components/ui/badge';
import { DraftView } from '@/components/draft-view';
import { GuideAssociationSection } from '@/components/guide/guide-association-section';
import type { BasisSourceOption, GuideItemOption, GuideWriteAccessView } from '@/lib/guide/association-types';
import { withEvidenceItemFocus } from '@/lib/guide/navigation';
import {
  confirmAppliedIsDecisive,
  decisionAppliedInLinks,
  decisionIdentity,
  parseHostObservationResponse,
  parseReviewConfirmResponse,
} from '@/lib/guide/mutation-response';
import type { GuideEvidenceDecisionInput, EvidenceLinkView } from '@/lib/guide/view-types';
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
import { fetchWithAccountAuth } from "@/lib/accounts/client";
import { formatDateCn, formatDateTimeCn, schoolClassLabel } from '@/lib/format';
import { followUpRounds } from '@/lib/follow-up';
import {
  sameClarificationSnapshot,
  sameTeacherEditContent,
  sameTeacherEditNote,
} from '@/lib/teacher-edit-review';
import {
  FIVE_DOMAINS,
  type AgentContext,
  type Child,
  type FollowUpAction,
  type Observation,
  type ObservationDraft,
  type TeacherEditContent,
  type TeacherEditReview,
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

export interface ReviewGuideContext {
  mode: 'pre_archive' | 'archived';
  revision: number;
  links: EvidenceLinkView[];
  detailUnavailable: boolean;
  itemOptions: GuideItemOption[];
  goalLabels: Record<string, string>;
  basisSources: BasisSourceOption[];
  focusItemId: string | null;
  focusItemUnknown: boolean;
  returnHref: string | null;
  /** 稳定页面身份：账号变化时清空上一个身份的私人草稿 */
  viewerKey: string;
  /** 服务端版本戳：变化代表新的服务端状态已到达 */
  serverStamp: string;
}

export function ReviewClient({
  observation,
  child,
  writeAccess,
  guide,
}: {
  observation: Observation;
  child: Child;
  writeAccess: GuideWriteAccessView;
  guide: ReviewGuideContext;
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
  const [clarifyContent, setClarifyContent] = useState('');
  const [busy, setBusy] = useState<null | 'organize' | 'follow-up' | 'confirm'>(null);
  const [guideRevision, setGuideRevision] = useState(guide.revision);
  const [guideLinks, setGuideLinks] = useState<EvidenceLinkView[]>(guide.links);
  const [guideDetailUnavailable, setGuideDetailUnavailable] = useState(guide.detailUnavailable);
  const [pendingGuide, setPendingGuide] = useState<{
    expectedRevision: number;
    decisions: GuideEvidenceDecisionInput[];
    staleCount: number;
  } | null>(null);
  const [guideBusy, setGuideBusy] = useState(false);
  const [confirmUnresolved, setConfirmUnresolved] = useState<null | {
    kind: 'confirm' | 'clarify';
    message: string;
  }>(null);
  // 仅表示“本客户端刚完成或经读回确认了归档写入”；普通已归档回看不因此锁死关联操作
  const [archiveCommitted, setArchiveCommitted] = useState(false);
  const [confirmReading, setConfirmReading] = useState(false);

  // 未提交修改的脏标记：刷新带来的服务端变化不能覆盖仍属于当前身份的教师修改
  const formDirtyRef = useRef(false);
  const noteDirtyRef = useRef(false);
  const viewerRef = useRef(guide.viewerKey);
  const stampRef = useRef(guide.serverStamp);

  // 服务端已按当前会话解析写权限；不信任客户端声明
  const teacherReady = writeAccess.can_organize || (configured && isTeacher);
  const liveConfirmed = useMemo(
    () =>
      form
        ? { highlight_quote: form.highlight_quote.trim(), highlights: toLines(form.highlightText) }
        : null,
    [form],
  );
  const handlePendingGuideChange = useCallback(
    (
      pending: {
        expectedRevision: number;
        decisions: GuideEvidenceDecisionInput[];
        staleCount: number;
      } | null,
    ) => {
      setPendingGuide(pending);
    },
    [],
  );
  const handleGuideRevisionChange = useCallback(
    (update: { revision: number; links: EvidenceLinkView[] }) => {
      setGuideRevision(update.revision);
      setGuideLinks(update.links);
      setGuideDetailUnavailable(false);
    },
    [],
  );
  const handleGuideBusyChange = useCallback((value: boolean) => {
    setGuideBusy(value);
  }, []);

  function applyObservation(updated: {
    agent_context: AgentContext | null;
    ai_draft: ObservationDraft | null;
    ai_model: string | null;
    ai_organized_at: string | null;
    status: Observation['status'];
  }) {
    setAgentContext(updated.agent_context);
    setTeacherEditReview(updated.agent_context?.teacher_edit_review ?? null);
    setAiDraft(updated.ai_draft);
    setForm(draftToForm(updated.ai_draft));
    formDirtyRef.current = false;
    setAiModel(updated.ai_model);
    setOrganizedAt(updated.ai_organized_at);
    setStatus(updated.status);
  }

  /**
   * 服务端新状态到达时的显式同步：更新观察状态、关联 revision/links/依据来源；
   * 保留仍属于当前身份的未提交修改与备注；账号变化时清空旧身份草稿；
   * 宿主已归档则清除待提交选择，不把旧草稿展示或提交。
   */
  useEffect(() => {
    if (viewerRef.current !== guide.viewerKey) {
      viewerRef.current = guide.viewerKey;
      formDirtyRef.current = false;
      noteDirtyRef.current = false;
      setConfirmUnresolved(null);
      setConfirmReading(false);
      setArchiveCommitted(false);
      setGuideBusy(false);
      setPendingGuide(null);
      setFollowUpContent('');
      setClarifyContent('');
      setStatus(observation.status);
      setConfirmedContent(observation.confirmed_content);
      setConfirmedAt(observation.confirmed_at);
      setAiModel(observation.ai_model);
      setOrganizedAt(observation.ai_organized_at);
      setAiDraft(observation.ai_draft);
      setAgentContext(observation.agent_context);
      setTeacherEditReview(observation.agent_context?.teacher_edit_review ?? null);
      setForm(draftToForm(observation.ai_draft));
      setTeacherNote(observation.confirmed_content?.teacher_note ?? '');
      setGuideRevision(guide.revision);
      setGuideLinks(guide.links);
      setGuideDetailUnavailable(guide.detailUnavailable);
      stampRef.current = guide.serverStamp;
      return;
    }
    if (stampRef.current === guide.serverStamp) return;
    stampRef.current = guide.serverStamp;
    setGuideBusy(false);
    setGuideRevision(guide.revision);
    setGuideLinks(guide.links);
    setGuideDetailUnavailable(guide.detailUnavailable);
    setStatus(observation.status);
    setConfirmedContent(observation.confirmed_content);
    setConfirmedAt(observation.confirmed_at);
    setAiModel(observation.ai_model);
    setOrganizedAt(observation.ai_organized_at);
    setAiDraft(observation.ai_draft);
    setAgentContext(observation.agent_context);
    setTeacherEditReview(observation.agent_context?.teacher_edit_review ?? null);
    if (observation.status === 'confirmed') {
      setArchiveCommitted(false);
      setConfirmUnresolved(null);
      setPendingGuide(null);
      formDirtyRef.current = false;
      noteDirtyRef.current = false;
      setForm(null);
    } else {
      setArchiveCommitted(false);
      if (!formDirtyRef.current) setForm(draftToForm(observation.ai_draft));
      if (!noteDirtyRef.current) setTeacherNote(observation.confirmed_content?.teacher_note ?? '');
    }
  }, [guide, observation]);

  /** 结果不确定时的读回核对：只有确认已归档才进入已保存；确认未归档才允许教师重试 */
  async function reconcileConfirmResult() {
    if (confirmReading) return;
    setConfirmReading(true);
    try {
      const res = await fetch(`/api/observations?child_id=${encodeURIComponent(child.id)}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const rawText = await res.text();
      const read = parseHostObservationResponse(res.status, rawText, observation.id);
      if (!read.ok) {
        toast.warning(
          `${read.message} 不能据此认为未保存；可继续重试「重新读取」，不会自动重复提交归档。`,
        );
        return;
      }
      if (read.observation.status === 'confirmed') {
        setConfirmUnresolved(null);
        setArchiveCommitted(true);
        setStatus('confirmed');
        setPendingGuide(null);
        formDirtyRef.current = false;
        noteDirtyRef.current = false;
        toast.info('重新读取后确认观察已归档；正在重新读取详情，请勿重复提交。');
        router.refresh();
        return;
      }
      setConfirmUnresolved(null);
      setStatus(read.observation.status);
      toast.info('重新读取后确认尚未归档；输入与待提交选择仍保留，可核对后重试。');
    } catch {
      toast.warning('读取中断，仍无法确认归档结果；可继续重试「重新读取」，不会自动重复提交。');
    } finally {
      setConfirmReading(false);
    }
  }

  async function handleOrganize() {
    setBusy('organize');
    try {
      const res = await fetchWithAccountAuth(`/api/observations/${observation.id}/organize`, {
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
      const res = await fetchWithAccountAuth(`/api/observations/${observation.id}/follow-up`, {
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
    if (archiveCommitted || confirmUnresolved || guideBusy) return;
    if (pendingGuide && pendingGuide.staleCount > 0) {
      toast.error('有关联选择需要重新核对，暂不能归档；请在关联区逐条重新核对或移除。');
      return;
    }
    const payload = {
      content: formToContent(form),
      teacher_note: teacherNote.trim() || undefined,
      ...(pendingGuide
        ? {
            guide_decisions: {
              expected_guide_revision: pendingGuide.expectedRevision,
              decisions: pendingGuide.decisions,
            },
          }
        : {}),
    };
    if (!payload.content.sub_domain || !payload.content.objective_description) {
      toast.error('请补全子领域与发展表现说明');
      return;
    }
    if (payload.content.highlights.length === 0 || payload.content.support_suggestions.length === 0) {
      toast.error('发展亮点与支持建议至少各一条');
      return;
    }
    setBusy('confirm');
    let res: Response;
    try {
      res = await fetchWithAccountAuth(`/api/observations/${observation.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      setConfirmUnresolved({
        kind: 'confirm',
        message: '网络中断，归档结果不确定；输入与待提交选择已保留，请重新读取核对。',
      });
      setBusy(null);
      return;
    }
    try {
      const rawText = await res.text();
      const parsed = parseReviewConfirmResponse(res.status, rawText, observation.id, child.id);
      if (!parsed.ok) {
        const failure = parsed.failure;
        if (failure.kind === 'http') {
          if (
            failure.error === 'basis_expired' ||
            failure.error === 'catalog_version_mismatch' ||
            failure.error === 'state_conflict'
          ) {
            toast.warning(`${failure.message} 请重新读取后核对；旧决定不会自动重放。`);
            router.refresh();
            return;
          }
          if (failure.status === 409) {
            // 其他 409（例如已被其他操作端归档）：写入确定未发生，先读回服务端事实再决定
            toast.warning(`${failure.message} 正在重新读取服务端状态核对。`);
            void reconcileConfirmResult();
            return;
          }
          throw new Error(failure.message);
        }
        setConfirmUnresolved({
          kind: 'confirm',
          message: `${failure.message} 输入与待提交选择已保留，请重新读取核对；系统不会自动重复提交。`,
        });
        return;
      }
      const data = parsed.value;
      const applied = confirmAppliedIsDecisive(data.guideEvidence);
      if (applied === 'saved_with_links') {
        const links = data.guideEvidence?.links ?? [];
        const decisions = pendingGuide?.decisions ?? [];
        const allDecisionsApplied = decisions.every((decision) =>
          decisionAppliedInLinks(links, decisionIdentity(decision)),
        );
        if (!allDecisionsApplied) {
          setConfirmUnresolved({
            kind: 'confirm',
            message:
              '响应已收到，但无法确认本次归档携带的关联决定已按内容生效；输入与待提交选择已保留，请重新读取核对。',
          });
          return;
        }
        setGuideRevision(data.guideEvidence?.revision ?? guideRevision);
        setGuideLinks(links);
        setGuideDetailUnavailable(false);
        setPendingGuide(null);
      }
      if (data.requiresAgentConfirmation) {
        setAgentContext(data.observation.agent_context);
        setTeacherEditReview(data.observation.agent_context?.teacher_edit_review ?? null);
        setStatus(data.observation.status);
        toast.info(
          applied === 'deferred'
            ? '关联选择已保留，将在最终归档时与观察一起写入。'
            : data.agentReview?.decision === 'clarify'
              ? 'Agent 需要你进一步澄清这处修改。'
              : 'Agent 已完成修改审核，请进行最终归档。',
        );
        return;
      }
      if (applied === 'saved_detail_unavailable') {
        setPendingGuide(null);
        setArchiveCommitted(true);
        setStatus('confirmed');
        toast.info(
          data.guideEvidence?.message ??
            '观察与关联决定已保存；证据详情暂时无法读取，正在重新读取，请勿重复提交。',
        );
        router.refresh();
        return;
      }
      if (data.observation.status !== 'confirmed') {
        setConfirmUnresolved({
          kind: 'confirm',
          message: '响应已收到，但无法确认归档结果；输入与待提交选择已保留，请重新读取核对。',
        });
        return;
      }
      setArchiveCommitted(true);
      setStatus('confirmed');
      setPendingGuide(null);
      formDirtyRef.current = false;
      noteDirtyRef.current = false;
      if (data.profileUpdateStatus === 'failed') {
        toast.info(data.profileUpdateMessage ?? '观察已确认，成长档案暂未更新，请稍后重试。');
      } else if (data.profileUpdateStatus === 'updated') {
        toast.success(
          applied === 'saved_with_links' ? '已确认归档，成长档案与指南关联已更新' : '已确认归档，成长档案已更新',
        );
      } else {
        toast.success(applied === 'saved_with_links' ? '已确认归档，指南关联已写入' : '已确认归档，内容进入幼儿正册');
      }
      if (guide.returnHref) {
        router.push(withEvidenceItemFocus(guide.returnHref, guide.focusItemId));
        return;
      }
      router.push(`/children/${child.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '确认归档失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  }

  async function handleClarify() {
    if (!form || !clarifyContent.trim()) return;
    if (archiveCommitted || confirmUnresolved || guideBusy) return;
    if (pendingGuide && pendingGuide.staleCount > 0) {
      toast.error('有关联选择需要重新核对，暂不能提交；请在关联区逐条重新核对或移除。');
      return;
    }
    setBusy('confirm');
    let res: Response;
    try {
      res = await fetchWithAccountAuth(`/api/observations/${observation.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: formToContent(form),
          teacher_note: teacherNote.trim() || undefined,
          clarification: clarifyContent.trim(),
          ...(pendingGuide
            ? {
                guide_decisions: {
                  expected_guide_revision: pendingGuide.expectedRevision,
                  decisions: pendingGuide.decisions,
                },
              }
            : {}),
        }),
      });
    } catch {
      setConfirmUnresolved({
        kind: 'clarify',
        message: '网络中断，提交结果不确定；输入与待提交选择已保留，请重新读取核对。',
      });
      setBusy(null);
      return;
    }
    try {
      const rawText = await res.text();
      const parsed = parseReviewConfirmResponse(res.status, rawText, observation.id, child.id);
      if (!parsed.ok) {
        if (parsed.failure.kind === 'http') throw new Error(parsed.failure.message);
        setConfirmUnresolved({
          kind: 'clarify',
          message: `${parsed.failure.message} 输入与待提交选择已保留，请重新读取核对；系统不会自动重复提交。`,
        });
        return;
      }
      const data = parsed.value;
      if (!data.requiresAgentConfirmation) {
        if (data.observation.status === 'confirmed') {
          setArchiveCommitted(true);
          setStatus('confirmed');
          setPendingGuide(null);
          toast.info('响应显示观察已归档；正在重新读取详情，请勿重复提交。');
          router.refresh();
          return;
        }
        setConfirmUnresolved({
          kind: 'clarify',
          message: '响应已收到，但无法确认澄清提交结果；输入与待提交选择已保留，请重新读取核对。',
        });
        return;
      }
      setAgentContext(data.observation.agent_context);
      setTeacherEditReview(data.observation.agent_context?.teacher_edit_review ?? null);
      setStatus(data.observation.status);
      setClarifyContent('');
      toast.success(
        confirmAppliedIsDecisive(data.guideEvidence) === 'deferred'
          ? '关联选择已保留，将在最终归档时写入。'
          : data.agentReview?.decision === 'accept'
            ? '已结合补充依据完成审核，请进行最终归档。'
            : 'Agent 还需要进一步澄清，请继续补充。',
      );
    } catch (e) {
      // 提交失败保留输入，教师可以直接重试
      toast.error(e instanceof Error ? e.message : '提交澄清失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  }

  const updateForm = (patch: Partial<DraftForm>) => {
    formDirtyRef.current = true;
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const pendingStaleCount = pendingGuide?.staleCount ?? 0;
  const confirmLockReason = archiveCommitted
    ? '这条观察已归档，不能重复提交'
    : confirmUnresolved
      ? '归档结果待核对，请先重新读取'
      : guideBusy
        ? '关联操作进行中，暂不能归档'
        : pendingStaleCount > 0
          ? '有关联选择需要重新核对或移除'
          : null;
  const confirmDisabled = busy !== null || confirmLockReason !== null;
  const workflowStage = status === 'draft' ? 0 : status === 'needs_input' ? 1 : status === 'ai_organized' ? 2 : 3;
  const observedClassText = schoolClassLabel(observation.observed_class);
  const workflowSteps = ['已保存', '补充信息（按需）', 'AI 整理', '教师确认'];
  const followUp = agentContext?.follow_up;
  const answeredRounds = followUp
    ? followUpRounds(followUp).filter((round) => round.answer !== null)
    : [];
  const clarifications = agentContext?.teacher_edit_clarifications ?? [];
  const currentContent = form ? formToContent(form) : null;
  const contentChanged = Boolean(
    currentContent && observation.ai_draft && !sameTeacherEditContent(observation.ai_draft, currentContent),
  );
  const reviewMatchesCurrent = Boolean(
    currentContent &&
      teacherEditReview &&
      sameTeacherEditContent(teacherEditReview.content_snapshot, currentContent) &&
      sameClarificationSnapshot(teacherEditReview, clarifications) &&
      sameTeacherEditNote(teacherEditReview, teacherNote),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/children/${child.id}`}>
          <ArrowLeft className="size-4" />
          返回 {child.name} 的档案
        </Link>
      </Button>

      <Card className="border-slate-200/90">
        <CardHeader className="border-b bg-slate-50/60 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xl">{child.avatar_emoji ?? '🧒'}</span>
            <CardTitle className="text-base">
              {child.name} · {formatDateCn(observation.observed_at)}
            </CardTitle>
            <span className="ml-auto flex items-center gap-2">
              <StatusBadge status={status} />
            </span>
          </div>
          {observedClassText ? (
            <CardDescription>发生时班级：{observedClassText}</CardDescription>
          ) : null}
          {observation.context ? (
            <CardDescription>观察情境：{observation.context}</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
            <FileText className="size-3.5 text-emerald-700" />
            观察原文（保存后不可修改，作为追溯依据）
          </div>
          <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm leading-7 text-slate-700">
            {observation.raw_text}
          </p>
        </CardContent>
      </Card>

      <div aria-label="观察处理进度" className="rounded-xl border bg-white p-3">
        <div className="flex flex-wrap gap-2">
          {workflowSteps.map((step, index) => (
            <span
              key={step}
              aria-current={index === workflowStage ? 'step' : undefined}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ${
                index === workflowStage
                  ? 'bg-emerald-100 font-medium text-emerald-800'
                  : index < workflowStage
                    ? 'bg-slate-100 text-slate-600'
                    : 'text-slate-400'
              }`}
            >
              <span className="flex size-4 items-center justify-center rounded-full bg-white/80 text-xs" aria-hidden="true">
                {index + 1}
              </span>
              {step}
            </span>
          ))}
        </div>
      </div>

      {authLoading ? (
        <div className="flex justify-center py-8 text-slate-400">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : !teacherReady ? (
        <Alert>
          <Lock className="size-4" />
          <AlertTitle>只读模式</AlertTitle>
          <AlertDescription>
            {writeAccess.read_only_reason ??
              (configured
                ? '生成 AI 整理与确认归档需要教师身份：请点击右上角「园所账号登录」输入账号密码。'
                : '服务端尚未配置账号认证（AUTH_TRUSTED_ORIGINS），写入与 AI 调用已默认禁用；配置环境变量并重启后可用。')}
          </AlertDescription>
        </Alert>
      ) : null}

      {confirmUnresolved ? (
        <Alert className="border-amber-300 bg-amber-50/70" data-testid="confirm-unresolved">
          <RefreshCw className="size-4 text-amber-700" />
          <AlertTitle>归档结果待核对</AlertTitle>
          <AlertDescription>
            <p className="leading-6 text-amber-900">{confirmUnresolved.message}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 min-h-11"
              onClick={() => void reconcileConfirmResult()}
              disabled={confirmReading}
              data-testid="confirm-reconcile"
            >
              {confirmReading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              重新读取核对
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {archiveCommitted && !confirmedContent ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-900" role="status" data-testid="archive-committed-pending-detail">
          这条观察已确认归档；详情暂时未读取到，正在重新读取。请勿重复提交归档或再次修改关联。
        </p>
      ) : null}

      {teacherReady && confirmLockReason && status !== 'confirmed' ? (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900" role="status" data-testid="confirm-lock-note">
          暂不能提交归档或澄清：{confirmLockReason}。
        </p>
      ) : null}

      <GuideAssociationSection
        observationId={observation.id}
        childId={child.id}
        hostStatus={status}
        access={writeAccess}
        mode={guide.mode}
        revision={guideRevision}
        links={guideLinks}
        detailUnavailable={guideDetailUnavailable}
        itemOptions={guide.itemOptions}
        goalLabels={guide.goalLabels}
        basisSources={guide.basisSources}
        focusItemId={guide.focusItemId}
        focusItemUnknown={guide.focusItemUnknown}
        liveConfirmed={liveConfirmed}
        viewerKey={guide.viewerKey}
        serverStamp={guide.serverStamp}
        hostBusy={busy === 'confirm' || busy === 'organize' || busy === 'follow-up'}
        hostCommitted={archiveCommitted}
        onRevisionChange={handleGuideRevisionChange}
        onPendingChange={handlePendingGuideChange}
        onBusyChange={handleGuideBusyChange}
      />

      {status === 'needs_input' && followUp ? (
        <Card className="border-sky-200 bg-sky-50/50">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageCircle className="size-5 text-sky-600" />
              补充信息
              <Badge variant="outline" className="font-normal text-sky-700">
                第 {followUp.round} / 2 轮
              </Badge>
            </CardTitle>
            <CardDescription>
              Agent 只在补充内容会影响发展线索或支持建议时提问。原始观察保持不变。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {answeredRounds.length > 0 ? (
              <div className="rounded-lg bg-white/70 px-3 py-3">
                <p className="text-xs font-medium text-slate-500">此前补充</p>
                <ul className="mt-2 space-y-2 text-sm leading-6">
                  {answeredRounds.map((round) => (
                    <li key={round.round}>
                      <p className="text-slate-600">
                        {round.question
                          ? `第 ${round.round} 轮：${round.question}`
                          : '历史补充（原追问问题未保存）'}
                      </p>
                      <p className="text-slate-800">
                        教师回应：
                        {round.answer?.action === 'answer'
                          ? round.answer.content
                          : round.answer?.action === 'skip'
                            ? '跳过，直接整理'
                            : '不再追问'}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
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
                className="w-full sm:w-auto"
                onClick={() => void handleFollowUp('answer')}
                disabled={busy !== null || guideBusy || !followUpContent.trim()}
              >
                {busy === 'follow-up' ? <Loader2 className="size-4 animate-spin" /> : null}
                回答并继续
              </Button>
              <Button
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => void handleFollowUp('skip')}
                disabled={busy !== null || guideBusy}
              >
                跳过，直接整理
              </Button>
              <Button
                variant="ghost"
                className="w-full sm:w-auto"
                onClick={() => void handleFollowUp('stop')}
                disabled={busy !== null || guideBusy}
              >
                不再追问
              </Button>
            </CardFooter>
          ) : null}
        </Card>
      ) : null}

      {status === 'confirmed' && confirmedContent ? (
        <Card className="border-emerald-200/90 bg-emerald-50/30">
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
        <Card className="border-violet-200/80 bg-violet-50/20">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm text-slate-600">
              <Sparkles className="size-4 text-violet-500" />
              追溯：AI 原始草稿（确认前版本）
            </CardTitle>
            <CardDescription>AI 生成，仅为草稿；保留它与教师确认稿，便于回顾整理过程。</CardDescription>
          </CardHeader>
          <CardContent>
            <DraftView draft={aiDraft} />
          </CardContent>
        </Card>
      ) : null}

      {status !== 'confirmed' && status !== 'needs_input' && !form ? (
        <Card className="border-violet-200/80 bg-violet-50/20">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <Sparkles className="size-8 text-violet-400" />
            <div className="text-sm text-slate-600">
              还没有 AI 整理结果。AI 将依据《3-6 岁儿童学习与发展指南》把原文整理为
              结构化分析卡片，产出仅为草稿，需教师核对确认。
            </div>
            {teacherReady ? (
              <Button onClick={() => void handleOrganize()} disabled={busy !== null || guideBusy}>
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
        <Card className="border-amber-200/90">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AiBadge />
              AI 整理草稿（教师可修改）
            </CardTitle>
            <CardDescription>
              AI 生成，仅为草稿。请核对并按需要修改；确认后才进入正册，原文始终不可修改。
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
                onChange={(e) => { noteDirtyRef.current = true; setTeacherNote(e.target.value); }}
                placeholder="如：记录属实，已补充细节；或说明修改原因"
                maxLength={500}
              />
            </div>
          </CardContent>
          {teacherReady && !reviewMatchesCurrent ? (
            <CardFooter className="flex flex-col gap-2 border-t bg-slate-50/50 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => void handleOrganize()}
                disabled={busy !== null || guideBusy}
              >
                {busy === 'organize' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                重新生成
              </Button>
              <Button onClick={() => void handleConfirm()} disabled={confirmDisabled} className="w-full sm:w-auto" data-testid="confirm-archive">
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
            <div className="rounded-lg bg-white/75 px-3 py-2 font-medium text-slate-700">
              {teacherEditReview.decision === 'accept'
                ? '已理解这次修改，可以最终归档。'
                : '需要澄清这次修改，再继续归档。'}
            </div>
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
            {clarifications.length > 0 ? (
              <div className="rounded-lg bg-white/70 px-3 py-2">
                <div className="text-xs font-medium text-slate-500">已补充的依据</div>
                <ul className="mt-1 space-y-2 text-sm leading-6">
                  {clarifications.map((item, index) => (
                    <li key={`${item.created_at}-${index}`}>
                      <span className="text-slate-500">问题：{item.question}</span>
                      <span className="mt-0.5 block text-slate-700">教师补充：{item.answer}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
          {teacherReady ? (
            <CardFooter className="justify-end border-t bg-white/60">
              {teacherEditReview.decision === 'accept' ? (
                <Button onClick={() => void handleConfirm()} disabled={confirmDisabled} className="w-full sm:w-auto" data-testid="confirm-archive">
                  {busy === 'confirm' ? <Loader2 className="size-4 animate-spin" /> : <BadgeCheck className="size-4" />}
                  确认归档
                </Button>
              ) : (
                <div className="w-full space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="clarify-answer">补充依据（回答上面的问题）</Label>
                    <Textarea
                      id="clarify-answer"
                      rows={3}
                      value={clarifyContent}
                      onChange={(e) => setClarifyContent(e.target.value)}
                      placeholder="写下与这处修改相关的具体事实、原话或当时的支持方式"
                      maxLength={2000}
                    />
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                    <Button
                      variant="outline"
                      className="w-full sm:w-auto"
                      onClick={() => document.getElementById('objective-description')?.focus()}
                      disabled={busy !== null || guideBusy}
                    >
                      返回修改
                    </Button>
                    <Button
                      className="w-full sm:w-auto"
                      onClick={() => void handleClarify()}
                      disabled={confirmDisabled || !clarifyContent.trim()}
                    >
                      {busy === 'confirm' ? <Loader2 className="size-4 animate-spin" /> : null}
                      提交澄清并重新审核
                    </Button>
                  </div>
                </div>
              )}
            </CardFooter>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
