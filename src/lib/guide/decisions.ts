import { randomUUID } from "node:crypto";

import { parseIsoDateStrict } from "@/lib/format";
import type { ObservationDraft, ObservationStatus } from "@/lib/types";
import type { GuideEvidenceBasisInputParsed, GuideEvidenceDecisionParsed } from "@/lib/validation";
import { isQuoteInRawText } from "@/lib/validation";

import type { ParsedGuideEvidence, RuntimeLink } from "./runtime";
import { parseRuntimeLink, sameTimestamp } from "./runtime";
import {
  GUIDE_CATALOG_VERSION,
  type GuideEvidenceBasis,
  type GuideEvidenceLink,
  type GuideEvidencePeriodNote,
  type GuideEvidenceQuoteField,
  type GuideEvidenceQuoteSource,
  type GuideEvidenceSupportKind,
  type GuidePerformanceItem,
  type ObservationClassContextSnapshot,
  type ObservationGuideEvidence,
} from "./types";

/**
 * G5 教师决定的写入校验与应用（纯函数，事务外可测）。
 *
 * - 所有决定先全部校验通过，再统一应用；任一条失败整批不写入（全有或全无）。
 * - 依据快照（observed_at / class_context / source_confirmed_at）一律由服务端读取来源生成。
 * - 幂等：结果状态与内容完全一致的重复决定返回 200 语义（changed=false，不增长 revision）。
 * - 终态 rejected / withdrawn 不原地复活；合法重新关联创建新 link，旧审计保留。
 */

export class GuideEvidenceInvalidError extends Error {
  code = "invalid_request" as const;
  link_id?: string;
  item_id?: string;
  constructor(message: string, refs: { link_id?: string; item_id?: string } = {}) {
    super(message);
    this.name = "GuideEvidenceInvalidError";
    this.link_id = refs.link_id;
    this.item_id = refs.item_id;
  }
}

export class GuideEvidenceConflictError extends Error {
  code = "state_conflict" as const;
  link_id?: string;
  item_id?: string;
  constructor(message: string, refs: { link_id?: string; item_id?: string } = {}) {
    super(message);
    this.name = "GuideEvidenceConflictError";
    this.link_id = refs.link_id;
    this.item_id = refs.item_id;
  }
}

export class GuideEvidenceNotFoundError extends Error {
  code = "not_found" as const;
  link_id?: string;
  constructor(message: string, linkId?: string) {
    super(message);
    this.name = "GuideEvidenceNotFoundError";
    this.link_id = linkId;
  }
}

export class GuideEvidenceCatalogError extends Error {
  code = "catalog_version_mismatch" as const;
  item_id?: string;
  constructor(message: string, itemId?: string) {
    super(message);
    this.name = "GuideEvidenceCatalogError";
    this.item_id = itemId;
  }
}

/** 确认时依据无法核对或版本不一致（含沿用旧快照时来源版本漂移） */
export class GuideEvidenceBasisExpiredError extends Error {
  code = "basis_expired" as const;
  link_id?: string;
  item_id?: string;
  constructor(message: string, refs: { link_id?: string; item_id?: string } = {}) {
    super(message);
    this.name = "GuideEvidenceBasisExpiredError";
    this.link_id = refs.link_id;
    this.item_id = refs.item_id;
  }
}

/**
 * 宿主观察守门：独立 confirm / reject / withdraw 只能作用于已归档观察。
 * 与来源核对分离——依据来源合法也不能绕过宿主状态（suggest 仍可产生待核对建议）。
 */
export function hostObservationConflictError(
  status: ObservationStatus,
): GuideEvidenceConflictError | null {
  if (status === "confirmed") return null;
  return new GuideEvidenceConflictError(
    "该观察尚未确认归档，不能独立执行关联确认/拒绝/撤回；请先归档观察，或在归档时一并提交关联决定。",
  );
}

/** 依据来源（服务端读取；当前观察在确认事务中以“即将归档”的版本覆盖） */
export interface DecisionSourceObservation {
  id: string;
  child_id: string;
  observed_at: string;
  raw_text: string;
  status: ObservationStatus;
  confirmed_content: ObservationDraft | null;
  confirmed_at: string | null;
  class_context_snapshot: ObservationClassContextSnapshot | null;
}

