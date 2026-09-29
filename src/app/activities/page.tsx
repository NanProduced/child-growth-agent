import { BookOpenCheck, Construction } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export const metadata = {
  title: '活动计划',
};

export default function ActivitiesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">活动计划</h1>
        <p className="mt-1 text-sm text-slate-600">
          基于已确认的观察记录生成活动建议，教师筛选后纳入班级周计划。
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpenCheck className="size-5 text-amber-600" />
            下一阶段上线
          </CardTitle>
          <CardDescription className="flex items-start gap-2">
            <Construction className="mt-0.5 size-4 shrink-0" />
            第一阶段聚焦「观察录入 → AI 整理 → 教师确认」主链路；活动计划与个体/集体活动建议将在
            第二阶段开放，敬请期待。
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-slate-500">
          计划中的能力：从已确认观察自动汇总发展要点 → 按五大领域生成活动建议草稿 → 教师筛选、
          调整并发布 → 实施后回到观察记录形成闭环。
        </CardContent>
      </Card>
    </div>
  );
}
