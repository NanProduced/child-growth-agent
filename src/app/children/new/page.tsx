'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  LogIn,
  UserPlus,
} from 'lucide-react';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useTeacher } from '@/components/teacher-provider';
import { authIdentityKey, fetchWithAccountAuth } from "@/lib/accounts/client";
import { ageText, classLabel, formatDateCn } from '@/lib/format';
import { CLASS_STAGES, CLASS_STAGE_LABELS, type Child, type SchoolClass } from '@/lib/types';
import { cn } from '@/lib/utils';
import { createChildSchema } from '@/lib/validation';

type FieldKey =
  | 'name'
  | 'gender'
  | 'birth_date'
  | 'class_id'
  | 'avatar_emoji'
  | 'note';

type FieldErrors = Partial<Record<FieldKey, string>>;

interface FormState {
  name: string;
  gender: string;
  birth_date: string;
  stage: string;
  class_id: string;
  avatar_emoji: string;
  note: string;
}

const STEPS = ['基本信息', '可选补充', '提交确认'] as const;

const STEP_HINTS = [
  '姓名、性别、出生日期与班级为必填项。',
  '头像与备注可以留空。',
  '确认信息后建档，接着可以记录观察。',
] as const;

const STEP_FIELDS: readonly FieldKey[][] = [
  ['name', 'gender', 'birth_date', 'class_id'],
  ['avatar_emoji', 'note'],
  ['name', 'gender', 'birth_date', 'class_id', 'avatar_emoji', 'note'],
];

const GENDERS = ['男', '女', '其他'] as const;
const EMOJI_PRESETS = ['🧒', '👦', '👧', '🐣', '🌻', '⭐'];

const classDirectorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  stage: z.enum(['small', 'middle', 'large']),
  school_year: z.string(),
  is_active: z.boolean(),
});

type ClassOption = Pick<SchoolClass, 'id' | 'name' | 'stage' | 'school_year' | 'is_active'>;

/** Loading failure, denied/lost session, unreadable response and a real empty directory stay distinct. */
type ClassDirectoryState =
  | { status: 'loading' }
  | { status: 'ready'; classes: ClassOption[] }
  | { status: 'login' }
  | { status: 'denied' }
  | { status: 'error'; message: string };

function readClassDirectory(body: unknown): ClassOption[] | null {
  if (!body || typeof body !== 'object' || !('classes' in body) || !Array.isArray(body.classes)) return null;
  const parsed = z.array(classDirectorySchema).safeParse(body.classes);
  return parsed.success ? parsed.data : null;
}

/** 统一清洗输入：去首尾空格；班级必须来自选择，不留默认值 */
function normalize(form: FormState): FormState {
  return {
    ...form,
    name: form.name.trim(),
    avatar_emoji: form.avatar_emoji.trim(),
    note: form.note.trim(),
  };
}

/** 复用服务端同一份 createChildSchema，只保留当前步骤字段的错误 */
function collectErrors(form: FormState, fields: readonly FieldKey[]): FieldErrors {
  const errors: FieldErrors = {};
  const parsed = createChildSchema.safeParse(normalize(form));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (
        typeof key === 'string' &&
        (fields as readonly string[]).includes(key) &&
        !(key in errors)
      ) {
        errors[key as FieldKey] = issue.message;
      }
    }
  }
  // 班级是必填项：对象级 refine 没有字段路径，单独给出明确提示
  if ((fields as readonly string[]).includes('class_id') && !form.class_id) {
    errors.class_id = '请选择班级（先选学段，再选班级）';
  }
  return errors;
}

function ErrorText({ message }: { message?: string }) {
  if (!message) return null;
  return <p role="alert" className="text-base leading-7 text-destructive">{message}</p>;
}