export interface ApplyDecisionsContext {
  childId: string;
  itemById: (itemId: string) => GuidePerformanceItem | null;
  sourceById: Map<string, DecisionSourceObservation>;
  now: string;
  /**
   * 本次同事务归档的宿主观察 id；该来源在本事务中首次获得 confirmed_at，
   * 沿用其空版本快照属于合法首次归档，而不是版本漂移。
   */
  confirmingObservationId?: string | null;
}

export interface ApplyDecisionsResult {
  container: ObservationGuideEvidence | null;
  revision: number;
  changed: boolean;
  links: GuideEvidenceLink[];
}

interface PreparedConfirm {
  kind: "confirm";
  targetIndex: number | null;
  item: GuidePerformanceItem;
  status: "confirmed_performance" | "confirmed_clue";
  support: GuideEvidenceSupportKind;
  basis: GuideEvidenceBasis[];
  sustained_note: GuideEvidencePeriodNote | null;
  adult_help_used: boolean;
  teacher_note: string | null;
}

interface PreparedTerminal {
  kind: "reject" | "withdraw";
  targetIndex: number;
  reason: string | null;
}

type PreparedDecision = PreparedConfirm | PreparedTerminal;

type DecisionCommonInput = {
  support: GuideEvidenceSupportKind;
  basis: GuideEvidenceBasisInputParsed[];
  sustained_note?: GuideEvidencePeriodNote | null;
  adult_help_used?: boolean;
  teacher_note?: string;
};

