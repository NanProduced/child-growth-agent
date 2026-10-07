/**
 * 存储行 → DTO 的映射与 jsonb 解析助手（DATA1）。
 *
 * 解析原则：损坏/未知形状不猜测、不补默认值——由调用方转为保守投影
 * （unavailable/broken），绝不把损坏内容默认成 full。
 */
import type {
  YayaConversationView,
  YayaItemResourceRef,
  YayaStoredFragment,
} from "../storage-types";
import { YayaDataError } from "../storage-types";
import type { YayaMessageExecutionState, YayaMessageKind, YayaMessageRole } from "../storage-types";
import { conversationTitleSourceState } from "./invariants";

export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

export function isoRequired(value: Date | string): string {
  return new Date(value).toISOString();
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

export interface YayaConversationRow {
  id: string;
  account_id: string;
  title: string | null;
  title_source_fragments: unknown;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

export function parseStringArray(value: unknown): string[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

export function toConversationView(row: YayaConversationRow): YayaConversationView {
  const state = conversationTitleSourceState(row.title_source_fragments);
  const refs =
    state === "valid"
      ? [...(row.title_source_fragments as readonly string[])]
      : state === "none"
        ? []
        : null;
  return {
    conversation_id: row.id,
    owner_account_id: row.account_id,
    title: row.title,
    title_source_fragments: refs,
    revision: row.revision,
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
    deleted_at: iso(row.deleted_at),
  };
}

export interface YayaMessageRow {
  id: string;
  conversation_id: string;
  owner_account_id: string;
  client_message_id: string | null;
  client_digest: string | null;
  role: YayaMessageRole;
  message_kind: YayaMessageKind;
  fragments: unknown;
  attachment_ids: unknown;
  execution_state: YayaMessageExecutionState;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
  /** run 终态绑定（CHAT-BIND1）：旧消息 / user 消息为 NULL，读为 unknown */
  run_id: string | null;
  binding_state: string | null;
  /** 恢复标记 jsonb；损坏或缺失时投影为 null */
  recovery_mark: unknown;
}

function isSourceRefShaped(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "child") return typeof record.child_id === "string";
  if (record.kind === "class") return typeof record.class_id === "string";
  if (record.kind === "observation") return typeof record.observation_id === "string";
  return false;
}

const PROVENANCE_KINDS = [
  "raw_input",
  "child_fact",
  "teacher_supplement",
  "image_interpretation",
  "guide_catalog",
  "public_web",
  "tool_result",
  "model_text",
] as const;

function isProvenanceShaped(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string" || !(PROVENANCE_KINDS as readonly string[]).includes(record.kind)) {
    return false;
  }
  if (record.ref_id !== null && typeof record.ref_id !== "string") return false;
  if (record.label !== null && typeof record.label !== "string") return false;
  if (record.derived_from !== null && typeof record.derived_from !== "string") return false;
  return true;
}

function parseFragment(value: unknown): YayaStoredFragment | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.fragment_id !== "string" || record.fragment_id.trim() === "") return null;
  if (record.text !== null && typeof record.text !== "string") return null;
  if (!Array.isArray(record.sources) || record.sources.some((entry) => !isSourceRefShaped(entry))) {
    return null;
  }
  if (typeof record.independently_readable !== "boolean") return null;
  if (!isProvenanceShaped(record.provenance)) return null;
  return {
    fragment_id: record.fragment_id,
    text: (record.text as string | null) ?? null,
    sources: record.sources,
    independently_readable: record.independently_readable,
    provenance: record.provenance as YayaStoredFragment["provenance"],
  };
}

export interface ParsedStoredFragments {
  fragments: YayaStoredFragment[];
  corrupt: boolean;
}

/** 逐片段校验；任一片段损坏时整条消息按损坏处理（不默认 full） */
export function parseStoredFragments(value: unknown): ParsedStoredFragments {
  if (!Array.isArray(value)) return { fragments: [], corrupt: value !== null && value !== undefined };
  const fragments: YayaStoredFragment[] = [];
  for (const entry of value) {
    const parsed = parseFragment(entry);
    if (parsed === null) return { fragments: [], corrupt: true };
    fragments.push(parsed);
  }
  return { fragments, corrupt: false };
}

const RESOURCE_REF_KINDS = ["school", "class", "child", "transfer", "observation"] as const;

export function parseResourceRef(value: unknown): YayaItemResourceRef | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !(RESOURCE_REF_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  if (kind === "school") return { kind: "school" };
  if (kind === "class") {
    if (record.class_id === null) return { kind: "class", class_id: null };
    if (typeof record.class_id === "string") return { kind: "class", class_id: record.class_id };
    return null;
  }
  if (kind === "child") {
    return typeof record.child_id === "string" ? { kind: "child", child_id: record.child_id } : null;
  }
  if (kind === "transfer") {
    return typeof record.child_id === "string" && typeof record.target_class_id === "string"
      ? { kind: "transfer", child_id: record.child_id, target_class_id: record.target_class_id }
      : null;
  }
  return typeof record.observation_id === "string"
    ? { kind: "observation", observation_id: record.observation_id }
    : null;
}

export function serverError(message: string): YayaDataError {
  return new YayaDataError("server_error", message);
}
