import type { GuideSourceLocation } from "@/lib/guide/types";

export const GUIDE_SOURCE_DOCUMENT = "《3—6岁儿童学习与发展指南》";
export const GUIDE_SOURCE_URL =
  "https://www.moe.gov.cn/srcsite/A06/s3327/201210/t20121009_143254.html";

export function guideSource(section: string): GuideSourceLocation {
  return {
    document: GUIDE_SOURCE_DOCUMENT,
    publisher: "教育部",
    published_year: 2012,
    section,
    url: GUIDE_SOURCE_URL,
  };
}