function normalizedNote(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function buildBasis(
  input: GuideEvidenceBasisInputParsed,
  ctx: ApplyDecisionsContext,
  savedBasis: GuideEvidenceBasis[] | null,
): GuideEvidenceBasis {
  const source = ctx.sourceById.get(input.observation_id);
  if (!source) {
    throw new GuideEvidenceInvalidError("依据来源观察不存在或不属于这名幼儿，请刷新后重新选择。");
  }
  if (source.child_id !== ctx.childId) {
    throw new GuideEvidenceInvalidError("依据来源必须属于同一名幼儿。");
  }
  if (source.status !== "confirmed" || !source.confirmed_content) {
    throw new GuideEvidenceInvalidError(
      "依据来源尚未由教师确认归档；请先确认该条观察，或改用其他已确认来源。",
    );
  }
  if (!parseIsoDateStrict(source.observed_at)) {
    throw new GuideEvidenceInvalidError("依据来源的观察日期不可靠，不能作为证据。");
  }
  if (!source.confirmed_at || !Number.isFinite(Date.parse(source.confirmed_at))) {
    throw new GuideEvidenceBasisExpiredError(
      "依据来源缺少可核对的确认时间（版本），不能写入正式依据。",
      { item_id: input.observation_id },
    );
  }
  const quoteField = input.quote_field ?? null;
  if (input.quote_source === "raw_text") {
    if (quoteField !== null) {
      throw new GuideEvidenceInvalidError("raw_text 依据不能声明 quote_field。");
    }
    if (!isQuoteInRawText(source.raw_text, input.quote)) {
      throw new GuideEvidenceInvalidError(
        "引用片段未能在来源观察原文中逐字核对，请使用真实连续片段。",
      );
    }
  } else {
    if (quoteField !== "highlight_quote" && quoteField !== "highlights") {
      throw new GuideEvidenceInvalidError(
        "confirmed_content 依据只允许引用 highlight_quote 或 highlights。",
      );
    }
    const content = source.confirmed_content;
    const verifiable =
      quoteField === "highlight_quote"
        ? isQuoteInRawText(content.highlight_quote, input.quote)
        : content.highlights.some((highlight) => isQuoteInRawText(highlight, input.quote));
    if (!verifiable) {
      throw new GuideEvidenceInvalidError(
        "引用片段未能在确认稿的声明位置逐字核对，解释、备注或建议不能作为表现证据。",
      );
    }
  }
  const fresh: GuideEvidenceBasis = {
    observation_id: source.id,
    observed_at: source.observed_at,
    quote: input.quote.trim(),
    quote_source: input.quote_source,
    quote_field: input.quote_source === "raw_text" ? null : quoteField,
    class_context: source.class_context_snapshot,
    source_confirmed_at: source.confirmed_at,
  };

  const saved = findSavedBasis(savedBasis, input, fresh.quote);
  const savedSource = saved ?? findSavedSourceBasis(savedBasis, input.observation_id);
  if (!savedSource) return fresh;
  // 日期一致性独立核对：任何沿用（含首次归档豁免版本时）都不得跳过日期
  if (savedSource.observed_at !== fresh.observed_at) {
    throw new GuideEvidenceBasisExpiredError(
      "沿用的依据来源观察日期已变化，旧快照不能静默刷新；请重新核对来源或明确改用新依据。",
      { item_id: savedSource.observation_id },
    );
  }
  // 版本核对仍按来源进行：首次归档豁免只处理“空版本 → 首次 confirmed_at”
  const firstArchive =
    ctx.confirmingObservationId === savedSource.observation_id &&
    savedSource.source_confirmed_at === null;
  if (!firstArchive) {
    const versionConsistent =
      savedSource.source_confirmed_at !== null &&
      sameTimestamp(savedSource.source_confirmed_at, fresh.source_confirmed_at);
    if (!versionConsistent) {
      throw new GuideEvidenceBasisExpiredError(
        "沿用的依据来源在建议后已更新（版本变化），旧快照不能静默刷新；请重新核对来源或明确改用新依据。",
        { item_id: savedSource.observation_id },
      );
    }
  }
  // 仅完整定位（observation_id + quote + quote_source + quote_field）一致时复用保存快照；
  // 教师明确更换字段或片段属于修改，必须写入新定位，不得吞掉或误用第一个旧依据
  if (!saved || firstArchive) return fresh;
  return {
    observation_id: saved.observation_id,
    observed_at: saved.observed_at,
    quote: saved.quote,
    quote_source: saved.quote_source,
    quote_field: saved.quote_field,
    class_context: saved.class_context,
    source_confirmed_at: saved.source_confirmed_at,
  };
}

/** 完整定位匹配：同一来源、同一片段、同一出处、同一字段 */
function findSavedBasis(
  savedBasis: GuideEvidenceBasis[] | null,
  input: GuideEvidenceBasisInputParsed,
  quote: string,
): GuideEvidenceBasis | null {
  if (!savedBasis) return null;
  const quoteField = input.quote_source === "raw_text" ? null : (input.quote_field ?? null);
  return (
    savedBasis.find(
      (entry) =>
        entry.observation_id === input.observation_id &&
        entry.quote === quote &&
        entry.quote_source === input.quote_source &&
        (entry.quote_field ?? null) === quoteField,
    ) ?? null
  );
}

/** 同一来源的任一条旧依据：仅用于版本/日期守门，不用于复用快照 */
function findSavedSourceBasis(
  savedBasis: GuideEvidenceBasis[] | null,
  observationId: string,
): GuideEvidenceBasis | null {
  if (!savedBasis) return null;
  return savedBasis.find((entry) => entry.observation_id === observationId) ?? null;
}

function sustainedConditionMet(
  support: GuideEvidenceSupportKind,
  basis: GuideEvidenceBasis[],
  note: GuideEvidencePeriodNote | null,
): boolean {
  if (support !== "sustained") return true;
  const days = new Set(basis.map((entry) => entry.observed_at));
  if (days.size >= 2) return true;
  if (!note) return false;
  if (note.description.trim().length < 10) return false;
  if (!parseIsoDateStrict(note.period_start) || !parseIsoDateStrict(note.period_end)) return false;
  if (note.period_start > note.period_end) return false;
  return basis.every(
    (entry) => entry.observed_at >= note.period_start && entry.observed_at <= note.period_end,
  );
}

function prepareConfirm(
  decision: DecisionCommonInput,
  targetIndex: number | null,
  item: GuidePerformanceItem,
  ctx: ApplyDecisionsContext,
  savedLink: RuntimeLink | null,
): PreparedConfirm {
  const basis = decision.basis.map((input) =>
    buildBasis(input, ctx, savedLink ? savedLink.basis : null),
  );
  const support = decision.support;
  const sustainedNote = decision.sustained_note ?? null;
  if (support === "sustained" && !sustainedConditionMet(support, basis, sustainedNote)) {
    throw new GuideEvidenceInvalidError(
      "持续性表现需要至少两条不同日期的依据，或提供覆盖全部依据的连续观察纪要（说明不少于 10 字）。",
      { item_id: item.id },
    );
  }
  const isPerformance = support !== "clue_only";
  const adultHelpUsed = decision.adult_help_used === true;
  const teacherNote = normalizedNote(decision.teacher_note);
  if (isPerformance) {
    if (item.product_rules.evidence_type === "sustained" && support !== "sustained") {
      throw new GuideEvidenceInvalidError(
        "该条目属于持续性表现，确认表现必须使用持续性支持（或改为确认线索）。",
        { item_id: item.id },
      );
    }
    if (adultHelpUsed && !teacherNote) {
      throw new GuideEvidenceInvalidError(
        "本次决定使用了成人帮助，确认表现时必须说明帮助方式。",
        { item_id: item.id },
      );
    }
    if (adultHelpUsed && item.product_rules.adult_help === "requires_independence") {
      throw new GuideEvidenceInvalidError(
        "该条目要求幼儿独立完成，有成人帮助时只能确认相关线索。",
        { item_id: item.id },
      );
    }
  }
  return {
    kind: "confirm",
    targetIndex,
    item,
    status: isPerformance ? "confirmed_performance" : "confirmed_clue",
    support,
    basis,
    sustained_note: support === "sustained" ? sustainedNote : null,
    adult_help_used: adultHelpUsed,
    teacher_note: teacherNote,
  };
}

function prepareDecision(
  decision: GuideEvidenceDecisionParsed,
  links: RuntimeLink[],
  ctx: ApplyDecisionsContext,
): PreparedDecision {
  if ("link_id" in decision) {
    const targetIndex = links.findIndex((link) => link.id === decision.link_id);
    if (targetIndex < 0) {
      throw new GuideEvidenceNotFoundError(
        "关联不存在或不属于当前观察，请刷新后重试。",
        decision.link_id,
      );
    }
    const target = links[targetIndex];
    if (target.catalog_version !== GUIDE_CATALOG_VERSION) {
      throw new GuideEvidenceCatalogError(
        "该关联来自旧目录版本，不能因条目仍存在于新目录就默认兼容；请重新手动关联当前目录条目。",
        target.item_id,
      );
    }
    const item = ctx.itemById(target.item_id);
    if (!item) {
      throw new GuideEvidenceCatalogError(
        "该关联对应的条目不在当前目录版本，请改用当前目录条目重新关联。",
        target.item_id,
      );
    }
    return prepareConfirm(decision, targetIndex, item, ctx, target);
  }

  const item = ctx.itemById(decision.item_id);
  if (!item) {
    throw new GuideEvidenceCatalogError(
      "条目不在当前指南目录版本，不能建立关联。",
      decision.item_id,
    );
  }
  return prepareConfirm(decision, null, item, ctx, null);
}

interface BasisIdentity {
  observation_id: string;
  observed_at: string;
  quote: string;
  quote_source: GuideEvidenceQuoteSource;
  quote_field: GuideEvidenceQuoteField | null;
  source_confirmed_at: string | null;
}

function sameBasis(left: BasisIdentity[], right: BasisIdentity[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return (
      entry.observation_id === other.observation_id &&
      entry.observed_at === other.observed_at &&
      entry.quote === other.quote &&
      entry.quote_source === other.quote_source &&
      entry.quote_field === other.quote_field &&
      sameTimestamp(entry.source_confirmed_at, other.source_confirmed_at)
    );
  });
}

