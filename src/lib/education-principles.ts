/**
 * 简短、可本地维护的幼儿教育原则摘要。
 *
 * 来源（2026-10-02 通过教育部官网核验）：
 * - 《3-6岁儿童学习与发展指南》，教育部教基二〔2012〕4号，2012-10-09 印发。
 *   https://www.moe.gov.cn/srcsite/A06/s3327/201210/t20121009_143254.html
 * - 《幼儿园保育教育质量评估指南》，教育部教基〔2022〕1号，2022-02-10 印发。
 *   https://www.moe.gov.cn/srcsite/A06/s3327/202202/t20220214_599198.html
 *   （核验要点：坚持儿童为本，尊重年龄特点与成长规律，以游戏为基本活动；
 *     严禁用直接测查幼儿能力和发展水平的方式评估保教质量；聚焦班级观察与师幼互动。）
 *
 * 摘要用于 Prompt 中设计支持方向，不加载原文 PDF、不建检索，也不是幼儿表现的证据。
 */

export const EDUCATION_PRINCIPLES_VERIFIED_AT = "2026-10-02";

export const EDUCATION_PRINCIPLES_SOURCES = [
  {
    title: "《3-6岁儿童学习与发展指南》",
    document: "教育部教基二〔2012〕4号",
    url: "https://www.moe.gov.cn/srcsite/A06/s3327/201210/t20121009_143254.html",
  },
  {
    title: "《幼儿园保育教育质量评估指南》",
    document: "教育部教基〔2022〕1号",
    url: "https://www.moe.gov.cn/srcsite/A06/s3327/202202/t20220214_599198.html",
  },
] as const;

export const EDUCATION_PRINCIPLES: readonly string[] = [
  "关注身心健康、情绪体验、一日生活与游戏；发展线索来自真实活动中的具体表现。",
  "尊重年龄特点、个体差异和不同发展路径，不以统一标准衡量所有幼儿。",
  "保护兴趣、主动探索与选择；不把年龄目标变成达标训练或练习清单。",
  "关注师幼互动、材料与环境提供的支持；支持建议优先调整互动方式与现有材料。",
  "不因一次表现判断稳定能力、人格或长期趋势。",
  "不把缺少某领域记录解释为该领域发展不足。",
  "不按性别限制活动、材料或表达方式。",
  "教育依据只用于设计支持方向，不能替代或补足幼儿的实际表现证据。",
];

/** 注入系统 Prompt 的紧凑参考区 */
export const EDUCATION_PRINCIPLES_BLOCK = [
  `教育参考原则（核验日期 ${EDUCATION_PRINCIPLES_VERIFIED_AT}，仅用于设计支持方向，不是幼儿表现的证据）：`,
  ...EDUCATION_PRINCIPLES.map((principle) => `- ${principle}`),
].join("\n");
