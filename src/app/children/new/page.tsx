'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { Textarea } from '@/components/ui/textarea';
import { useTeacher } from '@/components/teacher-provider';
import { ageText, formatDateCn } from '@/lib/format';
import type { Child } from '@/lib/types';
import { cn } from '@/lib/utils';
import { createChildSchema } from '@/lib/validation';

type FieldKey =
  | 'name'
  | 'gender'
  | 'birth_date'
  | 'class_name'
  | 'avatar_emoji'
  | 'note';

type FieldErrors = Partial<Record<FieldKey, string>>;

interface FormState {
  name: string;
  gender: string;
  birth_date: string;
  class_name: string;
  avatar_emoji: string;
  note: string;
}

const STEPS = ['基本信息', '可选补充', '提交确认'] as const;

const STEP_HINTS = [
  '姓名、性别、出生日期为必填项。',
  '班级默认「向日葵班」，头像与备注可以留空。',
  '确认信息无误后建档，随后直接录入第一次观察。',
] as const;

const STEP_FIELDS: readonly FieldKey[][] = [
  ['name', 'gender', 'birth_date'],
  ['class_name', 'avatar_emoji', 'note'],
  ['name', 'gender', 'birth_date', 'class_name', 'avatar_emoji', 'note'],
];

const GENDERS = ['男', '女', '其他'] as const;
const EMOJI_PRESETS = ['🧒', '👦', '👧', '🐣', '🌻', '⭐'];

/** 统一清洗输入：去首尾空格，班级留空回退默认值 */
function normalize(form: FormState): FormState {
  return {
    ...form,
    name: form.name.trim(),
    class_name: form.class_name.trim() || '向日葵班',
    avatar_emoji: form.avatar_emoji.trim(),
    note: form.note.trim(),
  };
}

/** 复用服务端同一份 createChildSchema，只保留当前步骤字段的错误 */
function collectErrors(form: FormState, fields: readonly FieldKey[]): FieldErrors {
  const errors: FieldErrors = {};
  const parsed = createChildSchema.safeParse(normalize(form));
  if (parsed.success) return errors;
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
  return errors;
}

function ErrorText({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-sm text-destructive">{message}</p>;
}

export default function NewChildPage() {
  const router = useRouter();
  const { loading: authLoading, configured, isTeacher } = useTeacher();

  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>({
    name: '',
    gender: '',
    birth_date: '',
    class_name: '向日葵班',
    avatar_emoji: '',
    note: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  function setField<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
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
      const res = await fetch('/api/children', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: payload.name,
          gender: payload.gender,
          birth_date: payload.birth_date,
          class_name: payload.class_name,
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
      router.push(
        `/observations/new?child_id=${encodeURIComponent(data.child.id)}`,
      );
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

  if (!configured || !isTeacher) {
    return (
      <div className="mx-auto max-w-lg py-10">
        <Alert>
          <LogIn className="size-4" />
          <AlertTitle>需要教师登录</AlertTitle>
          <AlertDescription>
            建立成长档案属于写操作，需教师身份验证。请点击右上角「教师登录」输入通行口令后再来。
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const preview = normalize(form);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <UserPlus className="size-5 text-amber-600" />
          建立成长档案
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          分三步完成基本信息、可选补充和确认，随后即可记录第一次观察。
        </p>
      </div>

      <ol className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {STEPS.map((label, index) => {
          const done = index < step;
          const active = index === step;
          return (
            <li key={label} className="flex items-center gap-2">
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium',
                  done
                    ? 'bg-emerald-100 text-emerald-700'
                    : active
                      ? 'bg-amber-500 text-white'
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
                      : 'text-slate-400',
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
          <CardDescription>{STEP_HINTS[step]}</CardDescription>
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
                      className="flex cursor-pointer items-center gap-2 text-sm"
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
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="class-name">班级</Label>
                <Input
                  id="class-name"
                  placeholder="向日葵班"
                  maxLength={50}
                  value={form.class_name}
                  onChange={(e) => setField('class_name', e.target.value)}
                />
                <p className="text-xs text-slate-400">
                  留空将自动使用默认班级「向日葵班」。
                </p>
                <ErrorText message={errors.class_name} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="avatar-emoji">头像 Emoji（选填）</Label>
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
                        'flex size-9 items-center justify-center rounded-full border text-lg transition-colors',
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
                    <Badge variant="secondary">{preview.class_name}</Badge>
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
                建档成功后将直接进入该幼儿的观察录入页；观察原文保存后不可修改。
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
                {submitting ? '正在建立…' : '建立成长档案并记录观察'}
          </Button>
        )}
      </div>
    </div>
  );
}