function sameNote(
  left: GuideEvidencePeriodNote | null,
  right: GuideEvidencePeriodNote | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.period_start === right.period_start &&
    left.period_end === right.period_end &&
    left.description === right.description
  );
}

/** 完整内容比较：不能用“状态一样”冒充幂等 */
function sameConfirmContent(link: RuntimeLink, prepared: PreparedConfirm): boolean {
  return (
    link.status === prepared.status &&
    link.support === prepared.support &&
    sameBasis(link.basis, prepared.basis) &&
    sameNote(link.sustained_note, prepared.sustained_note) &&
    link.adult_help_used === prepared.adult_help_used &&
    normalizedNote(link.teacher_note) === prepared.teacher_note
  );
}

function prepareTerminal(
  links: RuntimeLink[],
  action: "reject" | "withdraw",
  linkId: string,
  reason: string | undefined,
): PreparedTerminal {
  const targetIndex = links.findIndex((link) => link.id === linkId);
  if (targetIndex < 0) {
    throw new GuideEvidenceNotFoundError("关联不存在或不属于当前观察，请刷新后重试。", linkId);
  }
  return { kind: action, targetIndex, reason: normalizedNote(reason) };
}

type ReadableParsed = Extract<ParsedGuideEvidence, { kind: "none" | "ok" }>;

