# YAYA-AGENT1-CORE-R1 交付报告｜动态授权投影重核与模型可见工具参数

2026-10-06。起点 `2640e0c74c311374a11a13c8fffbe3eaeff059fb`，沿 `codex/yaya-agent1-core` 追加。
**实现提交（完整 SHA）：`a99624baef835d7c6c98bd8413ffa2a942bd5708`**（本文档提交只含文档）。
工作树：`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-yaya-agent1-core`。
harness blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503` 未改；RTK.md 不存在（仅记录）。
`src/lib/llm.ts` 未改：本轮根因在引擎上下文消费与 Prompt 工具清单，不涉及 provider 适配；
原 6 类 strict schema 回归仍 7/7。未读 `.env`，预算 40/40 未动，真实模型/搜索/S3/DB 请求 0。

## 1. 端口变化（精确）

| 端口/类型 | 变化 |
|---|---|
| `YayaAgentDependencies` | 新增 `revalidateProjectedContext(input): Promise<YayaContextRevalidation>` |
| `YayaContextRevalidationInput` | 新增：`{run_id, identity, sources, image_ids}`，即已装载进模型上下文的全部来源与图片 |
| `YayaContextRevalidation` | 新增：`{ok:true}` 或 `{ok:false, reason:'context_revoked', denied_refs}` |
| `YayaToolParamSchema` | 由仅 `validate` 扩展为 `validate` + **必需** `describe(): YayaToolParamProtocol` |
| `YayaToolParamProtocol` / `YayaToolProtocolError` | 新增：`{json_schema}`；不可导出/为空时显式抛出 |
| `YAYA_AGENT_STOP_REASONS` | 新增 `context_revoked`、`tool_protocol_unavailable` |
| `zodToolParams` | `describe` 用 zod v4 公开 API `z.toJSONSchema(io:'input', unrepresentable:'throw')`，剔除 `$schema`；无法导出或空对象即拒绝 |

引擎重核调用点（单点共享实现，不在各工具贴局部判断）：
装载后、每次模型派发前、每次模型返回后（发布前）、每次 read 派发前、read 返回且结果来源登记后（消费前）、
公开检索扫描前、每次提案派发前与返回后（发布提案事件前）。
依赖端用 AUTH/DATA/MEDIA 当前事实逐项判定；引擎不比较账号/scope 数组，不复制授权算法。

## 2. A：授权变化后不继续消费旧私域上下文

- 同账号、`scope` 数组不变但幼儿转班的失权由资源级重核识别（A4 断言全部 scope 快照一致仍停止）。
- 模型输出 `source_refs=[]` 不能豁免：发布前对**全部已装载上下文**重核（A5）。
- 保守停止为 `context_revoked`，与 `account_disabled` 分离；有效未分配账号一般问答照常（A6）。
- 旧 run/取消/deadline/身份守门、有限预算、只提案不执行、原 operation 只查询恢复全部保留（原 13 项全绿）。
- 不换绑账号/会话/资源：重核用当前身份，但绝不替换旧上下文或静默重载。

### 反例 RED→GREEN（RED 为起点 SHA 真实输出，GREEN 为修复后）

引擎 RED：`passed 13 / total 21`，8 项新增反例全失败：
5 项实际终态 `null`（answered）而期望 `context_revoked`；未分配/多步两项重核调用 0 次；
参数协议项模型消息无必需字段。Prompt RED：`8/10`。

| 反例 | RED（起点） | GREEN（a99624b） |
|---|---|---|
| loadProjectedContext 等待中撤权 | 模型仍被调用并发布 answer | `context_revoked`，model=0，旧历史/图片未进模型 |
| read 等待中撤权（主评审复现） | model=2，PRIVATE_CHILD_FACT 重送，answer 发布 | model=1，tool_result 事件=0，answer=0；read 结果来源进入重核输入 |
| model 等待中撤权 | 迟到答案仍发布 | `context_revoked`，answer 事件=0 |
| scope 数组不变、幼儿归属变化 | 直接调用模型 | 资源级重核停止，scope 快照全同仍 model=0 |
| source_refs=[] | 借空引用绕过，答案发布 | model=2 后停止，answer=0 |
| 有效未分配账号一般问答 | 无重核边界 | answered；重核收到空 sources/image_ids |
| 无权限变化的多步读取 | 无重核边界 | answered，model=3，reads=2，重核≥3 未误停 |
| 工具参数协议可见 | 消息只有工具名 | 消息含必需字段/类型 JSON Schema；缺字段仍 `invalid_params` |

## 3. B：模型可见工具参数协议（与服务端校验同源）

- `formatToolCatalog` 每个工具行输出：`参数（JSON Schema，必须完全符合）：{...}`，来自
  `params.describe()`，即与 `validate` 同一 Zod schema 的公开导出；无影子 schema。
- `z.unknown()`/空协议 → `YayaToolProtocolError`（注册期拒绝）；运行期伪造空协议 →
  引擎 `tool_protocol_unavailable`、model=0，不把坏工具发给模型。
- 白名单与参数校验未放松：未知工具仍 `unknown_read_tool`/`unknown_write_tool`，
  缺必需字段仍 `invalid_params`、依赖端零调用。
- 验收直接检查 `model.generate` 收到的消息（非只断言工具名）；JSON Schema 内容断言为
  手写期望结构（`"required"`/`"child_id"`/`"raw_text"`/`"query"`），不依赖替身正确输出。

## 4. 验证与计数

| 命令 | 结果 |
|---|---|
| `pnpm ts-check` / `pnpm lint --quiet` | exit 0 |
| `check-agent-engine.ts` | **21/21**（原 13 + 新 8），real_model_requests=0 |
| `check-agent-prompt.ts` | **10/10**（原 8 + 新 2），model_behavior=NOT_RUN |
| `check-agent-llm.ts` | 7/7，real_provider_requests=0（six strict schema 哈希未变） |
| `check-contract.ts` / `check-preflight.ts` | 68/68 / 15/15 |
| `check-tech0.ts` / `check-runtime-tech0.cjs` | SDK 表面 OK / 技术 PoC 38 项 OK |
| 旧 AI 回归：agent-flow 30、activity-support 19、growth-profile 13、ai-context 14、quality-guard 8、organize-retry 9、teacher-clarify 13、stepfun-timeout 3 | 全绿 |

替身调用计数（check-agent-engine 输出）：model=40、read=15、propose=3、query=4（均为进程内替身）。

## 5. 文件清单与 NOT_RUN

修改（仅自有范围）：
`src/lib/yaya/agent/types.ts`、`src/lib/yaya/agent/engine.ts`、`src/lib/yaya/agent/prompt.ts`、
`scripts/yaya/check-agent-engine.ts`、`scripts/yaya/check-agent-prompt.ts`；本文档。

NOT_RUN：真实 provider 请求与真实模型对 JSON Schema 的理解/抗注入质量；真实搜索/S3/DB；
真实 AUTH/DATA/MEDIA 对 `revalidateProjectedContext` 的装配（依赖端第二波）；
浏览器/UI/业务 routes；`check-ai-quality.ts`（会读 `.env` 并占用真实预算）。
停止点：R1 核心完成，不自行开始 TOOLS1/UI1。
