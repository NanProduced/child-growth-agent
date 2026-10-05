'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Baby, Loader2, LogIn, PenLine, Send, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
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
import { Textarea } from '@/components/ui/textarea';
import {
  fetchClassContextState,
  isAbortError,
  isClassContextConfirmationReason,
  isReliableClassShape,
  type ClassContextLookupState,
} from '@/lib/class-context-client';
import { loadChildren } from '@/lib/child-list-client';
import { classLabel, isoDateInShanghai, parseIsoDateStrict } from '@/lib/format';
import type { GuideWriteAccessView } from '@/lib/guide/association-types';
import { observationFocusQuery } from '@/lib/guide/navigation';
import type { Child, SchoolClass } from '@/lib/types';

/**
 * 观察录入客户端（G6-WRITE1）：
 * - 身份与写权限由服务端解析后传入；前端不声明权限；
 * - 幼儿列表校验 HTTP 状态与响应形状：401/403/503、非法 JSON、网络失败都不当作“暂无幼儿”，
 *   提供可重试的显式错误，并保留已填写的原文；
 * - 迟到响应（旧请求代次）不得覆盖新身份或新选择；
 * - 从证据册带来的 item_id 只是关注点，随保存进入整理页，不自动关联、不预填内容。
 */

type ClassContextViewState =
  | { status: 'idle' }
  | { status: 'checking' }
  | ClassContextLookupState
  | { status: 'error'; message: string };

type ChildListState =
  | { status: 'loading' }
  | { status: 'ready'; children: Child[] }
  | { status: 'error'; message: string };

interface ConfirmedSelection {
  class_id: string;
  child_id: string;
  observed_at: string;
}

interface ClassContextResponseBody {
  status?: unknown;
  reason?: unknown;
  message?: unknown;
  error?: string;
  observation?: { id: string };
}

