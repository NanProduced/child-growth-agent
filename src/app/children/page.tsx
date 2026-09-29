import type { Metadata } from 'next';
import Link from 'next/link';
import { Baby, ChevronRight, ClipboardList } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
      <div>
        <h1 className="text-xl font-bold">幼儿档案</h1>
        <p className="mt-1 text-sm text-slate-600">
          班级幼儿一览。演示档案为合成数据；教师登录后可在后续版本中新增与维护档案。
        </p>
      </div>

      {dbError ? (
        <Alert variant="destructive">
          <AlertTitle>数据库暂不可用</AlertTitle>
          <AlertDescription>{dbError}</AlertDescription>
        </Alert>
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
