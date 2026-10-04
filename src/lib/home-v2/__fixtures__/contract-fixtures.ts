import { FIXTURE_CLASS_IDS } from "../../accounts/__fixtures__/contract-fixtures";
import type { HomeObservationSummary, HomeV2Data } from "../types";

/**
 * 首页 v2 契约 fixture：纯数据，不写数据库、不调用模型、不冒充真实认证。
 *
 * 覆盖：未登录、教师（多班/重叠）、管理员、空分配、身份服务不可用。
 * 断言由 `scripts/check-auth-contract.ts` 完成，标记 reference_only。
 * 注意：所有 DTO 都不包含密码、会话令牌或按班级裁剪前的全园数据。
 */

export const FIXTURE_HOME_CLASS_SUNFLOWER = {
  class_id: FIXTURE_CLASS_IDS.sunflower,
  name: "向日葵班",
  stage: "small",
  school_year: "2026-2027",
  is_active: true,
  child_count: 3,
  pending_count: 1,
  confirmation_count: 1,
} as const;

export const FIXTURE_HOME_CLASS_TULIP = {
  class_id: FIXTURE_CLASS_IDS.tulip,
  name: "郁金香班",
  stage: "middle",
  school_year: "2026-2027",
  is_active: true,
  child_count: 3,
  pending_count: 0,
  confirmation_count: 0,
} as const;

export const FIXTURE_HOME_CLASS_DAISY = {
  class_id: FIXTURE_CLASS_IDS.daisy,
  name: "蒲公英班",
  stage: "large",
  school_year: "2026-2027",
  is_active: true,
  child_count: 3,
  pending_count: 0,
  confirmation_count: 0,
} as const;

export const FIXTURE_HOME_PENDING_OBSERVATION: HomeObservationSummary = {
  observation_id: "0b5e0000-0000-4000-8000-0000000000a1",
  child_id: "a1c10000-0000-4000-8000-0000000000c3",
  child_name: "糖糖",
  class_id: FIXTURE_CLASS_IDS.sunflower,
  class_label: "小班 · 向日葵班",
  stage: "small",
  observed_at: "2026-09-29",
  created_at: "2026-09-29T08:30:00.000Z",
  context: "区域活动",
  excerpt: "糖糖把三块长积木并排搭成小桥，桥上放了一个小汽车，桥没有倒。",
  status: "ai_organized",
  is_demo: true,
};

export const FIXTURE_HOME_RECENT_OBSERVATION: HomeObservationSummary = {
  observation_id: "0b5e0000-0000-4000-8000-0000000000a2",
  child_id: "a1c10000-0000-4000-8000-0000000000c4",
  child_name: "果果",
  class_id: FIXTURE_CLASS_IDS.tulip,
  class_label: "中班 · 郁金香班",
  stage: "middle",
  observed_at: "2026-09-28",
  created_at: "2026-09-28T09:10:00.000Z",
  context: "户外活动",
  excerpt: "果果主动把秋千让给排队的小朋友，并说“你先玩，我等一下”。",
  status: "confirmed",
  is_demo: true,
};

/**
 * 无权查看或档案不可用的幼儿：显式 null，不是占位文案，
 * 更不允许前端用当前登录账号或备注补造。
 */
export const FIXTURE_HOME_MASKED_CHILD_OBSERVATION: HomeObservationSummary = {
  observation_id: "0b5e0000-0000-4000-8000-0000000000a3",
  child_id: "a1c10000-0000-4000-8000-0000000000c5",
  child_name: null,
  class_id: null,
  class_label: null,
  stage: null,
  observed_at: "2026-09-27",
  created_at: "2026-09-27T07:50:00.000Z",
  context: null,
  excerpt: "历史只读投影：不携带跨班证据详情。",
  status: "confirmed",
  is_demo: true,
};

