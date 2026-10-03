import type { SemesterPeriod } from "@/lib/guide/types";

/**
 * 项目演示校历（显式配置）。
 *
 * 重要：这是“芽芽观察”项目自己的演示校历，不是全国统一学期，也不代表任何地方校历。
 * 学期起止只能来自本文件的显式配置：不得从日期、班级学年或学期名称推断。
 * 统计区间含首尾两天；时区语义统一为亚洲/上海日历日（isoDateInShanghai）。
 *
 * 调整演示校历只改本文件；读取统一走 @/lib/semester，不在其他模块内置学期日期。
 */
export const SEMESTER_CALENDAR_SOURCE = "yaya-demo-calendar";

/** 演示校历说明，界面需要注明学期口径时可展示 */
export const SEMESTER_CALENDAR_NOTE = "项目演示校历，不是全国统一学期";

export const CONFIGURED_SEMESTERS: SemesterPeriod[] = [
  {
    id: "2024-2025-1",
    school_year: "2024-2025",
    term: 1,
    label: "2024—2025学年第一学期（项目演示校历）",
    start_date: "2024-09-02",
    end_date: "2025-01-17",
  },
  {
    id: "2024-2025-2",
    school_year: "2024-2025",
    term: 2,
    label: "2024—2025学年第二学期（项目演示校历）",
    start_date: "2025-02-17",
    end_date: "2025-07-04",
  },
  {
    id: "2025-2026-1",
    school_year: "2025-2026",
    term: 1,
    label: "2025—2026学年第一学期（项目演示校历）",
    start_date: "2025-09-01",
    end_date: "2026-01-30",
  },
  {
    id: "2025-2026-2",
    school_year: "2025-2026",
    term: 2,
    label: "2025—2026学年第二学期（项目演示校历）",
    start_date: "2026-02-23",
    end_date: "2026-07-10",
  },
  {
    id: "2026-2027-1",
    school_year: "2026-2027",
    term: 1,
    label: "2026—2027学年第一学期（项目演示校历）",
    start_date: "2026-09-01",
    end_date: "2027-01-29",
  },
  {
    id: "2026-2027-2",
    school_year: "2026-2027",
    term: 2,
    label: "2026—2027学年第二学期（项目演示校历）",
    start_date: "2027-02-22",
    end_date: "2027-07-09",
  },
];
