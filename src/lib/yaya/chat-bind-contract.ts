/**
 * 芽芽 v1 聊天可信绑定与恢复标记协议（YAYA-CHAT-BIND0）。
 *
 * 本模块只发布**可序列化**的增量接口声明与纯判定函数：
 * - 不创建 Next route、不装配服务、不调用模型 / 数据库 / 对象存储 / 检索；
 * - 不修改冻结的 `types.ts` / `api-contract.ts` / `storage-types.ts`，只复用
 *   已发布类型与判定：`YayaMessageSourceRef`、`YayaChatMessageProjection`、
 *   `YayaPlannedOperation`、`YayaOperationQueryOutcome`、`YAYA_API_PATHS`、
 *   `findSecretFields`、`isYayaDigestHexWire`、`YayaApiParseResult`；
 * - 运行时落地归唯一 owner：助手消息服务端绑定由 AGENT-APP1 实现，
 *   消息行绑定字段 / 投影接线 / 恢复标记投影由 DATA1 实现，UI1 只消费。
 *   本模块与本轮交付**不宣称**运行时漏洞已关闭。
 *
 * 两条最小接口：
 * 1. 可信来源绑定：助手消息正文的来源依赖只能由服务端从 run 记录继承，
 *    客户端自报的 `sources` / `independently_readable` / 模型最终引用都不算数；
 *    无法完整核验绑定的消息保持 unknown / 受限，不回填为可信。
 * 2. 原身份恢复标记：只带“重新 GET 原查询所需身份”，不是批准，
 *    不含会话令牌 / 密码 / 客户端 Principal；owner 先于角色。
 *
 * CHAT-BIND0-R1（主评审三个 P1 + 路径 P2 收紧）：
 * - 混合依赖（已映射 + 未映射）一律 `unknown`，已映射部分不能让绑定保持 `bound`；
 * - 回执本体按**标记派生的原计划**用冻结 `queryOperationOutcome` 重算，
 *   不信任事实里自带的结论，也不从回执反建 expected；
 * - 同 operation 的事实分组全量核验，判定与遍历顺序无关；标记 operation_id /
 *   item_key 唯一，重复不产生重复结果；
 * - 恢复清单的路径身份 `encodeURIComponent`，查询值保持独立参数交 URLSearchParams。
 *
 * 浏览器消费边界：UI1 可直接打包（esbuild platform=browser），
 * 不得引入 `node:` / Next / 数据库 / 模型模块。
 */
import { z } from "zod";

import {
  findSecretFields,
  isYayaDigestHexWire,
  YAYA_API_PATHS,
  type YayaApiParseResult,
  type YayaApiViolation,
} from "./api-contract";
import {
  queryOperationOutcome,
  type YayaChatMessageProjection,
  type YayaMessageSourceRef,
  type YayaOperationQueryOutcome,
  type YayaOperationReceipt,
  type YayaPlannedOperation,
} from "./types";

/** 增量协议版本：只在本模块内自洽，不改动 yaya-v1.0 冻结版本号 */
export const YAYA_CHAT_BIND_VERSION = "yaya-chat-bind-v1" as const;

/** 恢复标记种类：服务端投影给浏览器，浏览器只做结构核验，不据此授权 */
export const YAYA_RECOVERY_MARK_KIND = "yaya-recovery-v1" as const;

/** 助手（含工具）消息的唯一服务端写入 owner；UI1 不再 append 该类消息 */
export const YAYA_ASSISTANT_MESSAGE_WRITER = "AGENT-APP1" as const;

/* ------------------------------- 消息写入 owner ------------------------------- */

export type YayaMessageWriteChannel = "http" | "run_terminal";
export type YayaChatBindRole = "user" | "assistant" | "tool";
export type YayaMessageWriter = "UI1" | "AGENT-APP1";

export type YayaMessageWriteVerdict =
  | { accepted: true; writer: YayaMessageWriter }
  | { accepted: false; reason: "assistant_write_requires_server_channel" | "user_write_requires_client_channel" };