export default function NewChildPage() {
  const router = useRouter();
  const { loading: authLoading, canCreateProfiles, principal, auth, revalidate } = useTeacher();
  const identity = authIdentityKey(auth);
  const directoryGeneration = useRef(0);

  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>({
    name: '',
    gender: '',
    birth_date: '',
    stage: '',
    class_id: '',
    avatar_emoji: '',
    note: '',
  });
  const [directory, setDirectory] = useState<ClassDirectoryState>({ status: 'loading' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const loadDirectory = useCallback(async () => {
    const requestGeneration = ++directoryGeneration.current;
    setDirectory({ status: 'loading' });
    let response: Response;
    try {
      response = await fetchWithAccountAuth('/api/classes');
    } catch {
      if (requestGeneration === directoryGeneration.current) {
        setDirectory({ status: 'error', message: '班级资料暂不可读，请稍后重试。读取失败不代表没有班级。' });
      }
      return;
    }
    if (requestGeneration !== directoryGeneration.current) return;
    if (response.status === 401 || response.status === 403) {
      // A lost session clears the private class projection and asks the provider to re-verify identity.
      setDirectory({ status: response.status === 401 ? 'login' : 'denied' });
      if (response.status === 401) void revalidate();
      return;
    }
    if (!response.ok) {
      setDirectory({ status: 'error', message: '班级资料暂不可读，请稍后重试。读取失败不代表没有班级。' });
      return;
    }
    const body: unknown = await response.json().catch(() => null);
    if (requestGeneration !== directoryGeneration.current) return;
    const classes = readClassDirectory(body);
    if (!classes) {
      setDirectory({ status: 'error', message: '班级资料无法核对，请稍后重新读取。' });
      return;
    }
    setDirectory({ status: 'ready', classes });
  }, [revalidate]);

  useEffect(() => {
    // Identity or scope changed: drop the previous private class projection immediately and
    // ignore any response that started under the old identity (late responses must not restore it).
    directoryGeneration.current += 1;
    setDirectory({ status: 'loading' });
    if (auth.state.kind === 'authenticated' && canCreateProfiles) void loadDirectory();
  }, [identity, canCreateProfiles, auth.state.kind, loadDirectory]);

  const classes = directory.status === 'ready' ? directory.classes : [];
  const isAdmin = principal?.role === 'admin';

  function setField<K extends FieldKey>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  /** 切换学段后清空已选班级，避免跨学段误选 */
  function setStage(value: string) {
    setForm((prev) => ({ ...prev, stage: value, class_id: '' }));
    setErrors((prev) => {
      if (!prev.class_id) return prev;
      const next = { ...prev };
      delete next.class_id;
      return next;
    });
  }

  function goNext() {
    const nextErrors = collectErrors(form, STEP_FIELDS[step]);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function goPrev() {
    setErrors({});
    setStep((s) => Math.max(s - 1, 0));
  }

  async function handleSubmit() {
    if (submitting) return;
    // 提交前完整校验：哪一步有问题就回到哪一步
    for (let i = 0; i < STEPS.length - 1; i += 1) {
      const stepErrors = collectErrors(form, STEP_FIELDS[i]);
      if (Object.keys(stepErrors).length > 0) {
        setErrors(stepErrors);
        setStep(i);
        return;
      }
    }
    setErrors({});
    setSubmitting(true);
    try {
      const payload = normalize(form);
      const res = await fetchWithAccountAuth('/api/children', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: payload.name,
          gender: payload.gender,
          birth_date: payload.birth_date,
          class_id: payload.class_id,
          avatar_emoji: payload.avatar_emoji || undefined,
          note: payload.note || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        child?: Child;
        message?: string;
      };
      if (!res.ok || !data.child) {
        throw new Error(data.message ?? '建档失败，请稍后再试');
      }
      toast.success(`已建立 ${data.child.name} 的成长档案`);
      // 管理员没有教学权限：建档后进入成长档案；教师保持原有“建档后直接记录观察”流程。
      router.push(isAdmin
        ? `/children/${encodeURIComponent(data.child.id)}`
        : `/observations/new?child_id=${encodeURIComponent(data.child.id)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '建档失败，请稍后再试');
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

  if (auth.state.kind === 'unavailable') {
    return (
      <div className="mx-auto max-w-lg py-10">
        <Alert variant="destructive">
          <AlertTitle>账号服务暂时不可用</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              现在无法确认账号权限，暂时不能建档。请稍后重试。
            </p>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => void revalidate()}>
              重新核验
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (auth.state.kind !== 'authenticated') {
    return (
      <div className="mx-auto max-w-lg py-10">
        <Alert>
          <LogIn className="size-4" />
          <AlertTitle>需要园所账号登录</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>请登录园所账号后建立成长档案。</p>
            <Button asChild className="min-h-11">
              <Link href="/login?returnTo=%2Fchildren%2Fnew">园所账号登录</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!canCreateProfiles) {
    return (
      <div className="mx-auto max-w-lg py-10">
        <Alert>
          <LogIn className="size-4" />
          <AlertTitle>尚未分配任教班级</AlertTitle>
          <AlertDescription>
            请联系园所管理员安排任教班级，再为班上的幼儿建档。
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const preview = normalize(form);
  const activeClasses = classes.filter((c) => c.is_active);
  const selectedClass = classes.find((c) => c.id === form.class_id) ?? null;
  const previewClassLabel = selectedClass
    ? classLabel(selectedClass.stage, selectedClass.name)
    : null;

  return (
    <div data-platform-surface="child-new" className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-start gap-2 text-2xl font-semibold">
          <UserPlus className="size-5 text-amber-600" />
          建立成长档案
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {isAdmin
            ? '填写幼儿信息，确认后建立档案。观察由任教教师记录。'
            : '填写幼儿信息，建档后就可以记录观察。'}
        </p>
      </div>

      <ol className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {STEPS.map((label, index) => {
          const done = index < step;
          const active = index === step;
          return (
            <li key={label} aria-current={active ? 'step' : undefined} className="flex items-center gap-2">
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium',
                  done
                    ? 'bg-emerald-100 text-emerald-700'
                    : active
                      ? 'bg-amber-700 text-white'
                      : 'bg-slate-200 text-slate-500',
                )}
              >
                {done ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span
                className={cn(
                  'text-sm',
                  active
                    ? 'font-medium text-slate-900'
                    : done
                      ? 'text-slate-600'
                      : 'text-slate-600',
                )}
              >
                {label}
              </span>
              {index < STEPS.length - 1 ? (
                <span className="h-px w-6 bg-slate-200" />
              ) : null}
            </li>
          );
        })}
      </ol>

      <Card className="border-amber-200/80">
        <CardHeader>
          <CardTitle className="text-base">{STEPS[step]}</CardTitle>
          <CardDescription>{step === 2 && isAdmin ? '请核对姓名、生日和班级。' : STEP_HINTS[step]}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === 0 ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="child-name">姓名 *</Label>
                <Input
                  id="child-name"
                  placeholder="如：小雨"
                  maxLength={50}
                  value={form.name}
                  onChange={(e) => setField('name', e.target.value)}
                />
                <ErrorText message={errors.name} />
              </div>

              <div className="space-y-1.5">
                <Label>性别 *</Label>
                <RadioGroup
                  value={form.gender}
                  onValueChange={(value) => setField('gender', value)}
                  className="flex flex-wrap gap-4"
                >
                  {GENDERS.map((gender) => (
                    <label
                      key={gender}
                      htmlFor={`gender-${gender}`}
                      className="flex min-h-11 min-w-11 cursor-pointer items-center gap-2 text-sm"
                    >
                      <RadioGroupItem id={`gender-${gender}`} value={gender} />
                      {gender}
                    </label>
                  ))}
                </RadioGroup>
                <ErrorText message={errors.gender} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="birth-date">出生日期 *</Label>
                <Input
                  id="birth-date"
                  type="date"
                  value={form.birth_date}
                  onChange={(e) => setField('birth_date', e.target.value)}
                />
                <ErrorText message={errors.birth_date} />
              </div>

              <div className="space-y-1.5">
                <Label>班级 *</Label>
                {directory.status === 'loading' ? (
                  <div className="flex items-center gap-2 text-sm text-slate-400">
                    <Loader2 className="size-4 animate-spin" />
                    班级加载中…
                  </div>
                ) : directory.status === 'login' ? (
                  <div className="rounded-lg border border-dashed p-3 text-sm leading-6 text-slate-500">
                    当前登录已失效，请重新登录后再选择班级。
                    <Button asChild variant="link" size="sm" className="px-1">
                      <Link href="/login?returnTo=%2Fchildren%2Fnew">园所账号登录</Link>
                    </Button>
                  </div>
                ) : directory.status === 'denied' ? (
                  <div className="rounded-lg border border-dashed p-3 text-sm leading-6 text-slate-500">
                    当前账号不能查看班级，请联系园所管理员确认任教安排。
                  </div>
                ) : directory.status === 'error' ? (
                  <div className="rounded-lg border border-dashed p-3 text-sm leading-6 text-slate-500">
                    {directory.message}
                    <Button type="button" variant="link" size="sm" className="px-1" onClick={() => void loadDirectory()}>
                      重新读取班级
                    </Button>
                  </div>
                ) : activeClasses.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-3 text-sm leading-6 text-slate-500">
                    {isAdmin ? '还没有可用班级，请先创建或启用班级。' : '当前没有可用班级，请联系管理员建立或启用班级并分配任教。'}
                    {isAdmin ? (
                      <Button asChild variant="link" size="sm" className="px-1">
                        <Link href="/classes">去创建班级</Link>
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select value={form.stage} onValueChange={setStage}>
                      <SelectTrigger className="w-full" aria-label="选择学段">
                        <SelectValue placeholder="选择学段" />
                      </SelectTrigger>
                      <SelectContent>
                        {CLASS_STAGES.map((value) => (
                          <SelectItem key={value} value={value}>
                            {CLASS_STAGE_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={form.class_id}
                      onValueChange={(value) => setField('class_id', value)}
                      disabled={!form.stage}
                    >
                      <SelectTrigger className="w-full" aria-label="选择班级">
                        <SelectValue
                          placeholder={form.stage ? '选择班级' : '请先选择学段'}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {activeClasses
                          .filter((c) => c.stage === form.stage)
                          .map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <p className="text-xs text-slate-400">
                  先选学段，再选班级。日后转班，原有记录仍保留。
                </p>
                <ErrorText message={errors.class_id} />
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="avatar-emoji">头像图标（选填）</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="avatar-emoji"
                    className="w-28"
                    placeholder="🧒"
                    maxLength={16}
                    value={form.avatar_emoji}
                    onChange={(e) => setField('avatar_emoji', e.target.value)}
                  />
                  {EMOJI_PRESETS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={`选择头像 ${emoji}`}
                      onClick={() => setField('avatar_emoji', emoji)}
                      className={cn(
                        'flex size-11 items-center justify-center rounded-full border text-lg transition-colors motion-reduce:transition-none',
                        form.avatar_emoji === emoji
                          ? 'border-amber-400 bg-amber-100'
                          : 'bg-white hover:bg-slate-100',
                      )}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
                <ErrorText message={errors.avatar_emoji} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="child-note">备注（选填）</Label>
                <Textarea
                  id="child-note"
                  rows={3}
                  placeholder="如：喜欢恐龙、午睡需要安抚巾等"
                  maxLength={2000}
                  value={form.note}
                  onChange={(e) => setField('note', e.target.value)}
                />
                <ErrorText message={errors.note} />
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <div className="flex items-center gap-4 rounded-xl bg-amber-50 p-4">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-white text-3xl shadow-sm">
                  {form.avatar_emoji || '🧒'}
                </span>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {preview.name}
                    <Badge variant="outline" className="font-normal">
                      {preview.gender}
                    </Badge>
                    <Badge variant="secondary">{previewClassLabel ?? '未选择班级'}</Badge>
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    出生 {formatDateCn(form.birth_date)} · 当前{' '}
                    {ageText(form.birth_date)}
                  </p>
                </div>
              </div>

              {form.note ? (
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-slate-500">备注</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                    {form.note}
                  </p>
                </div>
              ) : null}

              <p className="text-xs text-slate-400">
                {isAdmin
                  ? '建档后进入成长档案。'
                  : '建档后进入观察记录页。'}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        {step > 0 ? (
          <Button
            variant="outline"
            onClick={goPrev}
            disabled={submitting}
            className="flex-1 sm:flex-none"
          >
            <ArrowLeft className="size-4" />
            上一步
          </Button>
        ) : null}
        {step < STEPS.length - 1 ? (
          <Button
            onClick={goNext}
            className="ml-auto flex-1 sm:flex-none"
          >
            下一步
            <ArrowRight className="size-4" />
          </Button>
        ) : (
          <Button
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="ml-auto flex-1 sm:flex-none"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
                {submitting ? '正在建立…' : isAdmin ? '建立成长档案' : '建立成长档案并记录观察'}
          </Button>
        )}
      </div>
    </div>
  );
}
