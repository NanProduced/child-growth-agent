import type { Metadata } from 'next';
import Link from 'next/link';
import { Baby, ChevronRight, ClipboardList, UserPlus } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DemoBadge } from '@/components/status-badges';
import { ageText } from '@/lib/format';
import { countObservationsByChild, listChildren } from '@/lib/queries';
import type { Child } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '幼儿档案',
};

export default async function ChildrenPage() {
  let children: Child[] = [];
  let counts: Record<string, number> = {};
  let dbError: string | null = null;
  try {
    [children, counts] = await Promise.all([
      listChildren(),
      countObservationsByChild(),
    ]);
  } catch (e) {
    dbError = e instanceof Error ? e.message : '数据库连接失败';
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">幼儿档案</h1>
          <p className="mt-1 text-sm text-slate-600">
            班级幼儿一览。演示档案为合成数据；教师登录后可新增幼儿档案。
          </p>
        </div>
        <Button asChild className="shrink-0">
          <Link href="/children/new">
            <UserPlus className="size-4" />
            新增幼儿
          </Link>
        </Button>
      </div>

      {dbError ? (
        <Alert variant="destructive">
          <AlertTitle>数据库暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
      ) : children.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-amber-100 text-amber-700">
              <Baby className="size-5" />
            </span>
            <div>
              <h2 className="font-medium">还没有幼儿档案</h2>
              <p className="mt-1 text-sm text-slate-500">
                先建立一个幼儿档案，再开始记录观察。
              </p>
            </div>
            <Button asChild>
              <Link href="/children/new">
                <UserPlus className="size-4" />
                新增幼儿
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {children.map((child) => (
            <Link key={child.id} href={`/children/${child.id}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">{child.avatar_emoji ?? '🧒'}</span>
                    <div className="min-w-0 flex-1">
                      <CardTitle className="flex items-center gap-2 text-base">
                        {child.name}
                        <Badge variant="outline" className="text-xs font-normal">
                          {child.gender}
                        </Badge>
                        {child.is_demo ? <DemoBadge /> : null}
                      </CardTitle>
                      <CardDescription>
                        {child.class_name} · {ageText(child.birth_date)}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {child.note ? (
                    <p className="line-clamp-2 text-sm text-slate-600">{child.note}</p>
                  ) : null}
                  <div className="flex items-center gap-1 text-xs text-amber-700">
                    <ClipboardList className="size-3.5" />
                    观察记录 {counts[child.id] ?? 0} 条
                    <ChevronRight className="size-3.5" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-slate-400">
        <Baby className="size-3.5" />
        幼儿信息仅在本应用内使用，不对外展示；作品演示遵循不出现真实姓名与单位的要求。
      </div>
    </div>
  );
}