/**
 * 助手消息唯一写入 owner 的可执行口径：HTTP 只写 user，run 终态只写
 * assistant / tool，两条通道对同一角色恰好一个放行。
 *
 * **能力边界（R1 收紧）**：本函数只判定“谁有资格写”，是互斥能力声明；
 * 它**不能**证明重复落账在协议层不可能 —— 同一允许通道仍可被调用两次。
 * 幂等靠确定性消息身份 + 现有 `client_message_id` 约束（见交付文档 §2.4）。
 * 本函数只判定写入权，不校验内容；内容与 run 的绑定由服务端核验。
 */
export function authorizeYayaMessageWrite(input: {
  readonly channel: YayaMessageWriteChannel;
  readonly role: YayaChatBindRole;
}): YayaMessageWriteVerdict {
  if (input.channel === "http") {
    return input.role === "user"
      ? { accepted: true, writer: "UI1" }
      : { accepted: false, reason: "assistant_write_requires_server_channel" };
  }
  return input.role === "user"
    ? { accepted: false, reason: "user_write_requires_client_channel" }
    : { accepted: true, writer: YAYA_ASSISTANT_MESSAGE_WRITER };
}

/* ------------------------------- 可信来源绑定 ------------------------------- */

/**
 * 服务端来源绑定：
 * - `bound`：run 记录可完整核验，`dependencies` 是整段答案继承的资源级累计依赖；
 *   `general_qa_proven` 表示服务端已证明整段无私域依赖且依赖集合为空。
 * - `unknown`：依赖缺失 / 损坏 / 失联 / 无法完整核验（含混合集合里的未映射条目）；保持受限，不回填可信。
 */
export type YayaRunSourceBinding =
  | {
      readonly state: "bound";
      readonly dependencies: readonly YayaMessageSourceRef[];
      readonly general_qa_proven: boolean;
    }
  | { readonly state: "unknown" };

export interface YayaRunSourceBindingInput {
  /** run 记录中可表达为资源级来源的累计依赖；null = 无法完整核验（损坏 / 失联 / 映射不全） */
  readonly resource_dependencies: readonly YayaMessageSourceRef[] | null;
  /** run 记录中无法表达为资源级来源的依赖条目数（图片 / 历史片段 / 工具引用）；必须是有限非负整数 */
  readonly unmapped_dependency_count: number;
  /** 服务端已证明整段无私域依赖；依赖集合非空或存在未映射依赖时必须为 false */
  readonly private_dependency_proven_absent: boolean;
}

/**
 * run 记录 → 来源绑定（AGENT-APP1 落地）。
 * 模型最终引用（outcome.sources）不是本函数的入参：引用只做展示，
 * 既不能替代依赖，也不能因缺引用而缩小依赖。
 *
 * R1：依赖完整性按**整段**判定 —— 只要存在任一未映射 / 无法核验的依赖条目，
 * 或计数本身非法（负数 / 小数 / 非有限数），整段绑定即 `unknown`；
 * 已映射的可读来源不能让混合集合保持 `bound`，
 * `independently_readable:false` 也不能替代依赖完整性。
 */
export function buildYayaRunSourceBinding(input: YayaRunSourceBindingInput): YayaRunSourceBinding {
  if (input.resource_dependencies === null) return { state: "unknown" };
  const unmapped = input.unmapped_dependency_count;
  if (!Number.isFinite(unmapped) || !Number.isInteger(unmapped) || unmapped < 0) {
    return { state: "unknown" };
  }
  if (unmapped > 0) return { state: "unknown" };
  const dependencies = [...input.resource_dependencies];
  const generalQaProven = input.private_dependency_proven_absent && dependencies.length === 0;
  return { state: "bound", dependencies, general_qa_proven: generalQaProven };
}

/** 落库 / 渲染用的片段策略：来源整段继承，独立可读必须由服务端证明 */
export interface YayaAssistantFragmentPolicy {
  readonly binding_state: "bound" | "unknown";
  readonly sources: readonly YayaMessageSourceRef[];
  readonly independently_readable: boolean;
}

export function resolveYayaAssistantFragmentPolicy(
  binding: YayaRunSourceBinding,
): YayaAssistantFragmentPolicy {
  if (binding.state === "unknown") {
    return { binding_state: "unknown", sources: [], independently_readable: false };
  }
  return {
    binding_state: "bound",
    sources: binding.dependencies,
    independently_readable: binding.general_qa_proven && binding.dependencies.length === 0,
  };
}

