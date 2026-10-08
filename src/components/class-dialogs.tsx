'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil, Plus, Repeat2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useTeacher } from '@/components/teacher-provider';
import { fetchWithAccountAuth } from "@/lib/accounts/client";
import { classLabel } from '@/lib/format';
import { CLASS_STAGES, CLASS_STAGE_LABELS, type Child, type SchoolClass } from '@/lib/types';
import { createClassSchema } from '@/lib/validation';

type FieldKey = 'name' | 'stage' | 'school_year' | 'is_active';
type FieldErrors = Partial<Record<FieldKey, string>>;

function ErrorText({ message }: { message?: string }) {
  if (!message) return null;
  return <p role="alert" className="text-base leading-7 text-destructive">{message}</p>;
}

/** 默认学年：8 月及以后为当年学年，否则为上一学年 */
function defaultSchoolYear(): string {
  const d = new Date();
  const year = d.getFullYear();
  return d.getMonth() + 1 >= 8 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

/**
 * 新建 / 编辑 / 停用班级（需教师身份）。
 * 不传 klass 为新建；传 klass 时可改名称、学段、学年与启用状态。
 */
export function ClassFormDialog({
  klass,
  label,
  variant = 'outline',
  size = 'sm',
}: {
  klass?: SchoolClass;
  label: string;
  variant?: 'default' | 'outline';
  size?: 'sm' | 'default';
}) {
  const router = useRouter();
  const { loading, configured, canManageClasses } = useTeacher();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [stage, setStage] = useState<string>('small');
  const [schoolYear, setSchoolYear] = useState('');
  const [active, setActive] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  // 已有分班或观察记录的班级不能直接改学段/学年（升班需新建班级并转班）
  const [hasHistory, setHasHistory] = useState(false);

  const locked = loading || !configured || !canManageClasses;

  function handleOpen(next: boolean) {
    if (next) {
      setName(klass?.name ?? '');
      setStage(klass?.stage ?? 'small');
      setSchoolYear(klass?.school_year ?? defaultSchoolYear());
      setActive(klass?.is_active ?? true);
      setErrors({});
      setHasHistory(false);
      if (klass) {
        fetch(`/api/classes/${klass.id}`)
          .then((r) => r.json())
          .then(
            (data: {
              history?: { enrollment_count?: number; observation_count?: number };
            }) => {
              const history = data.history;
              setHasHistory(
                Boolean(
                  history &&
                    ((history.enrollment_count ?? 0) > 0 ||
                      (history.observation_count ?? 0) > 0),
                ),
              );
            },
          )
          .catch(() => undefined);
      }
    }
    setOpen(next);
  }

  async function handleSubmit() {
    if (busy) return;
    const parsed = createClassSchema.safeParse({
      name: name.trim(),
      stage,
      school_year: schoolYear.trim(),
      is_active: active,
    });
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === 'string' && !(key in next)) {
          next[key as FieldKey] = issue.message;
        }
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const res = await fetchWithAccountAuth(klass ? `/api/classes/${klass.id}` : '/api/classes', {
        method: klass ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(data.message ?? '保存失败，请稍后再试');
      toast.success(
        klass ? `班级「${parsed.data.name}」已更新` : `已创建班级「${parsed.data.name}」`,
      );
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button
          variant={variant}
          size={size}
          disabled={locked}
          title={locked ? '管理班级需要园所账号登录' : undefined}
          className="min-h-11"
        >
          {klass ? <Pencil className="size-4" /> : <Plus className="size-4" />}
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{klass ? '编辑班级' : '新建班级'}</DialogTitle>
          <DialogDescription>
            班级是组织上下文：分班、观察与档案都会记录班级语境。停用班级只影响新分班，历史记录不受影响。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="class-name">班级名称 *</Label>
            <Input
              id="class-name"
              placeholder="如：向日葵班"
              maxLength={50}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <ErrorText message={errors.name} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="class-stage">学段 *</Label>
            <Select value={stage} onValueChange={setStage} disabled={hasHistory}>
              <SelectTrigger id="class-stage" className="w-full">
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
            <ErrorText message={errors.stage} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="school-year">学年 *</Label>
            <Input
              id="school-year"
              placeholder="如：2026-2027"
              maxLength={20}
              value={schoolYear}
              onChange={(e) => setSchoolYear(e.target.value)}
              disabled={hasHistory}
            />
            <ErrorText message={errors.school_year} />
            {hasHistory ? (
              <p className="text-xs leading-5 text-amber-700">
                该班级已有分班或观察记录。升班请建立新学年的班级并转班；这里仍可修改班级名称或停用班级。
              </p>
            ) : null}
          </div>

          <label htmlFor="class-active" className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg border bg-slate-50/70 px-3 py-2.5">
            <div>
              <span className="text-sm font-medium">
                启用班级
              </span>
              <p className="mt-0.5 text-xs text-slate-500">
                停用后不能再新分班，已有儿童与观察保持不变。
              </p>
            </div>
            <Switch id="class-active" checked={active} onCheckedChange={setActive} />
          </label>
          <ErrorText message={errors.is_active} />
        </div>

        <DialogFooter>
          <Button onClick={() => void handleSubmit()} disabled={busy} className="min-h-11">
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {klass ? '保存修改' : '创建班级'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 儿童转班：选择一个启用中的其他班级，写入新的在班归属并结束旧归属。
 * ponytail: 分班日期默认当天，需要补录历史日期时再加日期选择
 */
export function TransferClassDialog({
  child,
  classes,
}: {
  child: Child;
  classes: SchoolClass[];
}) {
  const router = useRouter();
  const { loading, configured, canManageClasses } = useTeacher();
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);

  const options = classes.filter((c) => c.is_active && c.id !== child.class_id);
  const locked = loading || !configured || !canManageClasses || options.length === 0;
  const target = options.find((c) => c.id === targetId) ?? null;

  function handleOpen(next: boolean) {
    if (next) {
      setTargetId('');
    }
    setOpen(next);
  }

  async function handleSubmit() {
    if (busy || !target) {
      if (!target) toast.error('请选择要转入的班级');
      return;
    }
    setBusy(true);
    try {
      const res = await fetchWithAccountAuth(`/api/classes/${target.id}/children`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ child_id: child.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(data.message ?? '转班失败，请稍后再试');
      toast.success(data.message ?? `已转入「${target.name}」`);
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '转班失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  if (options.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={locked}
          title={locked ? '转班需要园所账号登录' : undefined}
          className="min-h-11"
        >
          <Repeat2 className="size-4" />
          转班
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>为 {child.name} 转班</DialogTitle>
          <DialogDescription>
            转班只改变当前归属：旧的分班关系保留为历史，已保存的观察仍显示当时的班级语境。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="transfer-class">转入班级 *</Label>
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger id="transfer-class" className="w-full">
                <SelectValue placeholder="选择班级" />
              </SelectTrigger>
              <SelectContent>
                {options.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {classLabel(c.stage, c.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border bg-slate-50/70 px-3 py-2.5 text-xs leading-5 text-slate-500">
            当前班级：
            {classLabel(child.class_stage, child.class_name) ?? '未分班'} · 分班日期默认为今天。
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => void handleSubmit()} disabled={busy || !target} className="min-h-11">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Repeat2 className="size-4" />}
            确认转班
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
