import { FIXTURE_CLASS_IDS } from "../../accounts/__fixtures__/contract-fixtures";
import type {
  HomeObservationSummary,
  HomePrimaryActionCode,
  HomeV2Data,
} from "../types";

/**
 * 首页 v2 契约 fixture（AUTH0-R1 返修候选）：纯数据，
 * 不写数据库、不调用模型、不冒充真实认证。
 *
 * 覆盖：未登录、教师（多班/重叠/转班历史）、管理员、空分配、无幼儿、无观察、
 * 数据读取失败、身份服务不可用；并给出“可操作待办”候选与服务器授权事实，
 * 由 `scripts/check-auth-contract.ts` 的参考算法过滤，标记 reference_only。
 * 所有 DTO 都不包含密码、会话令牌或按班级裁剪前的全园数据。
 */

export const FIXTURE_HOME_CLASS_SUNFLOWER = {
  class_id: FIXTURE_CLASS_IDS.sunflower,
  name: "向日葵班",
  stage: "small",
  school_year: "2026-2027",
  is_active: true,
  child_count: 3,
  confirmation_count: 1,
  supplement_count: 1,
  organize_count: 1,
} as const;

export const FIXTURE_HOME_CLASS_TULIP = {
  class_id: FIXTURE_CLASS_IDS.tulip,
  name: "郁金香班",
  stage: "middle",
  school_year: "2026-2027",
  is_active: true,
  child_count: 3,
  confirmation_count: 0,
  supplement_count: 1,
  organize_count: 0,
} as const;

export const FIXTURE_HOME_CLASS_DAISY = {
  class_id: FIXTURE_CLASS_IDS.daisy,
  name: "蒲公英班",
  stage: "large",
  school_year: "2026-2027",
  is_active: true,
  child_count: 3,
  confirmation_count: 1,
  supplement_count: 0,
  organize_count: 0,
} as const;

/* ------------------------------ 可操作待办候选 ------------------------------ */

/**
 * 候选观察 + 服务端授权事实。参考算法按状态映射动作
 * （ai_organized→确认、needs_input→组织/追问、draft→整理），
 * 再按当前会话授权决定是否进入“可操作待办”。
 */
export interface FixtureHomeCandidate {
  observation: HomeObservationSummary;
  /** 服务端读取的幼儿当前归属；客户端声明不作数 */
  child_current_class_id: string | null;
  /** 观察发生时班级 */
  observed_class_id: string | null;
}

export const FIXTURE_HOME_CANDIDATE_CONFIRM_SUNFLOWER: FixtureHomeCandidate = {
  observation: {
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
  },
  child_current_class_id: FIXTURE_CLASS_IDS.sunflower,
  observed_class_id: FIXTURE_CLASS_IDS.sunflower,
};

export const FIXTURE_HOME_CANDIDATE_SUPPLEMENT_TULIP: FixtureHomeCandidate = {
  observation: {
    observation_id: "0b5e0000-0000-4000-8000-0000000000a2",
    child_id: "a1c10000-0000-4000-8000-0000000000c4",
    child_name: "果果",
    class_id: FIXTURE_CLASS_IDS.tulip,
    class_label: "中班 · 郁金香班",
    stage: "middle",
    observed_at: "2026-09-28",
    created_at: "2026-09-28T09:10:00.000Z",
    context: "户外活动",
    excerpt: "果果在攀爬架前停了一会儿，说“我有点怕”，然后扶着扶手往上爬了两格。",
    status: "needs_input",
    is_demo: true,
  },
  child_current_class_id: FIXTURE_CLASS_IDS.tulip,
  observed_class_id: FIXTURE_CLASS_IDS.tulip,
};

export const FIXTURE_HOME_CANDIDATE_ORGANIZE_SUNFLOWER: FixtureHomeCandidate = {
  observation: {
    observation_id: "0b5e0000-0000-4000-8000-0000000000a3",
    child_id: "a1c10000-0000-4000-8000-0000000000c6",
    child_name: "石头",
    class_id: FIXTURE_CLASS_IDS.sunflower,
    class_label: "小班 · 向日葵班",
    stage: "small",
    observed_at: "2026-09-27",
    created_at: "2026-09-27T07:50:00.000Z",
    context: null,
    excerpt: "石头把积木按颜色分成三堆，又把红色的一堆推给旁边的小朋友。",
    status: "draft",
    is_demo: true,
  },
  child_current_class_id: FIXTURE_CLASS_IDS.sunflower,
  observed_class_id: FIXTURE_CLASS_IDS.sunflower,
};

