# YAYA 正式组合接线交付候选

2026-10-07。本地组合与主链路实现候选，不代表真实模型全链路通过或可部署。

## 1. 授权与来源

用户批准 APP1-R4 后由本会话正式接线、本地浏览器验证、StepFun 文本 smoke；图片测试应使用扣子编程多模态模型与开发对象桶。新增真实模型额度总计 20，旧耗尽的 40 次账本不重置。无 main 合并、push、生产迁移或部署授权。

工作树 `D:\CodexWorktrees\yaya-final-wiring\child-growth-agent`，分支 `codex/yaya-final-wiring`，Codex managed worktree 附本会话。固定输入：

| 来源 | SHA | --no-ff 合并 |
| --- | --- | --- |
| C2 | b8bf68313e0ac7b1afbf6589ae9e590e50d71153 | 起点 |
| DATA-CHAT-BIND1-R2 | 2132c4db9a0cbd1199ad9bc6e7831b7564301960 | 4ef18ee |
| TOOLS1-R4 | 6c985b6111c3ffe126a1a95221ea7a0a25c81fdf | a2b1d31 |
| APP1-R4 | 93551d8f42b7976e6dfc7f026ff4af598083a70c | e19e39c |
| UI1-R2-FINAL 候选 | 3cfabb825d5f2dc6cd3df5758cfdaa70724c9b18 | 3a31331 |