/**
 * 读侧兜底（DATA1 在 `projectChatMessage` 之后、正文 / provenance 投影之前调用）：
 * - user 消息不适用（原输入属于 owner 本人，无 run 绑定）；
 * - 未知绑定，或“无可信依赖且未证明独立”的整段正文 → 片段降级 `hidden/source_unavailable`，
 *   消息 `visibility` 降级 `unavailable`；正文与 provenance 由 DATA1 现有函数按
 *   非 full 一律置空，派生标题随之走通用标题；
 * - 附件不在此处理，继续消费 MEDIA / DATA 现有边界。
 * 幂等：重复调用结果不变；owner 不匹配的 hidden 保持原样。
 */
export function restrictYayaAssistantProjection(
  projection: YayaChatMessageProjection,
  input: { readonly role: YayaChatBindRole; readonly policy: YayaAssistantFragmentPolicy },
): YayaChatMessageProjection {
  if (input.role === "user") return projection;
  const untrusted =
    input.policy.binding_state === "unknown" ||
    (input.policy.independently_readable === false && input.policy.sources.length === 0);
  if (!untrusted) return projection;
  const fragments = projection.fragments.map((fragment) =>
    fragment.visibility === "hidden"
      ? fragment
      : { ...fragment, visibility: "hidden" as const, reason: "source_unavailable" as const },
  );
  return { ...projection, visibility: "unavailable", fragments };
}

/* ------------------------------- 原身份恢复标记 ------------------------------- */

export interface YayaRecoveryOperationIdentity {
  readonly operation_id: string;
  readonly item_key: string;
  readonly target_id: string;
  /** 提案条目内容摘要（服务端计算；浏览器只校验格式与一致性） */
  readonly content_digest: string;
}

/**
 * 浏览器安全、非授权的恢复标记：只够重新 GET 原投影 / 原回执。
 * 不含批准、会话令牌、密码、客户端 Principal / 角色 / scope。
 * `owner_account_id` 只用于身份核对（owner 先于角色），不构成读取授权。
 */
export interface YayaChatRecoveryMark {
  readonly mark: "yaya-recovery-v1";
  readonly conversation_id: string;
  readonly owner_account_id: string;
  /** 回执核验所需的提交者身份；由服务端填入，不是客户端自报 */
  readonly actor_account_id: string;
  readonly run: { readonly run_id: string; readonly client_request_id: string } | null;
  readonly proposal: { readonly proposal_id: string; readonly batch_id: string } | null;
  readonly operations: readonly YayaRecoveryOperationIdentity[];
}

const nonBlankString = z.string().refine((value) => value.trim().length !== 0, "不能为空白字符串");

const yayaRecoveryMarkSchema: z.ZodType<YayaChatRecoveryMark> = z
  .strictObject({
    mark: z.literal(YAYA_RECOVERY_MARK_KIND),
    conversation_id: nonBlankString,
    owner_account_id: nonBlankString,
    actor_account_id: nonBlankString,
    run: z
      .strictObject({ run_id: nonBlankString, client_request_id: nonBlankString })
      .nullable(),
    proposal: z
      .strictObject({ proposal_id: nonBlankString, batch_id: nonBlankString })
      .nullable(),
    operations: z.array(
      z.strictObject({
        operation_id: nonBlankString,
        item_key: nonBlankString,
        target_id: nonBlankString,
        content_digest: z.string().refine(isYayaDigestHexWire, "content_digest 必须是 64 位十六进制"),
      }),
    ),
  })
  .superRefine((value, ctx) => {
    if (value.operations.length > 0 && value.proposal === null) {
      ctx.addIssue({ code: "custom", path: ["proposal"], message: "带操作身份的标记必须同时带提案身份" });
    }
    // R1：标记内 operation_id / item_key 必须唯一，重复身份不得产生重复结果
    const seenOperations = new Set<string>();
    const seenItems = new Set<string>();
    value.operations.forEach((operation, index) => {
      if (seenOperations.has(operation.operation_id)) {
        ctx.addIssue({ code: "custom", path: ["operations", index, "operation_id"], message: "operation_id 必须唯一" });
      }
      if (seenItems.has(operation.item_key)) {
        ctx.addIssue({ code: "custom", path: ["operations", index, "item_key"], message: "item_key 必须唯一" });
      }
      seenOperations.add(operation.operation_id);
      seenItems.add(operation.item_key);
    });
  });