/**
 * 转班幼儿在原班（向日葵班）的待确认观察：
 * 对原班教师 A 是历史只读，不得进入可操作待办；
 * 对当前负责的教师 B 可操作，且保留发生班级（小班 · 向日葵班）。
 */
export const FIXTURE_HOME_CANDIDATE_READONLY_HISTORY: FixtureHomeCandidate = {
  observation: {
    observation_id: "0b5e0000-0000-4000-8000-0000000000a4",
    child_id: "a1c10000-0000-4000-8000-0000000000c2",
    child_name: "童童",
    class_id: FIXTURE_CLASS_IDS.sunflower,
    class_label: "小班 · 向日葵班",
    stage: "small",
    observed_at: "2026-09-20",
    created_at: "2026-09-20T06:40:00.000Z",
    context: "集体活动",
    excerpt: "童童主动把绘本递给旁边的小朋友，并指着画面说“你看，这是小船”。",
    status: "ai_organized",
    is_demo: true,
  },
  child_current_class_id: FIXTURE_CLASS_IDS.daisy,
  observed_class_id: FIXTURE_CLASS_IDS.sunflower,
};

export const FIXTURE_HOME_CANDIDATES: FixtureHomeCandidate[] = [
  FIXTURE_HOME_CANDIDATE_CONFIRM_SUNFLOWER,
  FIXTURE_HOME_CANDIDATE_SUPPLEMENT_TULIP,
  FIXTURE_HOME_CANDIDATE_ORGANIZE_SUNFLOWER,
  FIXTURE_HOME_CANDIDATE_READONLY_HISTORY,
];

/** 教师 A（向日葵 + 郁金香）可操作待办期望：历史只读候选被排除 */
export const FIXTURE_HOME_TEACHER_A_EXPECTED_COUNTS = {
  confirmations: 1,
  supplements: 1,
  organizes: 1,
} as const;

/** 教师 B（郁金香 + 蒲公英，当前负责转班幼儿）可操作待办期望：含转入前历史 */
export const FIXTURE_HOME_TEACHER_B_EXPECTED_COUNTS = {
  confirmations: 1,
  supplements: 1,
  organizes: 0,
} as const;

/** 当前负责幼儿的转入前已确认观察：保留发生时班级 */
export const FIXTURE_HOME_PRIOR_CLASS_CONFIRMED: HomeObservationSummary = {
  observation_id: "0b5e0000-0000-4000-8000-0000000000a5",
  child_id: "a1c10000-0000-4000-8000-0000000000c2",
  child_name: "童童",
  class_id: FIXTURE_CLASS_IDS.sunflower,
  class_label: "小班 · 向日葵班",
  stage: "small",
  observed_at: "2026-09-18",
  created_at: "2026-09-18T08:05:00.000Z",
  context: "生活活动",
  excerpt: "童童自己系好鞋带，又帮助旁边的小朋友把外套挂到挂钩上。",
  status: "confirmed",
  is_demo: true,
};

/**
 * 无权查看或档案不可用的幼儿：显式 null，不是占位文案，
 * 更不允许前端用当前登录账号或备注补造。
 */
export const FIXTURE_HOME_MASKED_CHILD_OBSERVATION: HomeObservationSummary = {
  observation_id: "0b5e0000-0000-4000-8000-0000000000a6",
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

/* -------------------------------- 首页状态 -------------------------------- */

export const FIXTURE_HOME_LOGGED_OUT: HomeV2Data = {
  viewer: { kind: "logged_out" },
  scope: null,
  class_groups: [],
  primary_action: {
    code: "login",
    label: "园所账号登录",
    href: "/login",
    helper: "使用园所账号登录后，查看你负责的班级与观察记录。",
  },
  pending_counts: { availability: "available", confirmations: 0, supplements: 0, organizes: 0 },
  pending: [],
  recent: [],
  notices: [],
};

/** 教师 A：多班；可操作待办只含当前任教班级的记录，转班历史只读被排除 */
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
  pending_counts: {
    availability: "available",
    confirmations: FIXTURE_HOME_TEACHER_A_EXPECTED_COUNTS.confirmations,
    supplements: FIXTURE_HOME_TEACHER_A_EXPECTED_COUNTS.supplements,
    organizes: FIXTURE_HOME_TEACHER_A_EXPECTED_COUNTS.organizes,
  },
  pending: [
    FIXTURE_HOME_CANDIDATE_CONFIRM_SUNFLOWER.observation,
    FIXTURE_HOME_CANDIDATE_SUPPLEMENT_TULIP.observation,
    FIXTURE_HOME_CANDIDATE_ORGANIZE_SUNFLOWER.observation,
  ],
  recent: [FIXTURE_HOME_PRIOR_CLASS_CONFIRMED],
  notices: [],
};

