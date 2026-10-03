import { parseIsoDateStrict } from "@/lib/format";
import type { ClassStage, ObservationDraft, ObservationStatus } from "@/lib/types";
import { CLASS_STAGES } from "@/lib/types";
import { isQuoteInRawText } from "@/lib/validation";

import {
  GUIDE_CATALOG_VERSION,
  GUIDE_CLASS_SNAPSHOT_SOURCES,
  GUIDE_EVIDENCE_LINK_STATUSES,
  GUIDE_EVIDENCE_QUOTE_SOURCES,
  GUIDE_EVIDENCE_SUPPORT_KINDS,
  type GuideEvidenceBasis,
  type GuideEvidenceLink,
  type GuideEvidenceLinkStatus,
  type GuideEvidencePeriodNote,
  type GuideEvidenceQuoteField,
  type GuideEvidenceQuoteSource,
  type GuideEvidenceSupportKind,
  type GuidePerformanceItem,
  type ObservationClassContextSnapshot,
} from "./types";
import type {
  EvidenceAudience,
  EvidenceBasisInvalidReason,
  EvidenceBasisView,
  EvidenceExclusionReason,
  EvidenceLinkView,
  EvidenceReliability,
  EvidenceScope,
  GuideItemEvidenceStatus,
} from "./view-types";

/**
 * G5 运行时解析、依据核对与状态计算。
 *
 * 与 G0 参考算法同规则，但输入是真实数据库记录：
 * - NULL 是正常未关联；结构不可解析是损坏；未知状态显式提示；未知字段安全忽略（写入时原样保留）。
 * - 全部必需依据必须有效，任一条失效整条不计入正式状态（禁止 .some()），失效依据保留审计。
 * - 可靠性不是第四种儿童状态：期间/阶段口径排除不降可靠性，损坏与版本不一致才降。
 */

/** 读模型与校验共用的观察最小形态（Observation 结构兼容） */
export interface EvidenceObservation {
  id: string;
  child_id: string;
  observed_at: string;
  raw_text: string;
  status: ObservationStatus;
  confirmed_content: ObservationDraft | null;
  confirmed_at: string | null;
  class_context_snapshot?: ObservationClassContextSnapshot | null;
  guide_evidence?: unknown;
}

export type RuntimeLinkStatus = GuideEvidenceLinkStatus | "unknown";

export interface RuntimeBasis {
  observation_id: string;
  observed_at: string;
  quote: string;
  quote_source: GuideEvidenceQuoteSource;
  quote_field: GuideEvidenceQuoteField | null;
  class_context: ObservationClassContextSnapshot | null;
  source_confirmed_at: string | null;
  /** 结构字段缺失/类型错误：按不可核对处理，不静默丢弃 */
  malformed: boolean;
}

export interface RuntimeLink {
  /** 原始对象：写入时在其上合并，保留未知字段与历史数据 */
  raw: Record<string, unknown>;
  id: string;
  item_id: string;
  catalog_version: string;
  origin: "ai" | "manual";
  status: RuntimeLinkStatus;
  support: GuideEvidenceSupportKind | null;
  sustained_note: GuideEvidencePeriodNote | null;
  adult_help_used: boolean;
  basis: RuntimeBasis[];
  ai_reason: string | null;
  teacher_note: string | null;
  revision: number;
  created_at: string;
  decided_at: string | null;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
  /** item_id / basis / revision 等关键字段结构异常 */
  malformed: boolean;
}