/**
 * 标记解析（服务端投影 → 浏览器）：严格对象拒绝一切未知字段
 * （`principal` / `role` / `approved` / `scope` 等自报权威字段直接 malformed），
 * 秘密字段扫描沿用 API0 的 `findSecretFields`。
 */
export function parseYayaChatRecoveryMark(input: unknown): YayaApiParseResult<YayaChatRecoveryMark> {
  const violations: YayaApiViolation[] = [];
  for (const path of findSecretFields(input)) {
    violations.push({
      code: "secret_field_present",
      path,
      message: "恢复标记不含密码 / 令牌等秘密字段。",
    });
  }
  const parsed = yayaRecoveryMarkSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const where = issue.path.map((segment) => String(segment)).join(".");
      violations.push({
        code: "malformed_request",
        path: where === "" ? "mark" : where,
        message: issue.message || "字段不符合协议",
      });
    }
    return { ok: false, violations };
  }
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, value: parsed.data };
}

export const YAYA_RECOVERY_UNVERIFIABLE_REASONS = [
  "owner_mismatch",
  "conversation_mismatch",
  "run_missing",
  "run_mismatch",
  "operation_missing",
  "operation_mismatch",
  "actor_mismatch",
  "target_mismatch",
  "content_mismatch",
  "contradictory_receipt",
] as const;
export type YayaRecoveryUnverifiableReason = (typeof YAYA_RECOVERY_UNVERIFIABLE_REASONS)[number];

/** 服务端按原身份查回的事实（查询失败 / 查无 => 该条目直接缺省，不产生新身份） */
export interface YayaRecoveryOperationFacts {
  readonly planned: YayaPlannedOperation;
  readonly content_digest: string;
  /** 原 `operation_id` 查询返回的回执本体；结论由核验方按原计划重算，不采信自带结论 */
  readonly receipts: readonly YayaOperationReceipt[];
}

export interface YayaRecoveryFacts {
  readonly conversation_id: string;
  readonly owner_account_id: string;
  readonly run: { readonly run_id: string; readonly client_request_id: string } | null;
  readonly operations: readonly YayaRecoveryOperationFacts[];
}

export type YayaRecoveryVerdict =
  | { readonly verifiable: true; readonly outcomes: readonly YayaOperationQueryOutcome[] }
  | { readonly verifiable: false; readonly reason: YayaRecoveryUnverifiableReason };

function unverifiable(reason: YayaRecoveryUnverifiableReason): YayaRecoveryVerdict {
  return { verifiable: false, reason };
}

/** 判定与遍历顺序无关：多个原因同时出现时按原因枚举的固定次序取最优先 */
function pickReason(
  current: YayaRecoveryUnverifiableReason | null,
  candidate: YayaRecoveryUnverifiableReason,
): YayaRecoveryUnverifiableReason {
  if (current === null) return candidate;
  return YAYA_RECOVERY_UNVERIFIABLE_REASONS.indexOf(current) <=
    YAYA_RECOVERY_UNVERIFIABLE_REASONS.indexOf(candidate)
    ? current
    : candidate;
}

function markOperationIdentitiesUnique(mark: YayaChatRecoveryMark): boolean {
  const operations = new Set<string>();
  const items = new Set<string>();
  for (const operation of mark.operations) {
    if (operations.has(operation.operation_id) || items.has(operation.item_key)) return false;
    operations.add(operation.operation_id);
    items.add(operation.item_key);
  }
  return true;
}

/** 单条事实 ↔ 标记派生的原计划：逐字段核对，原因词汇与冻结判定同一口径 */
function operationFactMismatch(
  entry: YayaRecoveryOperationFacts,
  expected: YayaPlannedOperation,
  contentDigest: string,
): YayaRecoveryUnverifiableReason | null {
  const planned = entry.planned;
  if (
    planned.proposal_id !== expected.proposal_id ||
    planned.batch_id !== expected.batch_id ||
    planned.item_key !== expected.item_key ||
    planned.operation_id !== expected.operation_id
  ) {
    return "operation_mismatch";
  }
  if (planned.actor_account_id !== expected.actor_account_id) return "actor_mismatch";
  if (planned.target_id !== expected.target_id) return "target_mismatch";
  if (entry.content_digest !== contentDigest) return "content_mismatch";
  return null;
}

