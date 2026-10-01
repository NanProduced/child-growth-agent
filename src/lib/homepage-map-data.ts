import { classLabel, excerpt } from '@/lib/format';
import type { Child, Observation, SchoolClass } from '@/lib/types';

type MapChild = Pick<Child, 'id' | 'name' | 'class_id'>;
type MapObservation = Pick<Observation, 'id' | 'child_id' | 'class_id' | 'observed_class' | 'observed_at' | 'created_at' | 'context' | 'raw_text' | 'status'>;

export function buildHomepageMapData(classes: SchoolClass[], children: MapChild[], observations: MapObservation[]) {
  const activeClasses = classes.filter((klass) => klass.is_active);
  const childrenById = new Map(children.map((child) => [child.id, child]));
  const recent = [...observations].sort((a, b) => b.observed_at.localeCompare(a.observed_at) || b.created_at.localeCompare(a.created_at));
  const rank = { ai_organized: 0, needs_input: 1, draft: 2, confirmed: 3 };
  const pending = recent.filter((observation) => observation.status !== 'confirmed')
    .sort((a, b) => rank[a.status] - rank[b.status] || b.created_at.localeCompare(a.created_at));
  const confirmationCount = observations.filter((observation) => observation.status === 'ai_organized').length;

  function observationSummary(observation: MapObservation) {
    return {
      id: observation.id,
      childId: observation.child_id,
      childName: childrenById.get(observation.child_id)?.name ?? '成长档案暂不可用',
      hasChild: childrenById.has(observation.child_id),
      className: classLabel(observation.observed_class?.stage, observation.observed_class?.name),
      stage: observation.observed_class?.stage ?? null,
      date: observation.observed_at,
      context: observation.context,
      text: excerpt(observation.raw_text, 100),
      status: observation.status,
    };
  }

  const classOverviews = activeClasses
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || b.school_year.localeCompare(a.school_year))
    .map((klass) => {
      // 观察按发生时班级快照归属；转班不把旧观察挪到当前班级。
      const classObservations = recent.filter((observation) => observation.class_id === klass.id);
      const classChildren = children.filter((child) => child.class_id === klass.id).map(({ id, name }) => ({ id, name }));
      return {
        id: klass.id, name: klass.name, stage: klass.stage, schoolYear: klass.school_year,
        children: classChildren,
        pendingCount: classObservations.filter((observation) => observation.status !== 'confirmed').length,
        confirmationCount: classObservations.filter((observation) => observation.status === 'ai_organized').length,
        confirmationId: classObservations.find((observation) => observation.status === 'ai_organized')?.id ?? null,
        latest: classObservations[0] ? observationSummary(classObservations[0]) : null,
      };
    });

  const primaryAction = confirmationCount > 0
    ? { label: '去处理待确认', href: '/observations?status=ai_organized', helper: '整理好的观察，等你核对。' }
    : pending.some((observation) => observation.status === 'needs_input')
      ? { label: '补充一条观察', href: '/observations?status=needs_input', helper: '补充一点信息，让观察更清楚。' }
      : activeClasses.length === 0
        ? { label: '建立第一个班级', href: '/classes', helper: '从建立一个具体班级开始。' }
        : children.length === 0
          ? { label: '建立第一个成长档案', href: '/children/new', helper: '先为幼儿建立一份成长档案。' }
          : { label: '开始记录', href: '/observations/new', helper: '记下看到的具体行为和语言。' };

  return {
    classes: classOverviews, childCount: children.length, confirmationCount,
    pendingCount: pending.length, pending: pending.slice(0, 3).map(observationSummary),
    recent: recent.slice(0, 3).map(observationSummary), primaryAction,
  };
}

export type HomepageMapData = ReturnType<typeof buildHomepageMapData>;
export type HomepageClass = HomepageMapData['classes'][number];
export type HomepageObservation = HomepageMapData['recent'][number];