无文本冲突；UI merge 包含合法日历日期倒序守门和 4 个检查，不声称 UI 来源整体获批。来源树、main 未修改。harness blob 为 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`。未新增项目依赖；`package.json`/lock 的增量仅来自 UI 来源。

APP1-R4 在来源树独立重跑 182/182、validate、原发布到期探针：到期后无 answer，旧已提交终态不覆盖，不重派发模型，清理 verified。评审见 `C:\Users\nanpr\AppData\Local\Temp\opencode\yaya-app1-r2-review-20261006\REVIEW-R4.md`。

## 2. 组合实施

1. `platform-binding.ts`：真实 toolkit 接原 Request 的 Origin/CSRF/session、原 run/conversation、同 client active-run 钩子；提案目标/图片也登记完整依赖。模型不批准、不执行。
2. `terminal-message.ts`：使用持久化完整依赖而非模型引用构建消息绑定；终态与确定性助手消息/恢复标记同事务。消息故障整单回滚，旧终态读取不回填。
3. 新增消息 await 后再次核验身份/会话/期限；跨期一起回滚。已有失效停止只落停止终态，不尝试以旧身份写助手消息。整合回归曾 180/182，修清空该路径旧 principal 后恢复 182/182，原断言未删。
4. 用户消息只走 HTTP；客户端不再 POST assistant/tool。保存消息 ID 绑定稳定 client_request_id；原 run 回放不因自身助手消息推进会话 revision 被误拒。
5. 当前 full 授权后提供真实可读目标名、原文与日期给核对卡，不加入 payload/digest、不作授权依据。
6. 历史只查原 run/proposal/operation，并核完整原计划身份，不自动派发模型或执行业务。
7. seed 增加 runs/chat-bind 迁移，四处助手消息改内部原语；APP 检查新请求用当前 revision、回放仍用原 revision；旧“TOOLS 未装配”反例换为真实 malformed 参数拒绝，未删覆盖。
8. 真浏览器暴露用户保存 DTO 的 projection 片段解析错形，改为消费服务端真实简要投影字段；不放松正式正文校验。
9. 修 SDK 初次 SSR/客户端 thread 状态差异导致的 hydration 错误、390 输入框被裁切；公开 auth props 不含 token。Next dev 调试 Flight 会记录请求头，不能将 dev cookie 回显混为生产序列化证据。生产浏览器随后暴露 `/assistant` 静态预渲染捕获构建时身份 unavailable：RootLayout 在读账号前 `await connection()`，所有依赖身份的页面按请求渲染，不能修成默认教师或靠客户端假登录。生产真实 next start 全 HTML 核对不含明文会话令牌，生产浏览器需另跑实际主链路。
10. 保存原文卡不再说“确认后即正式记录”；已保存项不再算受限/待补。保留批准的 A 默认、C 宽屏核对，不改全站 DESIGN。
11. 真实 StepFun 输出混合 propose_write+正文/引用，被原解析器拒绝。共享 Prompt 补明确空字段规则；检查 RED 10/11 → GREEN 11/11。解析器/动作 wire 不改；修后真实模型效果 NOT_RUN。

## 3. 实测分层

- `check-final-wiring.ts`：61/61，真实 Next HTTP、真实账号/session/CSRF、隔离 PG、正式 DATA/READ/TOOLS；模型为回环 StepFun 协议替身。覆盖查询、提案批准创建→整理→确认、原文不变、原身份幂等、消息回滚、消息保存跨期、owner 拒绝。
- `YAYA_TEST_BROWSER=1`：真实 Chrome、真实 HTTP/隔离 DB，无 API 拦截。1440/1024/390 无横向溢出且输入框可见；浏览器查询、真实核对卡点击批准→draft 落库；刷新选原历史→原 operation 回执核对，无运行/消息/审批/操作 POST。SDK 打开工作区可初始化空会话，单列，不冒充“所有 POST 为零”。真实真机键盘、Safari/iOS、屏幕阅读器 NOT_RUN。
- `YAYA_TEST_PRODUCTION=1 YAYA_TEST_BROWSER=1`：最终 **61/61 + 浏览器 6 组**（`final-wire-458fdaba`），生产 next start 全 HTML 无明文 HttpOnly session token。初轮 HTTP 55/55 不等于生产浏览器可用；随后生产浏览器真实 RED（已登录却 unavailable），共享布局修复后生产浏览器三断点、查询、卡片批准/真实写入、原历史核验全部 GREEN。
- APP 182/182；DATA-CHAT 186/186；TOOLS 实库 134/85/76/33/37；UI 56/56；API 57、chat-bind 22、core 68、preflight 15；engine 29、prompt 11、LLM 7；business-access 113、save-consistency 24、AUTH 36、Guide 19、prep-joint 31。
- seed 两轮 62/62、3 个失败路径、5 个所有权探针。每个隔离容器/目录按登记 ID/标签清理，不处理同命名空间的其他 agent 资源。
- validate、Next build、tsup；机械 Impeccable 检查 0 primary、10 字体 advisory（原有 10/11px）。Impeccable 影响限于状态语义、响应式与可用性，不作整站设计 PASS。

浏览器证据在工作树 `output/playwright/final-wiring/`（gitignored）：`browser-results.json`、仅方法/路径/状态的 `browser-network.json`、三断点及保存/历史截图。独立 Chrome context，不影响用户标签。

## 4. 真实 provider 结果与预算

本轮 StepFun `step-5-preview` 真实 HTTPS 请求 **11/20**（2+5+4），含每次循环；独立账本 `logs/yaya-provider-smoke-20/requests.jsonl`，额度在发请求之前登记，代理自身不重试。所有发送只有本轮合成内容，数据库仍是一次性本地 PG。残余 **9**，不追加消费。测试配置只取 StepFun 白名单；未加载其中 DATABASE_URL、未连托管库。凭证不打印、前端不可见。

结果保留，不称真实业务全绿：

- 幼教建议问答两次正常。
- 名册第一次 invalid_action；另一次真实 list_children→answer 正常。技术 ID 在回答正文中出现，列为 UX/模型质量待修。
- “今天”的观察请求正确停在澄清，但询问绝对日期暴露运行上下文缺可信日期锚点的体验缺口，仍待修。
- 带绝对日期请求完成三次合法读取，最终 propose_write 携带非空 content/source_refs，被协议拒绝；**零提案/零观察写入**。已补 Prompt 明确约束，真实复测待新窗口；未自动规范化非法输出或冒充真实保存成功。
- 第一轮代理使用的 model 标签为 final-wire-double，但上游实际 step-5-preview；后两轮已修测试环境标签并记录真实模型响应 metadata。原结果不删除、不伪造。

此为真实 APP HTTP 调真实模型的 smoke，不是浏览器+真实模型+全部写工具闭环。整理/确认完整链路目前模型替身验证；真实模型正式写闭环 NOT_RUN。

## 5. 扣子多模态与对象存储前置

只读核验扣子项目 `7690843235199139866` 的 dev env：只有旧口令、StepFun 配置与 DATABASE_URL 变量名；未修改变量、未读 prod。SDK 应用模型目录查询失败，底层 ConfigurationError 指向缺 COZE_API_TOKEN；本地没有可用应用网关身份。CLI 的 coding-agent model list 不是应用运行时 LLM 目录，也不把 CLI token 直接塞进模型调用。

候选 **Doubao Seed 2.0 Mini**：官方扣子内部集成计费页面列输入≤32k 为 0.0002 元/千 token、输出 0.002 元/千 token；火山官方列多模态理解能力。实际可用 model ID/版本、网关授权仍需在本项目集成管理/SDK 目录核实。不能把公共目录当作本项目已启用证据。

官方来源（2026-10-07 查询）：

- https://docs.coze.cn/coze_pro_internal_integrations_fee
- https://docs.coze.cn/guides_internal_integrations
- https://docs.coze.cn/guides_integrate_llm
- https://docs.volcengine.com/docs/82379/1330310?lang=en
- https://docs.coze.cn/guides_integrate_storage

图片当前验收对象根是**本地替身**。真实链路必须 MEDIA_STORAGE_MODE=s3、已核实的扣子项目开发桶、bucket/endpoint/region 与运行环境注入的凭证，且开发/生产物理隔离。主机已有 AWS 凭证不能证明属于扣子开发桶，未使用。不得拿生产桶、公开 URL、签名 URL 直接喂模型。合成图经正式上传处理/授权 model 变体字节给模型，引用由 PG 元数据保存。

后续需安全提供（不在聊天发秘密）：本项目开发运行时 LLM 授权与可用模型列表、扣子开发桶身份及对应运行环境。未具备时多模态/真实桶为 NOT_RUN。禁止为试图解阻自行开启服务、部署、迁移托管库或扩大凭证范围。

## 6. 接续门禁

候选状态 **PARTIAL / NOT_READY_FOR_MERGE**：代码接线与已列本地链路通过，真实模型业务稳定性、多模态与真实桶仍未闭环。

1. 复核组合 diff、终态消息同事务/跨期/原身份恢复，不能整文件替换冻结来源。
2. 补可信运行日期锚点、协议修后真实模型复测；继续同一新 20 次账本，剩余 9，不新建额度。真实 provider 输出要标人工判定，不能只看 HTTP 200。
3. 凭证与开发桶身份核实后，用低成本多模态模型做合成图片：看图问答、明确记录意图、图片不成为正式事实、引用保留、共享引用、读取撤权；精确登记/清理本轮 key，不 list/delete prefix。
4. UI 对 needs_prepare 的编辑/重新准备、多幼儿批次分项、未知结果/失败取消等仍需联合浏览器覆盖；不把本轮单主链路称为全部 12 写工具验收。
5. 冻结消息资源只支持 child/class/observation；无法完整映射的图片/管理工具依赖保持 unknown，读侧可仅读原 run 核对；不要虚构来源绕过。此限制需后续设计/契约 owner 裁定。
6. 扣子代理流心跳/上传配额、production+local 媒体配置拒绝、真实桶、迁移矩阵、恢复兼容清单、生产 AUTH 安全仍是发布前置。未发布、不 merge main、不 push、不部署。

所有测试服务/容器/守门、临时凭证与对象根均已按各装置清理；保留 gitignored 的去敏证据和模型账本。没有长期本地预览服务。
