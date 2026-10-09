# 整月回顾与分享日期修复 — 2026-10-09

状态：**本地实现和验证完成，未提交、未 push、未部署。**
以上为修复交付时的状态。用户随后已批准本次线上更新；发布结果另行记录，不能把下面的本地/替身证据改写成生产全链路验收。
工作树：`D:\CodexWorktrees\family-communication\child-growth-agent`，起点 `98e8aab9240b33c3f3037d51b34100841ad8e9f7`。此前发布报告与生成物保留，不触碰旧 main。

## 两项修改

1. **整月回顾无需逐条取正文**：现有 `list_observations` 增加 `from/to/include_content`。默认仍只返回索引；正文模式必须指定幼儿，最多 60 条、60000 个正文字符。日期在授权 SQL 内、LIMIT 之前过滤；超过上限明确 `truncated=true`，不能冒充完整结果。只返回原文、确认描述与原投影标记，不返回 AI 草稿、工作流或跨班关联。每条实际装载观察都登记重核依赖，继续走既有 AUTH/scoped 读取。
2. **分享的事例与日期一一对应**：内部模型输出升级为 `family_communication_v2`，每个故事给出原观察 ID、正文与逐字依据；服务端按真实 `observed_at` 排序并添加日期。称呼与签名也由服务端添加，最终仍是可编辑的自然段，不把结构化字段展示给家长。错误日期、笼统月份开头、错误引用或重复来源拒绝；最多两次模型请求，持续失败不落正文、旧草稿不覆盖。真实原话中的时间词与编号玩具不会因校验被改写。

没有提高内核的工具步数上限，没有新增万能工具、依赖、表或迁移。原观察与教师确认规则不变。

## 验证

| 检查 | 实际结果 |
|---|---|
| 新增根因反例 `check-step5-business-repairs.ts` | 20/20；注册工具 + 内核 + 模型替身，真实请求 0 |
| 既有 READ1 纯检查 | 189/189 |
| READ1 隔离 PG / 真实 AUTH / scoped 读取 | 98/98（原 87 + 新 11），清理已核验 |
| 家园分享纯检查 | 37/37，原场景保留，替身改为新内部协议 |
| 家园分享隔离 PG / 真实路由 handler | 58/58，覆盖错误时间重试、失败空正文、旧草稿保留、撤权/转班/到期/CSRF/幂等；清理已核验 |
| Agent 内核 / API0 | 29/29、57/57 |
| 本地生产 Next HTTP + 隔离 PG + 真实 Chrome | 41/41，模型是本地协议替身，真实请求 0；进程/容器清理通过 |
| 真正 StepFun `step-5-preview` | 共 4 次：整月回顾 3 次（找幼儿→正文批量读取→回答）成功；跨月份分享 1 次通过新校验，分别生成 2026年9月2日、2026年10月8日的事例 |
| 类型、源码 lint、stylelint、Next webpack 构建、tsup | 通过；环境限定见下文 |

真正模型测试使用投影后的合成素材与工具替身，不连接线上数据库，不是新候选的线上全链路验收。Chrome 检查使用真实本地 HTTP/Auth/PG，但模型为协议替身；这两类证据不相互冒充。

真实模型使用原 50 次授权的剩余 4 次，唯一原账本现在保守预留 50/50，未重置旧账本。实际调用计数记录于新增两个场景，旧不确定调用仍保守保留。

## 环境与测试装置说明

- `pnpm validate` 的全目录 lint 会扫到未提交的 `.tmp/*.cjs`，触发现有 `import/no-cycle` 的插件配置范围问题。配置未改；逐补丁文件 lint 及 `pnpm exec eslint . --quiet --ignore-pattern '.tmp/**' --ignore-pattern 'output/**'` 全源码检查通过，不把原命令改写成通过。
- 默认 Turbopack 构建不接受当前共享 `node_modules` junction 指向工作树外。使用 `pnpm next build --webpack` 构建成功；没有改 Next 配置或重建他人的依赖目录。`next-env.d.ts` 的生成变动恢复到起点。
- 新增数据库场景起初插在旧场景中途，改变了“最新草稿”的测试前提；最终移至旧覆盖之后，原断言未删除，58/58 重跑通过。这是装置顺序修正，不是修改产品的最新草稿选择规则。
- 生成协议是内部模型协议，公开 API、`family_communications` 存储和既有草稿读取保持兼容；旧草稿不自动重写或重新生成。

## 复跑与证据

```text
pnpm exec tsx scripts/check-step5-business-repairs.ts
pnpm exec tsx scripts/yaya/check-tools-read.ts
pnpm exec tsx scripts/yaya/check-tools-read-db.ts
pnpm exec tsx scripts/check-family-communication.ts
pnpm exec tsx scripts/check-family-communication-db.ts
pnpm exec tsx scripts/check-family-communication-browser.ts
```

浏览器需按既有装置设置 `PLAYWRIGHT_CORE_DIR`，模型请求为 0。不要自动复跑真实 provider 装置：该账本已封账。

- 浏览器：`output/playwright/family-communication-copy2-dd7f62fc-dcdd-4fd4-8bde-479232c802f2/`（results、network、cleanup、截图）
- 真正模型：`output/playwright/candidate-repair-provider-34b8cad7-c7ac-45c6-9a95-e800ab24cce9/results.json`
- 预算：`output/playwright/step5-retest-d4a0f003-7488-4c6b-b1bf-85ff81c1114c/budget.json`

安全装置 blob：`6702f2ddf3b436e79f8c92ae8756c33f611a8503`，未修改。未读 `.env`，未改生产数据/配置，未发送家长消息。

## 边界

日期绑定、引用与常见时间词校验不是任意自然语言的完整事实证明；故事中的其他概括仍需教师审读。超过批量上限仍明确返回不完整结果，不承诺不限量的全学期回顾。本轮没有关闭间歇性 React 418、历史标题和其他 UI 文案问题。

NOT_RUN：新候选线上部署与生产浏览器全链路、真实模型与真实数据库同链路、图片 provider、对象存储、屏幕阅读器与真机软键盘。