/** 应用一批已准备的变更；changed=false 时不得写库 */
function runPrepared(
  parsed: ReadableParsed,
  prepared: PreparedDecision[],
  ctx: ApplyDecisionsContext,
): ApplyDecisionsResult {
  const originalLinks = parsed.kind === "ok" ? parsed.links : [];
  const links: RuntimeLink[] = [...originalLinks];
  const rawLinks: unknown[] = originalLinks.map((link) => link.raw);
  let changed = false;

  const applyPatch = (index: number, patch: Record<string, unknown>) => {
    const merged = { ...links[index].raw, ...patch };
    const runtime = parseRuntimeLink(merged);
    if (!runtime) {
      throw new GuideEvidenceConflictError(
        "关联结构无法更新，请人工核对这条观察的原始数据。",
        { link_id: links[index].id },
      );
    }
    links[index] = runtime;
    rawLinks[index] = merged;
  };

  for (const entry of prepared) {
    if (entry.kind === "confirm") {
      if (entry.targetIndex === null) {
        const sameItem = links.filter((link) => link.item_id === entry.item.id);
        const active = sameItem.filter(
          (link) => link.status !== "rejected" && link.status !== "withdrawn",
        );
        const identical = active.find(
          (link) =>
            link.status !== "ai_suggested" &&
            link.status !== "unknown" &&
            sameConfirmContent(link, entry),
        );
        if (identical) continue;
        if (active.length > 0) {
          throw new GuideEvidenceConflictError(
            "该条目已有生效关联或待核对建议，内容不同不能重复建立；请改为核对现有建议或撤回后重新关联。",
            { item_id: entry.item.id },
          );
        }
        const created = {
          id: randomUUID(),
          item_id: entry.item.id,
          catalog_version: GUIDE_CATALOG_VERSION,
          origin: "manual",
          status: entry.status,
          support: entry.support,
          sustained_note: entry.sustained_note,
          adult_help_used: entry.adult_help_used,
          basis: entry.basis,
          ai_reason: null,
          teacher_note: entry.teacher_note,
          revision: 1,
          created_at: ctx.now,
          decided_at: ctx.now,
          withdrawn_at: null,
          withdrawn_reason: null,
        };
        const runtime = parseRuntimeLink(created);
        if (!runtime) {
          throw new GuideEvidenceConflictError("新关联结构无法写入，请人工核对。");
        }
        links.push(runtime);
        rawLinks.push(created);
        changed = true;
        continue;
      }

      const target = links[entry.targetIndex];
      if (sameConfirmContent(target, entry)) continue;
      if (
        target.status === "rejected" ||
        target.status === "withdrawn" ||
        target.status === "unknown"
      ) {
        throw new GuideEvidenceConflictError(
          target.status === "unknown"
            ? "关联状态无法识别，不能原地修改；请保留审计并重新手动关联。"
            : "该关联已结束（拒绝或撤回），不能原地复活；请重新手动关联建立新记录。",
          { link_id: target.id, item_id: target.item_id },
        );
      }
      applyPatch(entry.targetIndex, {
        status: entry.status,
        support: entry.support,
        sustained_note: entry.sustained_note,
        adult_help_used: entry.adult_help_used,
        basis: entry.basis,
        teacher_note: entry.teacher_note,
        decided_at: ctx.now,
        revision: target.revision + 1,
      });
      changed = true;
      continue;
    }

    const target = links[entry.targetIndex];
    if (entry.kind === "reject") {
      if (target.status === "rejected") {
        if (normalizedNote(target.teacher_note) === entry.reason) continue;
        throw new GuideEvidenceConflictError("该建议已被拒绝（终态），不能改写拒绝理由。", {
          link_id: target.id,
        });
      }
      if (target.status !== "ai_suggested") {
        throw new GuideEvidenceConflictError(
          "只有待核对的 AI 建议可以拒绝；已确认关联请使用撤回。",
          { link_id: target.id },
        );
      }
      applyPatch(entry.targetIndex, {
        status: "rejected",
        support: null,
        teacher_note: entry.reason,
        decided_at: ctx.now,
        revision: target.revision + 1,
      });
      changed = true;
      continue;
    }

    if (target.status === "withdrawn") {
      if ((target.withdrawn_reason ?? null) === entry.reason) continue;
      throw new GuideEvidenceConflictError("该关联已撤回（终态），不能改写撤回理由。", {
        link_id: target.id,
      });
    }
    if (target.status !== "confirmed_performance" && target.status !== "confirmed_clue") {
      throw new GuideEvidenceConflictError("只有已确认的关联可以撤回；待核对建议请使用拒绝。", {
        link_id: target.id,
      });
    }
    applyPatch(entry.targetIndex, {
      status: "withdrawn",
      withdrawn_at: ctx.now,
      withdrawn_reason: entry.reason,
      revision: target.revision + 1,
    });
    changed = true;
  }

  if (!changed) {
    return {
      container: parsed.kind === "ok" ? (parsed.raw as unknown as ObservationGuideEvidence) : null,
      revision: parsed.revision,
      changed: false,
      links: rawLinks as GuideEvidenceLink[],
    };
  }

  const revision = parsed.revision + 1;
  const container = {
    ...(parsed.kind === "ok" ? parsed.raw : {}),
    revision,
    links: rawLinks,
  } as unknown as ObservationGuideEvidence;
  return { container, revision, changed: true, links: container.links };
}