/** 冻结判定给出 `identity_mismatch` 后的精确诊断（operation_id 已在调用前过滤） */
function diagnoseReceiptIdentityMismatch(
  receipts: readonly YayaOperationReceipt[],
  expected: YayaPlannedOperation,
): YayaRecoveryUnverifiableReason {
  for (const receipt of receipts) {
    if (receipt.actor_account_id !== expected.actor_account_id) return "actor_mismatch";
    if (receipt.target_id !== expected.target_id) return "target_mismatch";
  }
  return "operation_mismatch";
}

/**
 * 标记 ↔ 服务端事实的身份核验（owner 先于角色；本函数没有 role 入参）。
 *
 * R1 口径：
 * 1. 原计划只由**标记**派生，不从回执 / 事实反建 expected（调用方无法自证）；
 * 2. 回执本体用冻结 `queryOperationOutcome` 按原计划重算，事实里自带的结论不采信；
 *    `unknown/identity_mismatch` → 不可核验并精确诊断，`unknown/contradictory_receipts`
 *    → 不可核验；`invalid_success_proof` / `no_receipt` / `verification_required`
 *    以及 `unchanged` / `saved_detail_unavailable` / `in_progress` / `failed` / `conflict`
 *    按冻结语义原样返回（不新增第六种 run 状态）；
 * 3. 同 operation 的事实先分组，组内每条都核对，矛盾拒绝且与遍历顺序无关；
 *    完全相同的重复事实 / 重复回执规范为一个结果；
 * 4. 标记 operation_id / item_key 唯一，否则不可核验（不产生重复结果）。
 * 任一身份不一致或回执矛盾都保持不可核验；只返回原查询结论，不新建任何身份。
 */
export function verifyYayaRecoveryIdentity(
  mark: YayaChatRecoveryMark,
  facts: YayaRecoveryFacts,
): YayaRecoveryVerdict {
  if (facts.owner_account_id !== mark.owner_account_id) return unverifiable("owner_mismatch");
  if (facts.conversation_id !== mark.conversation_id) return unverifiable("conversation_mismatch");
  if (mark.run !== null) {
    if (facts.run === null) return unverifiable("run_missing");
    if (
      facts.run.run_id !== mark.run.run_id ||
      facts.run.client_request_id !== mark.run.client_request_id
    ) {
      return unverifiable("run_mismatch");
    }
  }
  if (!markOperationIdentitiesUnique(mark)) return unverifiable("operation_mismatch");

  const factsByOperation = new Map<string, YayaRecoveryOperationFacts[]>();
  for (const entry of facts.operations) {
    const bucket = factsByOperation.get(entry.planned.operation_id);
    if (bucket === undefined) factsByOperation.set(entry.planned.operation_id, [entry]);
    else bucket.push(entry);
  }

  const outcomes: YayaOperationQueryOutcome[] = [];
  for (const operation of mark.operations) {
    if (mark.proposal === null) return unverifiable("operation_mismatch");
    const group = factsByOperation.get(operation.operation_id);
    if (group === undefined) return unverifiable("operation_missing");

    const expected: YayaPlannedOperation = {
      batch_id: mark.proposal.batch_id,
      proposal_id: mark.proposal.proposal_id,
      item_key: operation.item_key,
      operation_id: operation.operation_id,
      target_id: operation.target_id,
      actor_account_id: mark.actor_account_id,
    };

    let identityReason: YayaRecoveryUnverifiableReason | null = null;
    const receipts: YayaOperationReceipt[] = [];
    for (const entry of group) {
      const reason = operationFactMismatch(entry, expected, operation.content_digest);
      if (reason !== null) identityReason = pickReason(identityReason, reason);
      for (const receipt of entry.receipts) {
        if (receipt.operation_id !== expected.operation_id) {
          identityReason = pickReason(identityReason, "operation_mismatch");
        } else {
          receipts.push(receipt);
        }
      }
    }
    if (identityReason !== null) return unverifiable(identityReason);

    const outcome = queryOperationOutcome(receipts, expected);
    if (outcome.kind === "unknown") {
      if (outcome.reason === "identity_mismatch") {
        return unverifiable(diagnoseReceiptIdentityMismatch(receipts, expected));
      }
      if (outcome.reason === "contradictory_receipts") {
        return unverifiable("contradictory_receipt");
      }
    }
    outcomes.push(outcome);
  }
  return { verifiable: true, outcomes };
}