export const FIXTURE_HOME_LOGGED_OUT: HomeV2Data = {
  viewer: { kind: "logged_out" },
  scope: null,
  class_groups: [],
  primary_action: {
    code: "login",
    label: "教师登录",
    href: "/login",
    helper: "登录后查看你负责的班级与观察记录。",
  },
  pending_count: 0,
  pending: [],
  recent: [],
  notices: [],
};

export const FIXTURE_HOME_TEACHER_A: HomeV2Data = {
  viewer: { kind: "teacher", display_name: "李老师" },
  scope: {
    kind: "classes",
    label: "向日葵班、郁金香班",
    class_count: 2,
    child_count: 6,
  },
  class_groups: [
    { stage: "small", stage_label: "小班", classes: [{ ...FIXTURE_HOME_CLASS_SUNFLOWER }] },
    { stage: "middle", stage_label: "中班", classes: [{ ...FIXTURE_HOME_CLASS_TULIP }] },
  ],
  primary_action: {
    code: "process_confirmations",
    label: "去处理待确认",
    href: "/observations?status=ai_organized",
    helper: "整理好的观察，等你核对。",
  },
  pending_count: 1,
  pending: [FIXTURE_HOME_PENDING_OBSERVATION],
  recent: [FIXTURE_HOME_RECENT_OBSERVATION],
  notices: [],
};

export const FIXTURE_HOME_TEACHER_EMPTY: HomeV2Data = {
  viewer: { kind: "teacher", display_name: "赵老师" },
  scope: { kind: "classes", label: "暂无班级", class_count: 0, child_count: 0 },
  class_groups: [],
  primary_action: {
    code: "await_class_assignment",
    label: "等待班级分配",
    href: "/",
    helper: "你还没有被分配班级，请联系管理员安排任教班级。",
  },
  pending_count: 0,
  pending: [],
  recent: [],
  notices: [
    {
      code: "scope_empty",
      severity: "warning",
      message: "当前账号没有任教的班级，暂时不能查看或记录幼儿信息。",
    },
  ],
};

export const FIXTURE_HOME_ADMIN: HomeV2Data = {
  viewer: { kind: "admin", display_name: "园所管理员" },
  scope: { kind: "school", label: "全园", class_count: 3, child_count: 9 },
  class_groups: [
    { stage: "small", stage_label: "小班", classes: [{ ...FIXTURE_HOME_CLASS_SUNFLOWER }] },
    { stage: "middle", stage_label: "中班", classes: [{ ...FIXTURE_HOME_CLASS_TULIP }] },
    { stage: "large", stage_label: "大班", classes: [{ ...FIXTURE_HOME_CLASS_DAISY }] },
  ],
  primary_action: {
    code: "manage_school",
    label: "管理全园",
    href: "/classes",
    helper: "管理班级、教师账号与任教分配。",
  },
  pending_count: 1,
  pending: [FIXTURE_HOME_PENDING_OBSERVATION],
  recent: [FIXTURE_HOME_RECENT_OBSERVATION, FIXTURE_HOME_MASKED_CHILD_OBSERVATION],
  notices: [],
};

export const FIXTURE_HOME_IDENTITY_UNAVAILABLE: HomeV2Data = {
  viewer: { kind: "identity_unavailable" },
  scope: null,
  class_groups: [],
  primary_action: {
    code: "retry",
    label: "重新加载",
    href: "/",
    helper: "身份服务暂时不可用，未加载任何园所数据，请稍后重试。",
  },
  pending_count: 0,
  pending: [],
  recent: [],
  notices: [
    {
      code: "identity_unavailable",
      severity: "error",
      message: "身份服务暂时不可用，为保护数据安全，首页不展示任何园所信息。",
    },
  ],
};

export const FIXTURE_HOME_STATES: HomeV2Data[] = [
  FIXTURE_HOME_LOGGED_OUT,
  FIXTURE_HOME_TEACHER_A,
  FIXTURE_HOME_TEACHER_EMPTY,
  FIXTURE_HOME_ADMIN,
  FIXTURE_HOME_IDENTITY_UNAVAILABLE,
];
