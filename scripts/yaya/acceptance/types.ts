/**
 * YAYA-QA-SEED1 共享类型与标记常量（seed / verify / run 共用，避免循环依赖）。
 */
import type { ClassStage, ObservationStatus } from "../../../src/lib/types";
import type { SemesterPeriod } from "../../../src/lib/guide/types";

export const SYNTHETIC_MARK = "[合成]";
export const FAULT_MARK = "[故障夹具]";

export type SeedClassKey = "class_a" | "class_b" | "class_c" | "class_fault";
export type SeedAccountKey = "admin" | "teacher_a" | "teacher_b" | "teacher_c";
export type SeedChildKey =
  | "class_a_same_name"
  | "class_a_shared_photo"
  | "class_a_trusted_empty"
  | "class_b_same_name"
  | "class_b_shared_photo"
  | "class_b_draft"
  | "class_b_needs_input"
  | "class_b_ai_organized"
  | "class_c_transfer"
  | "fault_unreadable"
  | "fault_partial";
export type SeedObservationKey =
  | "a1_h1"
  | "a1_h2"
  | "a1_h3"
  | "a2_photo"
  | "a3_empty"
  | "b1_plain"
  | "b2_photo"
  | "b3_draft"
  | "b4_needs_input"
  | "b5_ai_organized"
  | "c1_old"
  | "c1_new"
  | "fault_unreadable"
  | "fault_partial";

export interface SeedClassRef {
  id: string;
  name: string;
  stage: ClassStage;
  school_year: string;
  is_fault_fixture: boolean;
}

export interface SeedChildRef {
  id: string;
  name: string;
  class_key: SeedClassKey;
  birth_date: string;
}

export interface SeedObservationRef {
  id: string;
  child_key: SeedChildKey;
  class_key: SeedClassKey;
  status: ObservationStatus;
  observed_at: string;
  raw_text: string;
}

export interface SeedAccountRef {
  account_id: string;
  username: string;
  display_name: string;
  role: "admin" | "teacher";
  current_class_keys: SeedClassKey[];
}

export interface AcceptanceSeedManifest {
  seed_id: string;
  generated_at: string;
  semester: SemesterPeriod;
  school_id: string;
  classes: Record<SeedClassKey, SeedClassRef>;
  accounts: Record<SeedAccountKey, SeedAccountRef>;
  children: Record<SeedChildKey, SeedChildRef>;
  observations: Record<SeedObservationKey, SeedObservationRef>;
  guide_items: {
    behavior_item_id: string;
    sustained_item_id: string;
    health_reference_item_id: string;
  };
  conversations: {
    teacher_a_scenario: { conversation_id: string; restricted_title: string };
    teacher_b_private: { conversation_id: string };
  };
  media: {
    shared_photo: {
      attachment_id: string;
      object_key: string;
      source_checksum: string;
      linked_child_keys: SeedChildKey[];
      linked_observation_keys: SeedObservationKey[];
    };
  };
  fault_fixtures: {
    unreadable_child_key: SeedChildKey;
    partial_child_key: SeedChildKey;
    unreadable_observation_key: SeedObservationKey;
    partial_observation_key: SeedObservationKey;
    operation: {
      operation_id: string;
      proposal_id: string;
      batch_id: string;
      conversation_id: string;
      business_object_id: string;
      status: "saved_detail_unavailable";
    };
  };
}

export type SeedFailureStage = "after_resources" | "after_schema" | "after_seed";

export interface AcceptanceSeedOptions {
  /** 仅自检用：在指定阶段注入失败，验证失败路径同样精确清理自有资源 */
  failAt?: SeedFailureStage;
}

export interface VerificationCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface AcceptanceVerification {
  checks: VerificationCheck[];
  passed: number;
  failed: number;
}

export interface AcceptanceSeedHandle {
  seed_id: string;
  manifest: AcceptanceSeedManifest;
  verification: AcceptanceVerification;
  credentials_path: string;
  object_root: string;
  /** 仅程序内使用（浏览器 runner 需要把 DATABASE_URL 交给被测服务）；CLI 不打印 */
  database_url: string;
  teardown: () => Promise<void>;
}