/* ------------------------------- 恢复只读路径 ------------------------------- */

/**
 * 恢复可用路径：历史投影、原运行、原回执查询与提案投影；模板直接引用 API0
 * 冻结常量（proposals 为冻结 `approval` 路径的父路径，由检查项锁定），
 * 保证发起 / 执行 / 批准三个写路径不可能混入。
 */
export const YAYA_RECOVERY_PATHS = {
  messages: "/api/yaya/conversations/{conversation_id}/messages",
  run_lookup: YAYA_API_PATHS.run_lookup,
  operations_query: YAYA_API_PATHS.operations_query,
  /** 提案投影读取（pending proposal-only 消息按 proposal_id 恢复可核对内容） */
  proposals_query: `${YAYA_API_PATHS.approval.replace("/{proposal_id}/approval", "")}?proposal_id={proposal_id}`,
} as const;

export interface YayaRecoveryRequest {
  readonly method: "GET";
  readonly path: string;
  /** 独立参数原值（不做路径编码）；消费方必须用 URLSearchParams 拼接 */
  readonly query: Readonly<Record<string, string>>;
}

function replacePlaceholder(
  template: string,
  vars: Readonly<Record<string, string>>,
  encode: boolean,
): string {
  return template.replace(/\{([a-z_]+)\}/g, (whole, name: string) => {
    const value = vars[name];
    if (value === undefined) return whole;
    return encode ? encodeURIComponent(value) : value;
  });
}

function buildRecoveryRequest(
  template: string,
  vars: Readonly<Record<string, string>>,
): YayaRecoveryRequest {
  const [pathTemplate, queryTemplate] = template.split("?");
  const query: Record<string, string> = {};
  if (queryTemplate !== undefined) {
    for (const pair of queryTemplate.split("&")) {
      if (pair === "") continue;
      const [key, value] = pair.split("=");
      query[decodeURIComponent(key)] = replacePlaceholder(decodeURIComponent(value ?? ""), vars, false);
    }
  }
  // 路径变量按原身份编码，保留字符不得改变目标路径（R1 / P2）
  return { method: "GET", path: replacePlaceholder(pathTemplate, vars, true), query };
}

/**
 * 标记 → 只读查询清单：历史 GET、原运行 GET、提案投影 GET、逐原操作 GET。
 * 不含 POST：不重新发起 run、不执行旧批准、不产生业务写。
 */
export function yayaRecoveryLookupRequests(
  mark: YayaChatRecoveryMark,
): readonly YayaRecoveryRequest[] {
  const requests: YayaRecoveryRequest[] = [
    buildRecoveryRequest(YAYA_RECOVERY_PATHS.messages, { conversation_id: mark.conversation_id }),
  ];
  if (mark.run !== null) {
    requests.push(
      buildRecoveryRequest(YAYA_RECOVERY_PATHS.run_lookup, {
        conversation_id: mark.conversation_id,
        client_request_id: mark.run.client_request_id,
      }),
    );
  }
  if (mark.proposal !== null) {
    requests.push(
      buildRecoveryRequest(YAYA_RECOVERY_PATHS.proposals_query, {
        proposal_id: mark.proposal.proposal_id,
      }),
    );
  }
  const seen = new Set<string>();
  for (const operation of mark.operations) {
    if (seen.has(operation.operation_id)) continue;
    seen.add(operation.operation_id);
    requests.push(
      buildRecoveryRequest(YAYA_RECOVERY_PATHS.operations_query, {
        operation_id: operation.operation_id,
      }),
    );
  }
  return requests;
}
