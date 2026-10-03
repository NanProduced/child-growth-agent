'use client';

import { useEffect, useState } from 'react';
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
import type { ClassContextConfirmationReason } from '@/lib/class-context';
import { classLabel, parseIsoDateStrict, todayStr } from '@/lib/format';
import type { Child, SchoolClass } from '@/lib/types';

type ClassContextState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'resolved'; class: SchoolClass }
  | { status: 'needs_confirmation'; reason: ClassContextConfirmationReason; message: string };

interface ClassContextResponse {
  status?: 'resolved' | 'needs_confirmation';
  reason?: ClassContextConfirmationReason | null;
  message?: string;
  class?: SchoolClass | null;
}

export default function NewObservationPage() {
  const router = useRouter();
  const { loading: authLoading, configured, isTeacher } = useTeacher();
  const [children, setChildren] = useState<Child[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [loadingChildren, setLoadingChildren] = useState(true);

  const [childId, setChildId] = useState('');
  const [observedAt, setObservedAt] = useState('');
  const [context, setContext] = useState('');
  const [rawText, setRawText] = useState('');
  const [classContext, setClassContext] = useState<ClassContextState>({ status: 'idle' });
  const [confirmedClassId, setConfirmedClassId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 默认日期仅客户端挂载后写入，保证服务端渲染与水合一致
  useEffect(() => {
    setObservedAt(todayStr());
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

  // 教师确认“当时班级”时的候选列表：包含已停用班级（历史班级可能已停用）
  useEffect(() => {
    let alive = true;
    fetch('/api/classes')
      .then((r) => r.json())
      .then((data: { classes?: SchoolClass[] }) => {
        if (alive) setClasses(data.classes ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // 幼儿或日期变化时，按分班历史核对发生班级；不可靠时要求教师确认，不默认套用当前班级
  useEffect(() => {
    if (!childId || !observedAt || !parseIsoDateStrict(observedAt)) {
      setClassContext({ status: 'idle' });
      setConfirmedClassId('');
      return;
    }
    const controller = new AbortController();
    setClassContext({ status: 'checking' });
    setConfirmedClassId('');
    fetch(
      `/api/children/${childId}/class-context?observed_at=${encodeURIComponent(observedAt)}`,
      { signal: controller.signal }
    )
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as ClassContextResponse;
        if (!res.ok) throw new Error(data.message ?? '核对发生时班级失败');
        if (data.status === 'resolved' && data.class) {
          setClassContext({ status: 'resolved', class: data.class });
          return;
        }
        setClassContext({
          status: 'needs_confirmation',
          reason: data.reason ?? 'no_attribution',
          message: data.message ?? '无法自动确定这条观察发生时的班级，请选择。',
        });
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setClassContext({ status: 'idle' });
        toast.error(e instanceof Error ? e.message : '核对发生时班级失败');
      });
    return () => controller.abort();
  }, [childId, observedAt]);

  const selectedChild = children.find((c) => c.id === childId) ?? null;
  const needsClassConfirmation = classContext.status === 'needs_confirmation';

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
    if (needsClassConfirmation && !confirmedClassId) {
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
          ...(confirmedClassId ? { confirmed_class_id: confirmedClassId } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as ClassContextResponse & {
        error?: string;
        observation?: { id: string };
      };
      if (!res.ok || !data.observation) {
        if (data.error === 'class_context_confirmation_required') {
          setClassContext({
            status: 'needs_confirmation',
            reason: data.reason ?? 'no_attribution',
            message: data.message ?? '无法自动确定这条观察发生时的班级，请选择。',
          });
          setConfirmedClassId('');
        }
        throw new Error(data.message ?? '保存失败，请稍后再试');
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
                <div className="space-y-1.5">
                  <Label htmlFor="class-context">当时所在班级 *</Label>
                  <Select value={confirmedClassId} onValueChange={setConfirmedClassId}>
                    <SelectTrigger id="class-context" className="w-full">
                      <SelectValue placeholder="选择当时所在班级" />
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
                </div>
                <p className="text-xs leading-5 text-amber-800/80">
                  只用于记录这条观察的班级语境，不会改变幼儿当前分班。
                </p>
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