export function NewObservationClient({
  writeAccess,
  focus,
}: {
  writeAccess: GuideWriteAccessView;
  focus: { itemId: string | null; returnTo: string | null };
}) {
  const router = useRouter();
  const [childrenState, setChildrenState] = useState<ChildListState>({ status: 'loading' });
  const [childrenNonce, setChildrenNonce] = useState(0);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [classesLoading, setClassesLoading] = useState(false);
  const [classesError, setClassesError] = useState<string | null>(null);
  const [classesNonce, setClassesNonce] = useState(0);

  const [childId, setChildId] = useState('');
  const [observedAt, setObservedAt] = useState('');
  const [context, setContext] = useState('');
  const [rawText, setRawText] = useState('');
  const [classContext, setClassContext] = useState<ClassContextViewState>({ status: 'idle' });
  const [confirmedSelection, setConfirmedSelection] = useState<ConfirmedSelection | null>(null);
  const [lookupNonce, setLookupNonce] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // 当前有效的查询键：旧请求/旧响应不得覆盖新儿童或新日期的状态
  const lookupKeyRef = useRef<string | null>(null);
  // 防重复提交：状态更新是异步的，同一 tick 的连点必须被 ref 拦住
  const submittingRef = useRef(false);
  // URL 里的 child_id 只在第一次成功加载后应用一次，之后不覆盖教师的新选择
  const initialChildAppliedRef = useRef(false);

  // 默认日期仅客户端挂载后写入，且统一按亚洲/上海日历日，保证服务端渲染与水合一致
  useEffect(() => {
    setObservedAt(isoDateInShanghai());
  }, []);

  const canUseForm = writeAccess.can_record;

  useEffect(() => {
    if (!canUseForm) return;
    const controller = new AbortController();
    setChildrenState({ status: 'loading' });
    loadChildren(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setChildrenState({ status: 'ready', children: list });
        if (!initialChildAppliedRef.current) {
          initialChildAppliedRef.current = true;
          const requestedChildId = new URLSearchParams(window.location.search).get('child_id');
          if (requestedChildId && list.some((child) => child.id === requestedChildId)) {
            // 只在教师尚未选择时应用，迟到的列表响应不会覆盖新选择
            setChildId((previous) => (previous ? previous : requestedChildId));
          }
        }
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        setChildrenState({
          status: 'error',
          message: error instanceof Error ? error.message : '幼儿档案加载失败，请重试。',
        });
      });
    return () => controller.abort();
  }, [canUseForm, childrenNonce]);

  const retryChildren = useCallback(() => setChildrenNonce((n) => n + 1), []);

  // 教师确认“当时班级”的候选列表：包含已停用班级（历史班级可能已停用）；
  // 只展示资料可核实的班级，并显式提供加载失败提示与重试。
  useEffect(() => {
    if (!canUseForm) return;
    let alive = true;
    setClassesLoading(true);
    setClassesError(null);
    fetch('/api/classes')
      .then(async (r) => {
        const data = (await r.json().catch(() => null)) as { classes?: unknown } | null;
        if (!r.ok) {
          throw new Error(`班级列表加载失败（${r.status}），请重试。`);
        }
        if (!data || !Array.isArray(data.classes)) {
          throw new Error('班级列表返回了无法解析的数据，请重试。');
        }
        return data.classes.filter((item): item is SchoolClass => isReliableClassShape(item));
      })
      .then((list) => {
        if (alive) setClasses(list);
      })
      .catch((error: unknown) => {
        if (alive) {
          setClassesError(error instanceof Error ? error.message : '班级列表加载失败，请重试。');
        }
      })
      .finally(() => {
        if (alive) setClassesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [canUseForm, classesNonce]);

  // 幼儿或日期变化时，按分班历史核对发生班级。
  // 只接受明确合法的 resolved / needs_confirmation；无效 JSON、解析失败等进入错误态并可重试。
  // 请求代次（lookupNonce）也参与键控：同儿童同日期的重试不会被上一代迟到响应覆盖。
  useEffect(() => {
    const validDate = observedAt.length > 0 && parseIsoDateStrict(observedAt) !== null;
    const requestKey =
      childId && validDate ? `${childId}|${observedAt}|#${lookupNonce}` : null;
    lookupKeyRef.current = requestKey;
    // 切换对象/日期/重试代次后旧的人工选择立即失效
    setConfirmedSelection(null);
    if (!requestKey) {
      setClassContext({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setClassContext({ status: 'checking' });
    fetchClassContextState({ childId, observedAt, signal: controller.signal })
      .then((state) => {
        if (lookupKeyRef.current !== requestKey) return;
        if (state.status === 'resolved') {
          // resolved 时明确清除人工选择，避免旧选择影响后续提交
          setConfirmedSelection(null);
        }
        setClassContext(state);
      })
      .catch((error: unknown) => {
        if (lookupKeyRef.current !== requestKey) return;
        if (isAbortError(error)) return;
        setClassContext({
          status: 'error',
          message: error instanceof Error ? error.message : '核对发生时班级失败，请重试。',
        });
      });
    return () => controller.abort();
  }, [childId, observedAt, lookupNonce]);

  const children = childrenState.status === 'ready' ? childrenState.children : [];
  const selectedChild = children.find((c) => c.id === childId) ?? null;
  const needsClassConfirmation = classContext.status === 'needs_confirmation';
  // 提交只携带“当前确为 needs_confirmation 且绑定当前儿童+日期”的选择
  const boundSelection =
    confirmedSelection &&
    confirmedSelection.child_id === childId &&
    confirmedSelection.observed_at === observedAt
      ? confirmedSelection
      : null;
  const canSendConfirmedClass = needsClassConfirmation ? boundSelection : null;

  const retryLookup = useCallback(() => setLookupNonce((n) => n + 1), []);
  const retryClasses = useCallback(() => setClassesNonce((n) => n + 1), []);

  async function handleSubmit() {
    if (!childId) {
      toast.error('请选择幼儿');
      return;
    }
    if (!observedAt) {
      toast.error('请选择观察日期');
      return;
    }
    if (rawText.trim().length < 10) {
      toast.error('观察原文至少 10 个字，请尽量白描具体行为');
      return;
    }
    if (classContext.status === 'checking') {
      toast.error('正在核对这条观察发生时的班级，请稍候');
      return;
    }
    if (needsClassConfirmation && !canSendConfirmedClass) {
      toast.error('请选择这条观察发生时的班级');
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await fetch('/api/observations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          child_id: childId,
          observed_at: observedAt,
          context: context.trim() || null,
          raw_text: rawText.trim(),
          ...(canSendConfirmedClass
            ? { confirmed_class_id: canSendConfirmedClass.class_id }
            : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as ClassContextResponseBody;
      if (!res.ok || !data.observation) {
        if (data.error === 'class_context_confirmation_required') {
          setClassContext({
            status: 'needs_confirmation',
            reason: isClassContextConfirmationReason(data.reason) ? data.reason : 'no_attribution',
            message:
              typeof data.message === 'string' && data.message
                ? data.message
                : '无法自动确定这条观察发生时的班级，请选择。',
          });
          setConfirmedSelection(null);
        } else if (data.error === 'class_context_conflict') {
          // 保存边界发现班级资料在核对后已变化：立即失效旧选择并重新核对
          setConfirmedSelection(null);
          setLookupNonce((n) => n + 1);
        }
        throw new Error(
          typeof data.message === 'string' && data.message ? data.message : '保存失败，请稍后再试',
        );
      }
      toast.success('观察已保存，原文将不可修改');
      const focusQuery = observationFocusQuery({
        itemId: focus.itemId,
        returnTo: focus.returnTo,
      });
      router.push(`/observations/${data.observation.id}/review${focusQuery ? `?${focusQuery}` : ''}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败，请稍后再试');
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (!canUseForm) {
    return (
      <div className="mx-auto max-w-lg py-10">
        <Alert>
          <LogIn className="size-4" />
          <AlertTitle>需要教师身份</AlertTitle>
          <AlertDescription>
            {writeAccess.read_only_reason ??
              '录入观察属于写操作，需教师身份验证。请登录后再来；访客模式可浏览档案与已归档记录。'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (childrenState.status === 'ready' && childrenState.children.length === 0) {
    return (
      <div className="mx-auto max-w-lg py-10">
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-amber-100 text-amber-700">
              <Baby className="size-5" />
            </span>
            <div>
              <h2 className="font-medium">还没有成长档案，先建立一个成长档案</h2>
              <p className="mt-1 text-sm text-slate-500">
                建档完成后会自动回到这里录入第一次观察。
              </p>
            </div>
            <Button asChild>
              <Link href="/children/new">
                <UserPlus className="size-4" />
                建立成长档案
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <PenLine className="size-5 text-emerald-600" />
          开始记录观察
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          用白描方式记录幼儿的具体行为与语言。保存后原文不可修改，AI 会据此整理一张待确认草稿。
        </p>
        {focus.itemId ? (
          <p className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs leading-5 text-emerald-900" data-testid="focus-note">
            已从证据册带上关注条目与返回位置；关注条目不会自动成为关联或确认，保存后在整理页由你决定。
          </p>
        ) : null}
      </div>

      <Card className="border-emerald-200/80">
        <CardHeader>
          <CardTitle className="text-base">观察信息</CardTitle>
          <CardDescription>带 * 为必填</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {childrenState.status === 'error' ? (
            <div role="alert" className="space-y-2 rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-3" data-testid="children-error">
              <p className="text-xs leading-5 text-rose-800">{childrenState.message}</p>
              {childrenState.message.includes('教师身份') ? null : (
                <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={retryChildren} data-testid="children-retry">
                  重新加载幼儿列表
                </Button>
              )}
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="child">幼儿 *</Label>
              <Select value={childId} onValueChange={setChildId}>
                <SelectTrigger id="child" className="w-full">
                  <SelectValue
                    placeholder={
                      childrenState.status === 'loading'
                        ? '加载中…'
                        : childrenState.status === 'error'
                          ? '幼儿列表加载失败'
                          : '选择幼儿'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {children.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.avatar_emoji} {c.name}（
                      {classLabel(c.class_stage, c.class_name) ?? '未分班'}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="date">观察日期 *</Label>
              <Input
                id="date"
                type="date"
                value={observedAt}
                onChange={(e) => setObservedAt(e.target.value)}
              />
            </div>
          </div>

          {selectedChild ? (
            classContext.status === 'checking' ? (
              <div className="rounded-lg border bg-slate-50/70 px-3 py-2.5 text-xs leading-5 text-slate-500">
                正在按分班历史核对这条观察发生时的班级…
              </div>
            ) : classContext.status === 'resolved' ? (
              <div className="rounded-lg border bg-slate-50/70 px-3 py-2.5 text-xs leading-5 text-slate-500">
                发生时班级：
                <Badge variant="secondary" className="mx-1 font-normal">
                  {classLabel(classContext.class.stage, classContext.class.name) ??
                    classContext.class.name}
                </Badge>
                按分班历史核对，保存时写入这条观察的快照；以后班级改名或转班都不会改变它。
              </div>
            ) : classContext.status === 'needs_confirmation' ? (
              <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50/70 px-3 py-3">
                <p className="text-xs leading-5 text-amber-900">{classContext.message}</p>
                {classesError ? (
                  <div className="space-y-2">
                    <p className="text-xs leading-5 text-amber-900">{classesError}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11"
                      onClick={retryClasses}
                    >
                      重新加载班级
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor="class-context">当时所在班级 *</Label>
                    <Select
                      value={boundSelection?.class_id ?? ''}
                      onValueChange={(value) =>
                        setConfirmedSelection({
                          class_id: value,
                          child_id: childId,
                          observed_at: observedAt,
                        })
                      }
                      disabled={classesLoading}
                    >
                      <SelectTrigger id="class-context" className="w-full">
                        <SelectValue
                          placeholder={classesLoading ? '班级加载中…' : '选择当时所在班级'}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {classes.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {classLabel(c.stage, c.name) ?? c.name} · {c.school_year}
                            {c.is_active ? '' : '（已停用）'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {!classesLoading && classes.length === 0 ? (
                      <p className="text-xs leading-5 text-amber-900">
                        没有可核实的班级可选，请先建立或补全班级资料。
                      </p>
                    ) : null}
                  </div>
                )}
                <p className="text-xs leading-5 text-amber-800/80">
                  只用于记录这条观察的班级语境，不会改变幼儿当前分班。
                </p>
              </div>
            ) : classContext.status === 'error' ? (
              <div
                role="alert"
                className="space-y-2 rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-3"
              >
                <p className="text-xs leading-5 text-rose-800">{classContext.message}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  onClick={retryLookup}
                >
                  重新核对
                </Button>
              </div>
            ) : (
              <div className="rounded-lg border bg-slate-50/70 px-3 py-2.5 text-xs leading-5 text-slate-500">
                选择观察日期后，会自动按分班历史核对这条观察发生时的班级。
              </div>
            )
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="context">观察情境（选填）</Label>
            <Input
              id="context"
              placeholder="如：区域活动 / 娃娃家 / 户外散步"
              value={context}
              maxLength={200}
              onChange={(e) => setContext(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="raw">观察原文 *</Label>
              <span
                className={`text-xs ${rawText.trim().length < 10 ? 'text-slate-400' : 'text-emerald-600'}`}
              >
                {rawText.trim().length} 字
              </span>
            </div>
            <Textarea
              id="raw"
              rows={8}
              placeholder={'例：今天娃娃家里，糖糖抱着布娃娃，先给它盖好小毯子……她对小雨说：「你当姐姐，一起照顾她吧。」'}
              value={rawText}
              maxLength={5000}
              onChange={(e) => setRawText(e.target.value)}
              className="leading-7"
            />
            <p className="text-xs text-slate-400">
              提示：只记录看到和听到的，不写评判与猜测；原文保存后将作为不可改写的追溯依据。
            </p>
          </div>

          <Button
            className="min-h-11 w-full"
            onClick={() => void handleSubmit()}
            disabled={submitting || childrenState.status !== 'ready' || classContext.status === 'checking'}
            data-testid="save-observation"
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            保存观察并继续整理
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
