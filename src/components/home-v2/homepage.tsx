import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChevronRight, FilePenLine, FileText, Leaf, NotebookPen, PenLine, Sparkles, Sprout, UserRound, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoginPanel } from "./login-panel";
import type { HomeClassSummary, HomeV2Data } from "@/lib/home-v2/types";
import { evidenceEntryQuery } from "@/lib/guide/navigation";
import styles from "./homepage.module.css";

const SLOGAN = "以三年为序，看见幼儿持续生长。";
const STATUS_LABELS = { draft: "待整理", needs_input: "待补充", ai_organized: "待确认", confirmed: "已确认归档" };

function ClassPending({ klass }: { klass: HomeClassSummary }) {
  const counts = [
    { name: "待确认", value: klass.confirmation_count, style: styles["confirm-count"] },
    { name: "待补充", value: klass.supplement_count, style: styles["supplement-count"] },
    { name: "待整理", value: klass.organize_count, style: styles["organize-count"] },
  ];
  return <div className={styles["class-pending"]}>{counts.map(({ name, value, style }) => value === null
    ? <span key={name} className={styles["unknown-count"]}>{name}未读取</span>
    : value > 0 ? <span key={name} className={style}>{name} {value}</span> : null)}</div>;
}

export function Homepage({ data }: { data: HomeV2Data }) {
  if (data.viewer.kind === "logged_out") return <GuestHomepage />;
  if (data.viewer.kind === "identity_unavailable") return (
    <section className={styles["identity-error"]} aria-labelledby="identity-error-title">
      <h1 id="identity-error-title">身份服务暂时不可用</h1>
      <p>账号与权限尚未核实，暂不展示园所资料。请稍后重新读取。</p>
      <Button asChild className={styles["primary-button"]}><Link href="/">重新读取身份</Link></Button>
    </section>
  );
  const admin = data.viewer.kind === "admin";
  const years = [...new Set(data.class_groups.flatMap((group) => group.classes.map((entry) => entry.school_year)))];
  const yearLabel = years.length === 1 ? `${years[0].replace("-", "—")} 学年` : null;
  const pending = data.pending_counts;
  const confirmation = data.primary_action.code === "process_confirmations";
  const noAssignment = data.primary_action.code === "await_class_assignment";
  const classDataMissing = data.notices.some((notice) => notice.code === "data_unavailable") && data.scope?.class_count === null;

  return (
    <div className={styles.home} data-home-state={data.viewer.kind}>
      <section className={`${styles["welcome-band"]} ${admin ? styles["admin-welcome"] : ""}`}>
        <div className={styles["welcome-copy"]}>
          <h1>{data.viewer.display_name}，欢迎回来。</h1>
          <p className={styles["scope-line"]}>
            {admin ? "全园" : "教师"}
            {data.scope?.class_count !== null && data.scope ? <> · {admin ? "" : <span className={styles["desktop-helper"]}>负责 </span>}{data.scope.class_count} 个班级</> : " · 班级数未读取"}
            {data.scope?.child_count !== null && data.scope ? <> · {data.scope.child_count} 名幼儿</> : " · 幼儿数未读取"}
            {yearLabel ? <span className={styles["year-label"]}> · {yearLabel}</span> : null}
          </p>
          <p className={styles["brand-line"]}>{SLOGAN}</p>
        </div>
        {admin ? <div className={styles["admin-actions"]}>
          <Button asChild className={styles["primary-button"]}><Link href="/classes"><Users size={22} />管理班级</Link></Button>
          <Button asChild variant="outline" className={styles["secondary-button"]}><Link href="/admin/teachers"><UserRound size={22} />管理教师</Link></Button>
        </div> : <div className={styles["teacher-artwork"]}><Image src="/assets/illustrations/home-v2-teacher.png" alt="" width={1635} height={962} priority sizes="380px" /></div>}
      </section>

      {!admin ? <section className={styles["action-strip"]} aria-labelledby="home-primary-title">
        <div className={styles["action-copy"]}>
          <div className={styles["task-icon"]}><FileText size={48} strokeWidth={1.8} aria-hidden="true" /><Sparkles size={24} aria-hidden="true" /></div>
          <div><h2 id="home-primary-title">{confirmation ? <><strong>{pending.confirmations}</strong> 条观察等待确认</> : data.primary_action.label}</h2>
            <p>{confirmation ? "AI 已整理草稿，请你核对后归档。" : data.primary_action.helper}</p></div>
        </div>
        {!noAssignment ? <Button asChild className={styles["primary-button"]}><Link href={data.primary_action.href}>{confirmation ? <FileText size={22} /> : <FilePenLine size={22} />}{data.primary_action.label}<ArrowRight size={20} /></Link></Button> : null}
        {!noAssignment && data.primary_action.code !== "retry" ? <div className={styles["action-extras"]}>
          <div className={styles["other-pending"]}>
            {pending.supplements !== null && pending.supplements > 0 ? <Link href="/observations?status=needs_input">待补充 {pending.supplements}</Link> : null}
            {pending.organizes !== null && pending.organizes > 0 ? <Link href="/observations?status=draft">待整理 {pending.organizes}</Link> : null}
          </div>
          {data.primary_action.code !== "start_observation" && data.primary_action.code !== "create_profile" ? <Link href="/observations/new" className={styles["record-link"]}><PenLine size={22} />开始记录</Link> : null}
        </div> : null}
      </section> : null}

      {data.notices.filter((notice) => notice.severity === "error" || notice.code === "data_unavailable").map((notice) => (
        <p key={notice.code} role="status" className={styles["data-notice"]}>{notice.message} {data.primary_action.code !== "retry" ? "已获取的待办仍可继续处理。" : ""}</p>
      ))}

      <section className={styles["class-section"]} aria-labelledby="home-classes-title">
        <div className={styles["section-heading"]}><h2 id="home-classes-title">{admin ? "全园班级" : "我的班级"}</h2>
          <p className={styles["class-help"]}>{admin ? "按学段查看班级，进入班级可回看指南证据。" : <><span className={styles["desktop-helper"]}>班级里查看指南证据概览，成长档案里回看个人证据册。</span><span className={styles["mobile-helper"]}>班级看证据概览，档案看个人证据。</span></>}</p></div>
        {classDataMissing ? <p className={styles["empty-message"]}>班级资料暂不可读，不能据此判断没有班级。</p> : data.class_groups.length === 0 ? (
          <p className={styles["empty-message"]}>{noAssignment ? "请联系园所管理员安排任教班级。" : admin ? "还没有班级，可以从管理班级开始建立。" : "当前范围还没有班级资料。"}</p>
        ) : data.class_groups.map((group) => {
          const groupCount = group.classes.every((entry) => entry.child_count !== null)
            ? group.classes.reduce((total, entry) => total + (entry.child_count ?? 0), 0) : null;
          return <section key={group.stage} className={styles["stage-group"]} aria-label={`${group.stage_label}班级`}>
            <h3><Sprout size={25} aria-hidden="true" /><span className={admin ? `${styles["stage-tag"]} ${styles[group.stage]}` : ""}>{group.stage_label}</span><span> · {group.classes.length} 个班级{admin && groupCount !== null ? <> · {groupCount} 名幼儿</> : null}</span></h3>
            <div>{group.classes.map((klass) => <Link key={klass.class_id}
              href={admin ? `/classes/${encodeURIComponent(klass.class_id)}/evidence?${evidenceEntryQuery(klass.stage)}` : `/classes/${encodeURIComponent(klass.class_id)}`}
              className={styles["class-row"]}>
              <span className={styles["class-name"]}>{klass.name}{!klass.is_active ? <small>已停用</small> : null}</span>
              <span className={styles["class-children"]}>{klass.child_count === null ? "人数未读取" : `${klass.child_count} 名幼儿`}</span>
              {!admin ? <ClassPending klass={klass} /> : null}
              <span className={styles["class-enter"]}>{admin ? "查看班级证据" : "查看班级"}<ArrowRight size={17} /></span>
              <ChevronRight size={20} className={styles["mobile-chevron"]} aria-hidden="true" />
            </Link>)}</div>
          </section>;
        })}
      </section>

      {!admin && !noAssignment ? <section className={styles["recent-section"]} aria-labelledby="home-recent-title">
        <div className={styles["section-heading"]}><h2 id="home-recent-title">最近观察</h2><Link href="/observations">全部观察<ArrowRight size={18} /></Link></div>
        {data.recent.length > 0 ? data.recent.map((observation) => <div key={observation.observation_id} className={styles["recent-row"]}>
          <span className={styles["recent-child"]}><UserRound size={22} aria-hidden="true" />{observation.child_name ?? "档案暂不可读"}</span>
          <span className={styles["recent-context"]} title={observation.excerpt}>{observation.context ?? "日常观察"}</span>
          <span className={styles["recent-date"]}>{shortDate(observation.observed_at)}</span>
          <span className={styles["observation-badge"]}>{STATUS_LABELS[observation.status]}</span>
          <Link href={`/children/${encodeURIComponent(observation.child_id)}/evidence`} className={styles["recent-enter"]}>查看证据册<ArrowRight size={17} /></Link>
        </div>) : <p className={styles["empty-message"]}>{data.notices.some((notice) => notice.code === "data_unavailable") ? "最近观察暂未读取。" : "从一次真实的观察开始，逐步积累成长证据。"}</p>}
      </section> : null}
      {admin ? <p className={styles["admin-footnote"]}>班级页按当前在班名单与所选期间查看证据分布，个人证据册保留历史来源。</p> : null}
    </div>
  );
}

function shortDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${Number(match[2])}月${Number(match[3])}日` : "日期未保存";
}

function GuestHomepage() {
  const steps = [
    { label: "记录观察", icon: NotebookPen }, { label: "AI 整理", icon: Sparkles },
    { label: "教师确认", icon: UserRound }, { label: "指南证据", icon: FileText }, { label: "活动支持", icon: Leaf },
  ];
  return <div className={`${styles.home} ${styles["guest-home"]}`} data-home-state="logged_out">
    <div className={styles["guest-grid"]}>
      <section className={styles["guest-brand"]}>
        <h1>以三年为序，<br />看见幼儿持续生长</h1>
        <p className={styles["guest-subtitle"]}>从小班到大班，连接观察证据与教育支持。</p>
        <div className={styles["years-path"]} aria-label="小班至中班至大班持续追踪"><span>小班</span><ArrowRight size={24} aria-hidden="true" /><span>中班</span><ArrowRight size={24} aria-hidden="true" /><span>大班</span></div>
        <Image className={styles["guest-artwork"]} src="/assets/illustrations/home-v2-guest.png" alt="教师记录幼儿搭积木时的观察" width={1774} height={887} priority sizes="(max-width:768px) 90vw, 600px" />
      </section>
      <LoginPanel />
    </div>
    <section className={styles.mechanism} aria-label="成长观察与教育支持流程">
      <ol>{steps.map(({ label, icon: Icon }, index) => <li key={label}><span><Icon size={30} strokeWidth={1.9} aria-hidden="true" /></span><strong>{label}</strong>{index < steps.length - 1 ? <ArrowRight className={styles["step-arrow"]} size={22} aria-hidden="true" /> : null}</li>)}</ol>
      <p>以《3—6岁儿童学习与发展指南》为参考，依据教师确认的观察积累证据。</p>
      <p className={styles.domains}>健康 · 语言 · 社会 · 科学 · 艺术</p>
    </section>
  </div>;
}