/**
 * 应用一批确认决定。调用方保证 parsed 不是 unreadable，且已持有观察行锁。
 * 返回 changed=false 时不得写库（幂等重复提交）。
 */
export function applyGuideDecisions(
  parsed: ParsedGuideEvidence,
  decisions: GuideEvidenceDecisionParsed[],
  ctx: ApplyDecisionsContext,
): ApplyDecisionsResult {
  if (parsed.kind === "unreadable") {
    throw new GuideEvidenceConflictError(
      "该观察的指南证据结构无法读取，不能写入新决定；请先人工核对原始数据。",
    );
  }
  const links = parsed.kind === "ok" ? parsed.links : [];
  const prepared = decisions.map((decision) => prepareDecision(decision, links, ctx));
  return runPrepared(parsed, prepared, ctx);
}

/** 拒绝 / 撤回：单条终态操作（同样支持完全相同的重复提交幂等） */
export function applyGuideTerminalOperation(
  parsed: ParsedGuideEvidence,
  action: "reject" | "withdraw",
  linkId: string,
  reason: string | undefined,
  ctx: ApplyDecisionsContext,
): ApplyDecisionsResult {
  if (parsed.kind === "unreadable") {
    throw new GuideEvidenceConflictError(
      "该观察的指南证据结构无法读取，不能写入新决定；请先人工核对原始数据。",
    );
  }
  const links = parsed.kind === "ok" ? parsed.links : [];
  const prepared = [prepareTerminal(links, action, linkId, reason)];
  return runPrepared(parsed, prepared, ctx);
}
