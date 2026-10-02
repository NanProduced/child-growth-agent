'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import localFont from 'next/font/local';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, ClipboardCheck, Flower2, Leaf, PenLine, Sprout } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/status-badges';
import { classLabel, excerpt, formatDateCn } from '@/lib/format';
import type { HomepageClass, HomepageMapData, HomepageObservation } from '@/lib/homepage-map-data';
import { CLASS_STAGES, CLASS_STAGE_LABELS, type ClassStage } from '@/lib/types';
import styles from './homepage-map.module.css';

const displayFont = localFont({
  src: '../../public/assets/fonts/yaya-display-subset.ttf',
  variable: '--font-garden-display',
  display: 'swap',
  preload: true,
});

const stageDetails = {
  small: { description: '在游戏中探索世界，在陪伴中慢慢成长。', image: '/assets/illustrations/map-small-v2.png' },
  middle: { description: '在探索中主动提问，在合作中学会表达。', image: '/assets/illustrations/map-middle-v2.png' },
  large: { description: '看见新的尝试，留下自己的发现。', image: '/assets/illustrations/map-large-v2.png' },
};

function StagePortrait({ stage, className = '' }: { stage: ClassStage; className?: string }) {
  return <Image src={stageDetails[stage].image} alt="" width={180} height={180} sizes="(max-width: 1023px) 135px, 100px" className={`${styles['portrait']} ${className}`} />;
}

function ObservationLink({ observation, compact = false }: { observation: HomepageObservation; compact?: boolean }) {
  return (
    <Link href={`/observations/${observation.id}/review`} className={styles['observation-link']}>
      <span className={styles['observation-meta']}>
        <strong>{observation.childName}</strong><StatusBadge status={observation.status} compact />
      </span>
      <span className={styles['observation-text']}>{excerpt(observation.text, compact ? 48 : 76)}</span>
      <span className={styles['observation-date']}>{formatDateCn(observation.date)}{observation.context ? ` · ${observation.context}` : ''}</span>
      <ChevronRight className={styles['row-arrow']} size={18} aria-hidden="true" />
    </Link>
  );
}

function ClassDetail({ klass, onBack }: { klass: HomepageClass; onBack: () => void }) {
  const [recordChildId, setRecordChildId] = useState('');
  const detailRef = useRef<HTMLElement>(null);
  const childId = klass.children.length === 1 ? klass.children[0].id : recordChildId;

  useEffect(() => { detailRef.current?.focus(); }, []);

  return (
    <section ref={detailRef} tabIndex={-1} className={styles['class-detail']} aria-labelledby={`detail-${klass.id}`}>
      <div className={styles['detail-heading']}>
        <Flower2 size={28} aria-hidden="true" />
        <div><h3 id={`detail-${klass.id}`}>{classLabel(klass.stage, klass.name)}</h3><p>{klass.schoolYear}学年 · <Check size={12} aria-hidden="true" />已选中</p></div>
        <Button variant="ghost" size="sm" onClick={onBack} className={styles['back-list']}><ArrowLeft size={15} />班级列表</Button>
      </div>
      <div className={styles['class-facts']}>
        <span><BookOpen size={17} aria-hidden="true" /><strong>{klass.children.length}</strong> 份成长档案</span>
        <span className={klass.confirmationCount > 0 ? styles['pending-mark'] : styles['quiet-status']}>
          <Leaf size={17} aria-hidden="true" />{klass.pendingCount} 条待处理{klass.confirmationCount > 0 ? ` · ${klass.confirmationCount}条待确认` : ' · 暂无待确认'}
        </span>
      </div>
      <div className={styles['latest']}>
        <h4>最近观察</h4>
        {klass.latest ? <Link href={`/observations/${klass.latest.id}/review`} className={styles['latest-summary']}>
          <StagePortrait stage={klass.latest.stage ?? klass.stage} className={styles['latest-portrait']} />
          <span><strong>{klass.latest.childName}<StatusBadge status={klass.latest.status} compact /></strong><span className={styles['latest-quote']}>{excerpt(klass.latest.text, 42)}</span><time dateTime={klass.latest.date}>{formatDateCn(klass.latest.date)}</time></span>
          <ChevronRight size={17} aria-hidden="true" />
        </Link> : <p className={styles['empty']}>这个班级还没有观察记录，从一件小事开始。</p>}
      </div>
      <div className={styles['detail-actions']}>
        <Button asChild variant="outline"><Link href={`/classes/${klass.id}`}>查看班级<ArrowRight size={16} /></Link></Button>
        {klass.confirmationId ? <Button asChild className={styles['confirm-action']}><Link href={`/observations/${klass.confirmationId}/review`}>去确认<ArrowRight size={16} /></Link></Button> : null}
      </div>
      {klass.children.length > 0 ? (
        <div className={styles['record-row']}>
          {klass.children.length > 1 ? <details className={styles['record-picker']}><summary><PenLine size={15} />记录一次观察<ChevronDown size={14} /></summary>
            <div className={styles['record-picker-body']}><label className={styles['child-picker']}><span>记录对象</span>
              <select value={recordChildId} onChange={(event) => setRecordChildId(event.target.value)}>
                <option value="">选择一位幼儿</option>
                {klass.children.map((child) => <option key={child.id} value={child.id}>{child.name}</option>)}
              </select>
            </label>{childId ? <Button asChild variant="outline"><Link href={`/observations/new?child_id=${encodeURIComponent(childId)}`}>开始记录<ArrowRight size={15} /></Link></Button> : <Button disabled variant="outline">选择幼儿后开始记录</Button>}</div>
          </details> : <Button asChild variant="outline"><Link href={`/observations/new?child_id=${encodeURIComponent(childId)}`}><PenLine size={15} />记录一次观察</Link></Button>}
          <Link href={`/children?class=${encodeURIComponent(klass.id)}`} className={styles['profile-link']}>查看成长档案<ArrowRight size={14} /></Link>
        </div>
      ) : <p className={styles['empty']}>这个班级还没有成长档案。<Link href="/children/new" className={styles['text-link']}>建立成长档案<ArrowRight size={15} /></Link></p>}
      {klass.children.length === 0 ? <Link href={`/children?class=${encodeURIComponent(klass.id)}`} className={styles['profile-link']}>查看成长档案<ArrowRight size={14} /></Link> : null}
    </section>
  );
}

