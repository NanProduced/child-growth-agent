/**
 * YAYA-TECH0 离线探针：核对已发布 coze-coding-dev-sdk@0.7.32 的实际接口形状，
 * 对应 docs/yaya-v1/tech0.md 的能力矩阵。不读环境变量、不发任何网络请求。
 * 运行：pnpm tsx scripts/yaya/check-tech0.ts（需先 pnpm install）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { LLMClient, S3Config, SearchClient } from "coze-coding-dev-sdk";
import type { ContentPart, LLMConfig, Message } from "coze-coding-dev-sdk";

const sdkEntry = createRequire(import.meta.url).resolve("coze-coding-dev-sdk");
const sdkPackage = JSON.parse(
  readFileSync(join(dirname(sdkEntry), "..", "..", "package.json"), "utf8"),
) as { version: string };
assert.equal(sdkPackage.version, "0.7.32");

const llmMethods = Object.getOwnPropertyNames(LLMClient.prototype);
assert.ok(llmMethods.includes("invoke"), "LLMClient.invoke should exist");
assert.ok(llmMethods.includes("stream"), "LLMClient.stream should exist");
assert.ok(
  !llmMethods.some((name) => /tool/i.test(name)),
  "published LLMClient must not expose a tool loop",
);

const searchMethods = Object.getOwnPropertyNames(SearchClient.prototype);
for (const name of ["search", "webSearch", "webSearchWithSummary", "advancedSearch"]) {
  assert.ok(searchMethods.includes(name), `SearchClient.${name} should exist`);
}

// 签名 URL 默认 24 小时（86400s），接入私有图片时必须显式缩短有效期。
assert.equal(S3Config.DEFAULT_PRESIGNED_EXPIRE_TIME, 86400);

const visionMessage: Message = {
  role: "user",
  content: [
    { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
    { type: "text", text: "描述" },
  ] satisfies ContentPart[],
};
assert.equal(visionMessage.role, "user");

const llmConfig: LLMConfig = { model: "m", thinking: "disabled", streaming: true };
assert.equal(llmConfig.streaming, true);

// @ts-expect-error 发布类型 LLMConfig 没有 tools 参数
const withTools: LLMConfig = { tools: [] };
// @ts-expect-error 发布类型 Message 没有 tool 角色
const toolMessage: Message = { role: "tool", content: "{}" };
void withTools;
void toolMessage;

console.log("check-tech0 OK: coze-coding-dev-sdk@0.7.32 surface matches tech0.md");