export type ParsedGuideEvidence =
  | { kind: "none"; revision: 0; links: []; raw: null }
  | { kind: "ok"; revision: number; links: RuntimeLink[]; raw: Record<string, unknown> }
  | { kind: "unreadable"; raw: unknown };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function intOrZero(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function parseClassContext(value: unknown): ObservationClassContextSnapshot | null {
  if (!isRecord(value)) return null;
  const classId = str(value.class_id);
  const className = str(value.class_name);
  const stage = str(value.stage);
  const schoolYear = str(value.school_year);
  const capturedAt = str(value.captured_at);
  const source = str(value.source);
  if (!classId || !className || !schoolYear || !capturedAt) return null;
  if (!(CLASS_STAGES as readonly string[]).includes(stage ?? "")) return null;
  if (!(GUIDE_CLASS_SNAPSHOT_SOURCES as readonly string[]).includes(source ?? "")) return null;
  return {
    class_id: classId,
    class_name: className,
    stage: stage as ClassStage,
    school_year: schoolYear,
    captured_at: capturedAt,
    source: source as ObservationClassContextSnapshot["source"],
    enrollment_id: str(value.enrollment_id),
    confirmed_at: str(value.confirmed_at),
  };
}

function parsePeriodNote(value: unknown): GuideEvidencePeriodNote | null {
  if (!isRecord(value)) return null;
  const start = str(value.period_start);
  const end = str(value.period_end);
  const description = str(value.description);
  if (!start || !end || !description) return null;
  return { period_start: start, period_end: end, description };
}

function parseBasis(value: unknown): RuntimeBasis | null {
  if (!isRecord(value)) return null;
  const observationId = str(value.observation_id);
  const observedAt = str(value.observed_at);
  const quote = str(value.quote);
  const quoteSource = str(value.quote_source);
  const rawField = value.quote_field;
  const quoteField =
    rawField === null || rawField === undefined ? null : (str(rawField) as GuideEvidenceQuoteField | null);
  const malformed =
    !observationId ||
    !observedAt ||
    !quote ||
    !(GUIDE_EVIDENCE_QUOTE_SOURCES as readonly string[]).includes(quoteSource ?? "") ||
    (rawField !== null && rawField !== undefined && quoteField === null);
  return {
    observation_id: observationId ?? "",
    observed_at: observedAt ?? "",
    quote: quote ?? "",
    quote_source: (quoteSource as GuideEvidenceQuoteSource | null) ?? "raw_text",
    quote_field: quoteField,
    class_context: parseClassContext(value.class_context),
    source_confirmed_at: str(value.source_confirmed_at),
    malformed,
  };
}

function parseLink(value: unknown): RuntimeLink | null {
  if (!isRecord(value)) return null;
  const status = str(value.status);
  const itemId = str(value.item_id);
  const basisRaw = value.basis;
  const basis = Array.isArray(basisRaw)
    ? basisRaw.map(parseBasis).filter((entry): entry is RuntimeBasis => entry !== null)
    : [];
  const malformed =
    !itemId ||
    !Array.isArray(basisRaw) ||
    basis.length !== (Array.isArray(basisRaw) ? basisRaw.length : 0) ||
    typeof value.revision !== "number";
  return {
    raw: value,
    id: str(value.id) ?? "",
    item_id: itemId ?? "",
    catalog_version: str(value.catalog_version) ?? "",
    origin: value.origin === "manual" ? "manual" : "ai",
    status:
      status && (GUIDE_EVIDENCE_LINK_STATUSES as readonly string[]).includes(status)
        ? (status as GuideEvidenceLinkStatus)
        : "unknown",
    support:
      str(value.support) &&
      (GUIDE_EVIDENCE_SUPPORT_KINDS as readonly string[]).includes(str(value.support) ?? "")
        ? (str(value.support) as GuideEvidenceSupportKind)
        : null,
    sustained_note: parsePeriodNote(value.sustained_note),
    adult_help_used: value.adult_help_used === true,
    basis,
    ai_reason: str(value.ai_reason),
    teacher_note: str(value.teacher_note),
    revision: intOrZero(value.revision),
    created_at: str(value.created_at) ?? "",
    decided_at: str(value.decided_at),
    withdrawn_at: str(value.withdrawn_at),
    withdrawn_reason: str(value.withdrawn_reason),
    malformed,
  };
}

export function parseRuntimeLink(value: unknown): RuntimeLink | null {
  return parseLink(value);
}

export function parseGuideEvidence(value: unknown): ParsedGuideEvidence {
  if (value === null || value === undefined) {
    return { kind: "none", revision: 0, links: [], raw: null };
  }
  if (!isRecord(value)) return { kind: "unreadable", raw: value };
  const linksRaw = value.links;
  if (!Array.isArray(linksRaw)) return { kind: "unreadable", raw: value };
  const links: RuntimeLink[] = [];
  for (const entry of linksRaw) {
    const parsed = parseLink(entry);
    if (!parsed) return { kind: "unreadable", raw: value };
    links.push(parsed);
  }
  return { kind: "ok", revision: intOrZero(value.revision), links, raw: value };
}

/**
 * 容器完整性分类（与 G0 classifyCorrupted 同口径）：
 * - null → null（正常未关联）
 * - 非对象 / links 非数组 / link 非对象 → guide_evidence_unreadable
 * - link.status 不是已知状态 → unknown_link_status
 */
export function classifyGuideEvidence(value: unknown): "unreadable" | "unknown_status" | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return "unreadable";
  const links = value.links;
  if (!Array.isArray(links)) return "unreadable";
  for (const link of links) {
    if (!isRecord(link)) return "unreadable";
    const status = link.status;
    if (
      typeof status !== "string" ||
      !(GUIDE_EVIDENCE_LINK_STATUSES as readonly string[]).includes(status)
    ) {
      return "unknown_status";
    }
  }
  return null;
}