export function HomepageMap({ data }: { data: HomepageMapData }) {
  const [selectedStage, setSelectedStage] = useState<ClassStage | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const selectedClass = data.classes.find((klass) => klass.id === selectedClassId);
  const classConfirmation = selectedClass?.confirmationId;
  const firstConfirmation = data.pending.find((observation) => observation.status === 'ai_organized');

  useEffect(() => {
    if (selectedStage && !selectedClassId) document.getElementById(`stage-trigger-${selectedStage}`)?.focus();
  }, [selectedStage, selectedClassId]);

  function resetSelection() { setSelectedStage(null); setSelectedClassId(null); }
  function toggleStage(stage: ClassStage) { setSelectedStage(selectedStage === stage ? null : stage); setSelectedClassId(null); }
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || !selectedStage) return;
    event.preventDefault();
    if (selectedClassId) setSelectedClassId(null); else resetSelection();
    document.getElementById(`stage-trigger-${selectedStage}`)?.focus();
  }

  return (
    <div className={`${styles['homepage']} ${displayFont.variable}`}>
      <section className={styles['scene']} aria-label="全园成长地图" data-selected-stage={selectedStage ?? ''} onKeyDown={handleKeyDown}>
        <div className={styles['canvas']}>
          <div className={styles['art']} aria-hidden="true" />
          <div className={styles['heading']}>
            <h1><span>看见每一个</span><span>正在生长的幼儿</span></h1>
            <p>在真实的日常里，记录每一次发现，<br />也看见我们一起成长的幼儿园。</p>
          </div>
          <svg className={styles['paths']} viewBox="0 0 1774 887" aria-hidden="true">
            <path data-path="small" d="M35 520 C10 310 225 265 450 305 C715 355 680 625 475 715 C260 800 55 740 35 520Z" />
            <path data-path="middle" d="M1195 345 C1140 200 1390 140 1625 185 C1800 235 1830 480 1660 510 C1440 565 1230 490 1195 345Z" />
            <path data-path="large" d="M1265 670 C1190 530 1470 440 1670 490 C1810 540 1840 785 1640 825 C1450 865 1315 800 1265 670Z" />
          </svg>
          <div className={styles['central-action']}>
            <div className={styles['action-heading']}>
              <Image src="/assets/illustrations/observation-notebook.png" alt="" width={64} height={64} sizes="64px" />
              <div><h2>今天要看一眼</h2><p>{classConfirmation ? `${excerpt(selectedClass.name, 8)} · ${selectedClass.confirmationCount}条待确认` : data.primaryAction.helper}</p></div>
            </div>
            <div className={styles['primary-actions']}>
              <Button asChild size="lg" className={styles['primary-button']}>
                <Link href={classConfirmation ? `/observations/${classConfirmation}/review` : data.primaryAction.href}>
                  {classConfirmation || data.confirmationCount > 0 ? <ClipboardCheck size={22} /> : <Sprout size={24} />}
                  {classConfirmation ? '去确认' : data.primaryAction.label}<ArrowRight size={23} />
                </Link>
              </Button>
              {(data.confirmationCount > 0 || data.primaryAction.label === '补充一条观察') && data.childCount > 0 ? <Link href="/observations/new" className={styles['secondary-record']}><PenLine size={15} />开始记录</Link> : <Link href="/children" className={styles['secondary-record']}><BookOpen size={15} />查看成长档案</Link>}
            </div>
          </div>
          <div className={styles['school-summary']}>
            <span className={styles['school-thumbnail']} aria-hidden="true" />
            <div><strong>全园</strong><span className={styles['school-facts']}><span>{data.classes.length} 个班级</span><span>{data.childCount} 份成长档案</span></span></div>
            {selectedStage ? <Button variant="ghost" onClick={resetSelection} className={styles['return-school']}><ArrowLeft size={15} />返回全园</Button> : <Link href="/classes" className={styles['summary-link']}>查看全园班级<ChevronRight size={16} /></Link>}
          </div>
          <div className={styles['stages']}>
            {CLASS_STAGES.map((stage) => {
              const classes = data.classes.filter((klass) => klass.stage === stage);
              const expanded = selectedStage === stage;
              const selected = expanded && selectedClassId !== null;
              const childCount = classes.reduce((sum, klass) => sum + klass.children.length, 0);
              const confirmationCount = classes.reduce((sum, klass) => sum + klass.confirmationCount, 0);
              return (
                <section key={stage} className={styles['stage']} data-stage={stage} data-expanded={expanded} data-selected-class={selected}>
                  <h2 className={styles['stage-heading']}>
                    <button id={`stage-trigger-${stage}`} type="button" className={styles['stage-trigger']} onClick={() => toggleStage(stage)} aria-label={`${CLASS_STAGE_LABELS[stage]}，${expanded ? '收起班级' : '查看班级'}，${classes.length}个班级，${childCount}份成长档案${confirmationCount > 0 ? `，${confirmationCount}条待确认` : ''}`} aria-expanded={expanded} aria-controls={`stage-panel-${stage}`}>
                      <StagePortrait stage={stage} className={styles['stage-portrait']} />
                      <Flower2 className={styles['stage-flower']} size={32} aria-hidden="true" />
                      <span className={styles['stage-copy']}>
                        <strong>{CLASS_STAGE_LABELS[stage]}{expanded ? <span className={styles['selected-label']}><Check size={13} aria-hidden="true" />已展开</span> : null}</strong>
                        <span>{classes.length} 个班级 · {childCount} 份成长档案</span>
                        {!expanded ? <span className={styles['stage-description']}>{stageDetails[stage].description}</span> : null}
                        {confirmationCount > 0 && !selected ? <span className={styles['pending-mark']}><Leaf size={14} aria-hidden="true" />{confirmationCount}条待确认</span> : null}
                        <span className={styles['stage-affordance']}>{expanded ? '收起班级' : '查看班级'}<ChevronDown className={styles['stage-chevron']} size={17} aria-hidden="true" /></span>
                      </span>
                    </button>
                  </h2>
                  <div id={`stage-panel-${stage}`} className={styles['stage-panel']} hidden={!expanded}>
                    {expanded && !selected ? <section className={styles['class-list']} aria-label={`${CLASS_STAGE_LABELS[stage]}具体班级`}>
                      {classes.length > 0 ? <ul>
                        {classes.map((klass) => <li key={klass.id}>
                          <button className={styles['class-node']} type="button" aria-pressed={selectedClassId === klass.id} aria-controls={`class-detail-${stage}`} onClick={() => setSelectedClassId(klass.id)}>
                            <StagePortrait stage={stage} className={styles['node-portrait']} />
                            <span className={styles['node-copy']}><strong>{klass.name}</strong>
                              <span>{klass.children.length} 份成长档案 · {klass.schoolYear}</span>
                              <span>{klass.confirmationCount > 0 ? `${klass.confirmationCount}条待确认` : klass.pendingCount > 0 ? `${klass.pendingCount} 条待处理` : klass.latest ? `最近 ${formatDateCn(klass.latest.date)}` : '还没有观察记录'}</span>
                            </span><ChevronRight size={18} aria-hidden="true" />
                          </button>
                        </li>)}
                      </ul> : <p className={styles['empty']}>这个学段还没有启用班级。<Link href="/classes" className={styles['text-link']}>建立班级<ArrowRight size={15} /></Link></p>}
                    </section> : null}
                    <div id={`class-detail-${stage}`} aria-live="polite">
                      {selected && selectedClass?.stage === stage ? <ClassDetail key={selectedClass.id} klass={selectedClass} onBack={() => setSelectedClassId(null)} /> : selected ? <div className={styles['empty-selection']}><p>当前班级暂不可用，请重新选择。</p><Button variant="outline" onClick={() => setSelectedClassId(null)}>班级列表</Button></div> : null}
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </section>
      <div className={styles['observation-band']}>
        {data.classes.length === 0 || data.childCount === 0 ? <p className={styles['empty-guide']}><Sprout size={20} aria-hidden="true" />{data.classes.length === 0 ? '先建立一个班级，再为幼儿建立成长档案。' : '班级已准备好，接下来建立第一份成长档案。'}<Link href={data.primaryAction.href} className={styles['text-link']}>{data.primaryAction.label}<ArrowRight size={16} /></Link></p> : null}
        <section className={styles['pending-section']} aria-labelledby="home-pending-title">
          <Image src="/assets/illustrations/observation-notebook.png" alt="" width={78} height={78} sizes="78px" />
          <div><h2 id="home-pending-title">待确认观察</h2><p>{firstConfirmation ? <>{data.confirmationCount} 条待确认，来自 <strong>{firstConfirmation.childName}</strong>{firstConfirmation.className ? ` · ${firstConfirmation.className}` : ''}</> : data.pendingCount > 0 ? `暂时没有待确认观察，另有 ${data.pendingCount} 条待处理。` : '暂时没有待确认观察，继续看见新的成长。'}</p></div>
          {firstConfirmation ? <Button asChild><Link href={`/observations/${firstConfirmation.id}/review`}>去确认<ArrowRight size={17} /></Link></Button> : <ClipboardCheck size={25} aria-hidden="true" />}
        </section>
        <section className={styles['recent-section']} aria-labelledby="home-recent-title">
          <div className={styles['recent-heading']}><div><h2 id="home-recent-title"><Sprout size={27} aria-hidden="true" />最近观察</h2><p>在一件件小事里，看见真实发生的成长。</p></div><Link href="/observations" className={styles['text-link']}>查看全部记录<ArrowRight size={16} /></Link></div>
          <ol className={styles['timeline']}>
            {data.recent.map((observation) => <li key={observation.id} data-stage={observation.stage ?? 'middle'}>
              <StagePortrait stage={observation.stage ?? 'middle'} className={styles['record-portrait']} />
              <div className={styles['record-content']}>
                <ObservationLink observation={observation} compact />
                {observation.hasChild ? <Link href={`/children/${observation.childId}`} className={styles['profile-link']}>查看成长档案<ArrowRight size={13} /></Link> : null}
              </div>
            </li>)}
            <li className={styles['archive-entry']}><Link href="/children"><Image src="/assets/illustrations/observation-notebook.png" alt="" width={90} height={90} sizes="90px" /><span><strong>成长档案</strong><span>{data.recent.length === 0 ? '还没有观察记录，从一件小事开始。' : '收集幼儿的观察记录，陪伴每一次成长。'}</span></span><ChevronRight size={20} aria-hidden="true" /></Link></li>
          </ol>
          {data.recent.length === 0 ? <p className={styles['empty']}>还没有观察记录。记录幼儿的一次具体行为，让成长有迹可循。</p> : null}
        </section>
      </div>
    </div>
  );
}