/** 教师 B：当前负责转班幼儿，转入前历史可作为已授权摘要与可操作待办展示 */
export const FIXTURE_HOME_TEACHER_B: HomeV2Data = {
  viewer: { kind: "teacher", display_name: "王老师" },
  scope: {
    kind: "classes",
    label: "郁金香班、蒲公英班",
    class_count: 2,
    child_count: 6,
  },
  class_groups: [
    { stage: "middle", stage_label: "中班", classes: [{ ...FIXTURE_HOME_CLASS_TULIP }] },
    { stage: "large", stage_label: "大班", classes: [{ ...FIXTURE_HOME_CLASS_DAISY }] },
  ],
  primary_action: {
    code: "process_confirmations",
    label: "去处理待确认",
    href: "/observations?status=ai_organized",
    helper: "整理好的观察，等你核对。",
  },
  pending_counts: {
    availability: "available",
    confirmations: FIXTURE_HOME_TEACHER_B_EXPECTED_COUNTS.confirmations,
    supplements: FIXTURE_HOME_TEACHER_B_EXPECTED_COUNTS.supplements,
    organizes: FIXTURE_HOME_TEACHER_B_EXPECTED_COUNTS.organizes,
  },
  pending: [
    FIXTURE_HOME_CANDIDATE_SUPPLEMENT_TULIP.observation,
    FIXTURE_HOME_CANDIDATE_READONLY_HISTORY.observation,
  ],
  recent: [FIXTURE_HOME_PRIOR_CLASS_CONFIRMED],
  notices: [],
};

/** 未分配班级：不提供创建班级捷径 */
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
  pending_counts: { availability: "available", confirmations: 0, supplements: 0, organizes: 0 },
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

/** 已分配班级但没有幼儿：按权限提供建立成长档案入口 */
export const FIXTURE_HOME_TEACHER_NO_CHILDREN: HomeV2Data = {
  viewer: { kind: "teacher", display_name: "李老师" },
  scope: { kind: "classes", label: "向日葵班", class_count: 1, child_count: 0 },
  class_groups: [
    {
      stage: "small",
      stage_label: "小班",
      classes: [
        {
          ...FIXTURE_HOME_CLASS_SUNFLOWER,
          child_count: 0,
          confirmation_count: 0,
          supplement_count: 0,
          organize_count: 0,
        },
      ],
    },
  ],
  primary_action: {
    code: "create_profile",
    label: "建立第一个成长档案",
    href: "/children/new",
    helper: "先为班里的幼儿建立一份成长档案。",
  },
  pending_counts: { availability: "available", confirmations: 0, supplements: 0, organizes: 0 },
  pending: [],
  recent: [],
  notices: [
    {
      code: "empty_children",
      severity: "info",
      message: "这个班级还没有幼儿档案。",
    },
  ],
};

/** 有班级有幼儿但没有观察：真实零值 + 空观察提示，与读取失败严格区分 */
export const FIXTURE_HOME_TEACHER_NO_OBSERVATIONS: HomeV2Data = {
  viewer: { kind: "teacher", display_name: "李老师" },
  scope: { kind: "classes", label: "向日葵班", class_count: 1, child_count: 3 },
  class_groups: [
    {
      stage: "small",
      stage_label: "小班",
      classes: [
        {
          ...FIXTURE_HOME_CLASS_SUNFLOWER,
          confirmation_count: 0,
          supplement_count: 0,
          organize_count: 0,
        },
      ],
    },
  ],
  primary_action: {
    code: "start_observation",
    label: "开始记录",
    href: "/observations/new",
    helper: "记下看到的具体行为和语言。",
  },
  pending_counts: { availability: "available", confirmations: 0, supplements: 0, organizes: 0 },
  pending: [],
  recent: [],
  notices: [
    {
      code: "empty_observations",
      severity: "info",
      message: "还没有观察记录，从一次真实的观察开始。",
    },
  ],
};

