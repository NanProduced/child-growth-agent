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
import { useTeacher } from '@/components/teacher-provider';
import {
  fetchClassContextState,
  isAbortError,
  isClassContextConfirmationReason,
  isReliableClassShape,
  type ClassContextLookupState,
} from '@/lib/class-context-client';
import { classLabel, isoDateInShanghai, parseIsoDateStrict } from '@/lib/format';
import type { Child, SchoolClass } from '@/lib/types';

type ClassContextViewState =
  | { status: 'idle' }
  | { status: 'checking' }
  | ClassContextLookupState
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

export default function NewObservationPage() {
  const router = useRouter();
  const { loading: authLoading, configured, isTeacher } = useTeacher();
  const [children, setChildren] = useState<Child[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [classesLoading, setClassesLoading] = useState(false);
  const [classesError, setClassesError] = useState<string | null>(null);
  const [classesNonce, setClassesNonce] = useState(0);
  const [loadingChildren, setLoadingChildren] = useState(true);

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

  // 默认日期仅客户端挂载后写入，且统一按亚洲/上海日历日，保证服务端渲染与水合一致
  useEffect(() => {
    setObservedAt(isoDateInShanghai());
  }, []);

  useEffect(() => {
    let alive = true;
    fetch('/api/children')
      .then((r) => r.json())
      .then((data: { children?: Child[] }) => {
        if (!alive) return;
        const nextChildren = data.children ?? [];
        setChildren(nextChildren);
        const requestedChildId = new URLSearchParams(window.location.search).get('child_id');
        if (requestedChildId && nextChildren.some((child) => child.id === requestedChildId)) {
          setChildId(requestedChildId);
        }
      })
      .catch(() => toast.error('幼儿档案加载失败，请刷新重试'))
      .finally(() => {
        if (alive) setLoadingChildren(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 教师确认“当时班级”的候选列表：包含已停用班级（历史班级可能已停用）；
  // 只展示资料可核实的班级，并显式提供加载失败提示与重试。
  useEffect(() => {
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
  }, [classesNonce]);

  // 幼儿或日期变化时，按分班历史核对发生班级。
  // 只接受明确合法的 resolved / needs_confirmation；无效 JSON、解析失败等进入错误态并可重试。
  useEffect(() => {
    const validDate = observedAt.length > 0 && parseIsoDateStrict(observedAt) !== null;
    const key = childId && validDate ? `${childId}|${observedAt}` : null;
    lookupKeyRef.current = key;
    // 切换对象/日期后旧的人工选择立即失效
    setConfirmedSelection(null);
    if (!key) {
      setClassContext({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setClassContext({ status: 'checking' });
    fetchClassContextState({ childId, observedAt, signal: controller.signal })
      .then((state) => {
        if (lookupKeyRef.current !== key) return;
        setClassContext(state);
      })
      .catch((error: unknown) => {
        if (lookupKeyRef.current !== key) return;
        if (isAbortError(error)) return;
        setClassContext({
          status: 'error',
          message: error instanceof Error ? error.message : '核对发生时班级失败，请重试。',
        });
      });
    return () => controller.abort();
  }, [childId, observedAt, lookupNonce]);

  const selectedChild = children.find((c) => c.id === childId) ?? null;
  const needsClassConfirmation = classContext.status === 'needs_confirmation';
  // 提交只携带“当前需要人工确认且绑定当前儿童+日期”的选择
  const boundSelection =
    confirmedSelection &&
    confirmedSelection.child_id === childId &&
    confirmedSelection.observed_at === observedAt
      ? confirmedSelection
      : null;

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
    if (needsClassConfirmation && !boundSelection) {
      toast.error('请选择这条观察发生时的班级');
      return;
    }
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
          ...(boundSelection ? { confirmed_class_id: boundSelection.class_id } : {}),
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
        }
        throw new Error(
          typeof data.message === 'string' && data.message ? data.message : '保存失败，请稍后再试',
        );
      }
      toast.success('观察已保存，原文将不可修改');
      router.push(`/observations/${data.observation.id}/review`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败，请稍后再试');
      setSubmitting(false);
    }
  }

  if (authLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (!configured || !isTeacher) {
    return (
      <div className="mx-auto max-w-lg py-10">
        <Alert>
          <LogIn className="size-4" />
          <AlertTitle>需要教师身份</AlertTitle>
          <AlertDescription>
            录入观察属于写操作，需教师身份验证。请点击右上角「教师登录」输入通行口令后再来。
            访客模式可浏览档案与已归档记录。
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!loadingChildren && children.length === 0) {
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
      </div>

      <Card className="border-emerald-200/80">
        <CardHeader>
          <CardTitle className="text-base">观察信息</CardTitle>
          <CardDescription>带 * 为必填</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="child">幼儿 *</Label>
              <Select value={childId} onValueChange={setChildId}>
                <SelectTrigger id="child" className="w-full">
                  <SelectValue
                    placeholder={loadingChildren ? '加载中…' : '选择幼儿'}
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
                      className="min-h-9"
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
              <div className="space-y-2 rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-3">
                <p className="text-xs leading-5 text-rose-800">{classContext.message}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-9"
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
            className="w-full"
            onClick={() => void handleSubmit()}
            disabled={submitting || loadingChildren || classContext.status === 'checking'}
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            保存观察并继续整理
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