export interface BasisCheck {
  valid: boolean;
  reason: EvidenceBasisInvalidReason | null;
}

function quoteVerifiable(observation: EvidenceObservation, basis: RuntimeBasis): boolean {
  if (basis.quote_source === "raw_text") {
    return basis.quote_field === null && isQuoteInRawText(observation.raw_text, basis.quote);
  }
  const content = observation.confirmed_content;
  if (!content) return false;
  if (basis.quote_field === "highlight_quote") {
    return isQuoteInRawText(content.highlight_quote, basis.quote);
  }
  if (basis.quote_field === "highlights") {
    return content.highlights.some((highlight) => isQuoteInRawText(highlight, basis.quote));
  }
  return false;
}

/**
 * 时间戳等价比较：数据库 to_jsonb 与 JS toISOString 的时区写法不同
 * （`+00:00` 与 `Z`），必须按时刻比较，不能按字符串。
 */
export function sameTimestamp(left: string | null, right: string | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

/** 逐条依据核对：来源存在、同一儿童、已确认、日期与版本一致、片段可逐字核对 */
export function checkBasis(
  basis: RuntimeBasis,
  childId: string,
  observationById: Map<string, EvidenceObservation>,
): BasisCheck {
  if (basis.malformed) {
    return { valid: false, reason: basis.observation_id ? "quote_not_found" : "source_missing" };
  }
  const observation = observationById.get(basis.observation_id);
  if (!observation) return { valid: false, reason: "source_missing" };
  if (observation.child_id !== childId) return { valid: false, reason: "cross_child" };
  if (observation.status !== "confirmed" || !observation.confirmed_content) {
    return { valid: false, reason: "not_confirmed" };
  }
  if (!parseIsoDateStrict(observation.observed_at) || observation.observed_at !== basis.observed_at) {
    return { valid: false, reason: "version_mismatch" };
  }
  if (!sameTimestamp(basis.source_confirmed_at, observation.confirmed_at)) {
    return { valid: false, reason: "version_mismatch" };
  }
  if (!quoteVerifiable(observation, basis)) return { valid: false, reason: "quote_not_found" };
  return { valid: true, reason: null };
}

export interface LinkEvaluation {
  link: RuntimeLink;
  counts_toward_status: boolean;
  excluded_reason: EvidenceExclusionReason | null;
  /** 数据完整性/可读性问题（影响 reliability）；期间与阶段口径排除不算 */
  integrity_issue: boolean;
  basis_checks: BasisCheck[];
}

function inPeriod(date: string, scope: EvidenceScope): boolean {
  if (scope.kind === "all_history") return true;
  if (scope.start_date === null || scope.end_date === null) return false;
  return date >= scope.start_date && date <= scope.end_date;
}

function excluded(
  link: RuntimeLink,
  reason: EvidenceExclusionReason,
  integrityIssue: boolean,
  basisChecks: BasisCheck[],
): LinkEvaluation {
  return {
    link,
    counts_toward_status: false,
    excluded_reason: reason,
    integrity_issue: integrityIssue,
    basis_checks: basisChecks,
  };
}

/**
 * 单条关联评估（个人页与班级页共用；班级页额外应用阶段口径）。
 * 顺序与 G0 参考算法一致：目录版本 → 工作流状态 → 全部依据有效 → 期间 → 阶段 → 支持条件。
 */
export function evaluateLink(
  link: RuntimeLink,
  item: GuidePerformanceItem,
  childId: string,
  observationById: Map<string, EvidenceObservation>,
  scope: EvidenceScope,
  audience: EvidenceAudience,
  classStage: ClassStage | null,
): LinkEvaluation {
  const basisChecks: BasisCheck[] = [];
  if (link.malformed) return excluded(link, "unknown_status", true, basisChecks);
  if (link.catalog_version !== GUIDE_CATALOG_VERSION) {
    return excluded(link, "catalog_mismatch", true, basisChecks);
  }
  if (link.status === "ai_suggested") return excluded(link, "workflow_pending", false, basisChecks);
  if (link.status === "rejected") return excluded(link, "teacher_rejected", false, basisChecks);
  if (link.status === "withdrawn") return excluded(link, "withdrawn", false, basisChecks);
  if (link.status !== "confirmed_performance" && link.status !== "confirmed_clue") {
    return excluded(link, "unknown_status", true, basisChecks);
  }

  for (const basis of link.basis) {
    basisChecks.push(checkBasis(basis, childId, observationById));
  }
  if (link.basis.length === 0 || basisChecks.some((check) => !check.valid)) {
    return excluded(link, "basis_invalid", true, basisChecks);
  }

  if (!link.basis.every((basis) => inPeriod(basis.observed_at, scope))) {
    return excluded(link, "basis_out_of_period", false, basisChecks);
  }
  if (
    link.sustained_note &&
    (!inPeriod(link.sustained_note.period_start, scope) ||
      !inPeriod(link.sustained_note.period_end, scope))
  ) {
    return excluded(link, "basis_out_of_period", false, basisChecks);
  }

  if (audience === "class_current_roster") {
    const stages = link.basis.map((basis) => basis.class_context?.stage ?? null);
    if (stages.some((stage) => stage === null)) {
      return excluded(link, "history_unknown", true, basisChecks);
    }
    if (classStage && stages.some((stage) => stage !== classStage)) {
      return excluded(link, "out_of_stage_evidence", false, basisChecks);
    }
  }

  if (link.status === "confirmed_performance") {
    if (item.product_rules.evidence_type === "sustained" && link.support !== "sustained") {
      return excluded(link, "support_insufficient", true, basisChecks);
    }
    if (link.support === "sustained") {
      const days = new Set(link.basis.map((basis) => basis.observed_at));
      const note = link.sustained_note;
      const noteCoversBasis = Boolean(
        note &&
          note.description.trim().length >= 10 &&
          link.basis.every(
            (basis) =>
              basis.observed_at >= note.period_start && basis.observed_at <= note.period_end,
          ),
      );
      if (days.size < 2 && !noteCoversBasis) {
        return excluded(link, "support_insufficient", true, basisChecks);
      }
    }
  }

  return {
    link,
    counts_toward_status: true,
    excluded_reason: null,
    integrity_issue: false,
    basis_checks: basisChecks,
  };
}

export interface ChildItemRollup {
  status: GuideItemEvidenceStatus;
  reliability: EvidenceReliability;
  evaluations: LinkEvaluation[];
}

/**
 * 单个儿童在单个条目上的汇总。
 * corruptedContainers：该儿童观察中无法读取/未知状态的容器数量；
 * 全部观察都损坏时 unavailable，部分损坏时 partial；NULL 正常未关联不影响可靠性。
 */
export function rollupChildItem(input: {
  childId: string;
  observations: EvidenceObservation[];
  item: GuidePerformanceItem;
  observationById: Map<string, EvidenceObservation>;
  scope: EvidenceScope;
  audience: EvidenceAudience;
  classStage: ClassStage | null;
}): ChildItemRollup {
  const evaluations: LinkEvaluation[] = [];
  for (const observation of input.observations) {
    const parsed = parseGuideEvidence(observation.guide_evidence);
    if (parsed.kind !== "ok") continue;
    for (const link of parsed.links) {
      if (link.item_id !== input.item.id) continue;
      evaluations.push(
        evaluateLink(
          link,
          input.item,
          input.childId,
          input.observationById,
          input.scope,
          input.audience,
          input.classStage,
        ),
      );
    }
  }

  let corruptedContainers = 0;
  for (const observation of input.observations) {
    if (classifyGuideEvidence(observation.guide_evidence) !== null) corruptedContainers += 1;
  }

  let reliability: EvidenceReliability = evaluations.some((entry) => entry.integrity_issue)
    ? "partial"
    : "reliable";
  if (corruptedContainers > 0) {
    const readable = input.observations.length - corruptedContainers;
    reliability = readable === 0 ? "unavailable" : "partial";
  }

  const counted = evaluations.filter((entry) => entry.counts_toward_status);
  const status: GuideItemEvidenceStatus = counted.some(
    (entry) => entry.link.status === "confirmed_performance",
  )
    ? "confirmed_observed"
    : counted.some((entry) => entry.link.status === "confirmed_clue")
      ? "has_clues"
      : "no_records";
  return { status, reliability, evaluations };
}

export function worstReliability(values: EvidenceReliability[]): EvidenceReliability {
  if (values.includes("unavailable")) return "unavailable";
  if (values.includes("partial")) return "partial";
  return "reliable";
}

export interface ClassItemRollup {
  counts: { no_records: number; has_clues: number; confirmed_observed: number };
  total: number;
  reliability: EvidenceReliability;
  confirmed_ratio: number | null;
}

export function rollupClassItem(input: {
  children: { childId: string; observations: EvidenceObservation[] }[];
  item: GuidePerformanceItem;
  observationById: Map<string, EvidenceObservation>;
  scope: EvidenceScope;
  classStage: ClassStage;
}): ClassItemRollup {
  const counts = { no_records: 0, has_clues: 0, confirmed_observed: 0 };
  const reliabilities: EvidenceReliability[] = [];
  for (const child of input.children) {
    const rollup = rollupChildItem({
      childId: child.childId,
      observations: child.observations,
      item: input.item,
      observationById: input.observationById,
      scope: input.scope,
      audience: "class_current_roster",
      classStage: input.classStage,
    });
    counts[rollup.status] += 1;
    reliabilities.push(rollup.reliability);
  }
  const reliability = worstReliability(reliabilities);
  const total = input.children.length;
  const confirmed_ratio =
    reliability === "reliable" && input.item.product_rules.counts_in_behavior_stats && total > 0
      ? counts.confirmed_observed / total
      : null;
  return { counts, total, reliability, confirmed_ratio };
}

/** 单条依据视图：含服务端核对结果与来源观察当前状态（用于审计展示） */
export function buildBasisView(
  basis: RuntimeBasis,
  check: BasisCheck,
  observationById: Map<string, EvidenceObservation>,
): EvidenceBasisView {
  const source = observationById.get(basis.observation_id) ?? null;
  return {
    observation_id: basis.observation_id,
    observed_at: basis.observed_at,
    quote: basis.quote,
    quote_source: basis.quote_source,
    quote_field: basis.quote_field,
    class_context: basis.class_context,
    source_confirmed_at: basis.source_confirmed_at,
    valid: check.valid,
    invalid_reason: check.reason,
    observation_status: source ? source.status : null,
  };
}

/** 关联视图：用于变更接口响应（all_history + child_history 口径，逐条带 counts_toward_status） */
export function buildMutationLinkViews(
  links: GuideEvidenceLink[],
  childId: string,
  observationById: Map<string, EvidenceObservation>,
  itemById: (id: string) => GuidePerformanceItem | null,
): EvidenceLinkView[] {
  const scope: EvidenceScope = {
    kind: "all_history",
    semester_id: null,
    label: "全部历史",
    start_date: null,
    end_date: null,
    filter_field: "observed_at",
  };
  const parsed: RuntimeLink[] = [];
  for (const link of links) {
    const runtime = parseLink(link);
    if (runtime) parsed.push(runtime);
  }
  return parsed
    .filter((link) => link.status !== "unknown")
    .map((link) => {
      const item = itemById(link.item_id);
      const evaluation = item
        ? evaluateLink(link, item, childId, observationById, scope, "child_history", null)
        : excluded(link, "catalog_mismatch", true, []);
      return {
        link_id: link.id,
        item_id: link.item_id,
        catalog_version: link.catalog_version,
        origin: link.origin,
        status: link.status as Exclude<RuntimeLinkStatus, "unknown">,
        support: link.support,
        sustained_note: link.sustained_note,
        adult_help_used: link.adult_help_used,
        basis: link.basis.map((basis, index) =>
          buildBasisView(
            basis,
            evaluation.basis_checks[index] ?? { valid: false, reason: null },
            observationById,
          ),
        ),
        ai_reason: link.ai_reason,
        teacher_note: link.teacher_note,
        revision: link.revision,
        created_at: link.created_at,
        decided_at: link.decided_at,
        withdrawn_at: link.withdrawn_at,
        withdrawn_reason: link.withdrawn_reason,
        counts_toward_status: evaluation.counts_toward_status,
        excluded_reason: evaluation.excluded_reason,
      };
    });
}

/** 解析快照为可写快照；无法核实返回 null（历史未知，不补造） */
export function parseSnapshotForWrite(value: unknown): ObservationClassContextSnapshot | null {
  return parseClassContext(value);
}