/** 管理员：全园只读；管理员没有教学操作权限，可操作待办为 0 */
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
  pending_counts: { availability: "available", confirmations: 0, supplements: 0, organizes: 0 },
  pending: [],
  recent: [FIXTURE_HOME_PRIOR_CLASS_CONFIRMED, FIXTURE_HOME_MASKED_CHILD_OBSERVATION],
  notices: [],
};

/** 数据读取失败：数量为 null（未获取），不得显示为普通 0 或空数据 */
export const FIXTURE_HOME_DATA_UNAVAILABLE: HomeV2Data = {
  viewer: { kind: "teacher", display_name: "李老师" },
  scope: { kind: "classes", label: "向日葵班、郁金香班", class_count: null, child_count: null },
  class_groups: [],
  primary_action: {
    code: "retry",
    label: "重新加载",
    href: "/",
    helper: "班级与观察数据暂时读取失败，未展示任何数字，请稍后重试。",
  },
  pending_counts: {
    availability: "unavailable",
    confirmations: null,
    supplements: null,
    organizes: null,
  },
  pending: [],
  recent: [],
  notices: [
    {
      code: "data_unavailable",
      severity: "error",
      message: "班级与观察数据读取失败，页面未展示任何统计数字。",
    },
  ],
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
  pending_counts: {
    availability: "unavailable",
    confirmations: null,
    supplements: null,
    organizes: null,
  },
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
  FIXTURE_HOME_TEACHER_B,
  FIXTURE_HOME_TEACHER_EMPTY,
  FIXTURE_HOME_TEACHER_NO_CHILDREN,
  FIXTURE_HOME_TEACHER_NO_OBSERVATIONS,
  FIXTURE_HOME_ADMIN,
  FIXTURE_HOME_DATA_UNAVAILABLE,
  FIXTURE_HOME_IDENTITY_UNAVAILABLE,
];

/* ------------------------------ 主行动优先级 ------------------------------ */

export interface FixturePrimaryActionCase {
  name: string;
  viewer: "teacher" | "admin";
  /** null=数据读取失败（未获取） */
  counts: { confirmations: number; supplements: number; organizes: number } | null;
  class_count: number;
  child_count: number;
  expected: HomePrimaryActionCode;
}

/** 单一主行动：待确认 → 待补充 → 待整理 → 建档 / 新记录；未分配不提供建班捷径 */
export const FIXTURE_PRIMARY_ACTION_CASES: FixturePrimaryActionCase[] = [
  {
    name: "confirmations-first",
    viewer: "teacher",
    counts: { confirmations: 2, supplements: 3, organizes: 4 },
    class_count: 2,
    child_count: 6,
    expected: "process_confirmations",
  },
  {
    name: "supplements-second",
    viewer: "teacher",
    counts: { confirmations: 0, supplements: 3, organizes: 4 },
    class_count: 2,
    child_count: 6,
    expected: "supplement_observation",
  },
  {
    name: "organizes-third",
    viewer: "teacher",
    counts: { confirmations: 0, supplements: 0, organizes: 4 },
    class_count: 2,
    child_count: 6,
    expected: "organize_draft",
  },
  {
    name: "no-class-await-assignment",
    viewer: "teacher",
    counts: { confirmations: 0, supplements: 0, organizes: 0 },
    class_count: 0,
    child_count: 0,
    expected: "await_class_assignment",
  },
  {
    name: "class-without-children-create-profile",
    viewer: "teacher",
    counts: { confirmations: 0, supplements: 0, organizes: 0 },
    class_count: 1,
    child_count: 0,
    expected: "create_profile",
  },
  {
    name: "class-with-children-start-observation",
    viewer: "teacher",
    counts: { confirmations: 0, supplements: 0, organizes: 0 },
    class_count: 1,
    child_count: 3,
    expected: "start_observation",
  },
  {
    name: "data-unavailable-retry",
    viewer: "teacher",
    counts: null,
    class_count: 1,
    child_count: 3,
    expected: "retry",
  },
  {
    name: "admin-manage-school",
    viewer: "admin",
    counts: { confirmations: 2, supplements: 0, organizes: 0 },
    class_count: 3,
    child_count: 9,
    expected: "manage_school",
  },
];
