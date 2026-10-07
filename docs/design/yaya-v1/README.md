# YAYA-DESIGN0｜芽芽助手与统一图片记录 UX 设计前置（yaya-v1）— R2

> 整合收口（2026-10-05）：接口见 docs/yaya-v1/contract-v1.md，实施顺序见 development-plan.md。已归档原记录只读；图稿01–06固定批准前场景，合成示例另展示批准后结果，不能混用。A/B/C仍未获用户选稿；图稿/视觉/浏览器仍NOT_RUN。下方R1/R2表保留历史。

- 共同产品基线：`e8225f04918de2073e194cb199dc8cf1bcb7f38f`（codex/flow-close-integration）
- 本线起点：`7164c6d2234176cfc43fc7407e944349b73b1381`（YAYA-DESIGN0 R1；R0 为 `dd73f6c`）
- 工作树：`C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-yaya-design0`，分支 `codex/yaya-design0`
- 范围：只修改 `docs/design/yaya-v1/**`。不改 PRODUCT / DESIGN / sidecar / 全局 CSS / 页面 / 组件 / API / schema / 共享类型 / 依赖锁 / `.env` / harness / 首页。`RTK.md` 不存在，仅记录。
- 状态：**R2 规格返修完成，方向未选**；不是实现、不是接口冻结、不是浏览器/视觉验收、不是真实教师实测。
- 图稿：**NOT_RUN**（本会话无内置 ImageGen）。出稿 prompt 见 `prompts/`，台账见 `outputs/README.md`。未伪装图稿，未声称用户已选稿；需要 HTML 原型时另行申请批准，本轮不建 mock 路由。

## R1 修正概览（对应验收 A–E）

| 项 | 修正 | 落点 |
|---|---|---|
| A 灵活问答 | 服务分层：咨询/看图问答/临时准备/正式整理；登录即可看图问答，不选幼儿、不强制 ≥10 字；仅显式记录意图进准备卡；多名幼儿直接独立卡 | `brief.md` §1.1、`message-spec.md` §0/§2/§3.1-3.3 |
| B 恢复分型 | 六类状态（明确失败/前提冲突/结果未知/执行中/已保存详情暂不可读/批次分项）；未知只按原操作核对；证据范围修正 + 正反流程表 | `recovery-spec.md`、`flow-analysis.md` S8、`message-spec.md` §3.9 |
| C 身份与历史 | 撤权/转班但有效可一般问答；停用/失效/身份不可用关闭全部模型；同账号范围变化 vs 换账号；tool part 取消不丢草稿；后台操作不显示成已撤销 | `flow-analysis.md` S11、`recovery-spec.md` §1.7/§1.9、`brief.md` §2.2 |
| D 示例与指南事实 | 全文统一案例锚点；使用 `catalog.ts` 真实条目 id/原文/年龄段/product_rules；成人帮助不自动降级；追问为真实缺口；自洽核对表 | `synthetic-example.md`、全部 prompts、`direction-options.md` |
| E 问答与布局 | 长答不裁断；补问答/查询/管理员/未分配呈现；B 抽屉保留未提交编辑；A 统一卡内按钮；C 分栏看实际宽度；手机原生 dvh/安全区优先；核对表单同样处理键盘；批准前内容完整；层语义明确 | `message-spec.md`、`direction-options.md`、`brief.md` §2、`future-acceptance.md` |

### R2 修正概览

| 项 | 修正 | 落点 |
|---|---|---|
| A 记录意图 | 多名幼儿的分析/咨询先回答，不自动建卡；显式记录意图 + 映射明确才独立卡；真歧义才澄清；`准备为观察` 可选；新增“帮我分析”与“帮我分别记录”对照 | `brief.md` §1.1、`message-spec.md` §0/§2.1/§3.1-3.3、`flow-analysis.md` S1b/S3/S9、`synthetic-example.md` §2 |
| B 原操作核验 | 成功 = 原操作成功 + 身份/内容/业务结果一致；另一端归档不同内容不得显示“你的修改已保存”；未知只查原 operation_id，不新建提案绕过；保留输入/操作标记/写锁；中间效果不冒充整条归档 | `recovery-spec.md`（原则 2–4、§1.2–1.6、§1.10、§2）、`message-spec.md` §3.8/§3.9、`flow-analysis.md` S8 |
| C 案例事实 | 不补造“口头提醒/主动去问”；提醒方式/内容为真实未知；追问问“方式或大致内容”，逐字非必填；跳过/记不清仍可事实保留与整理，暂不确认有疑问的指南关联，不阻塞；`adult_help: allowed` 不自动降级 | `synthetic-example.md`、`message-spec.md` §3.4、`prompts/02、05、06`、`prompts/README.md` |
| D 保存语义 | “准备态不自动写库”改为：不自动形成业务观察/正式确认；聊天、私人草稿、素材可按契约账号私有持久化；关闭聊天不必然丢失 | `brief.md` §1.1/§2.2、`message-spec.md` §0、`recovery-spec.md` §1.9、`same-record-flow.md` §1/§6、`future-acceptance.md` |

检查结果：`revision-check.md`（文档正反场景与跨文档一致性核对，不冒充功能/视觉 PASS）。

## 本目录

| 文件 | 内容 | 读者 |
|---|---|---|
| `brief.md` | 固定约束、服务分层、入口/侧栏/工作区/390 壳层、层语义与非目标 | 用户、主评审、UI1 |
| `flow-analysis.md` | Product Design 流程分析：卡点分类与证据标签（含 R1 修正） | 用户、主评审 |
| `direction-options.md` | **三份待选方向** + 推荐组合（A 默认 + C 独立工作区批量） | **用户选稿** |
| `message-spec.md` | 问答消息、特殊卡片、六类结果状态、小芽姿态、安全凭据入口 | UI1、主评审 |
| `recovery-spec.md` | 六类失败/冲突/进行中恢复、正反流程表、图片管线、QA 反例 | UI1、QA1、CONTRACT-R1 |
| `same-record-flow.md` | 同一记录 ID：表单→图片→Review→聊天→档案回看 | UI1、INTEGRATE1 |
| `synthetic-example.md` | 统一合成案例（小满/阿依）与自洽核对表 | 用户、演示脚本、出图 |
| `future-acceptance.md` | 未来真实浏览器验收规格（当前 NOT_RUN） | QA1 |
| `revision-check.md` | R1 精简检查结果（A–E 正反 + 跨文档一致性） | 主评审 |
| `prompts/` | 统一案例的出稿 prompt 与负面提示（NOT_RUN） | 具备 ImageGen 的环境 |
| `outputs/` | 预期图稿与 sidecar 台账（NOT_RUN，无文件） | 出稿执行者 |

## 三份方向（先看这里）

| # | 方向 | 消息密度 | 核对方式 | 移动端布局 |
|---|---|---|---|---|
| A | **册页卡** | 低：一主题一卡；长答可展开 | **卡内核对**：核对区在卡片底部展开 | 单列卡流 + 卡内操作（输入区吸底） |
| B | **短句流** | 高：进度短消息 + 回答块 | **逐步核对**：每个检查点一个小消息，编辑进底部抽屉 | 对话优先 + 底部抽屉编辑 |
| C | **核查台** | 中：左侧短对话 + 右侧核对栏（仅够宽时） | **分栏核对**：右侧专用核对面板；窄侧栏退化为覆盖面板 | 「对话／核对」双标签页（带待核对角标） |

- 推荐组合（主评审建议，待出图评审）：**A 作为默认体验，C 的批量核查只用于独立工作区**；A/B/C 均**未选**，用户选稿后才进入 UI1。
- 三份方向共用同一业务口径、权限模型、记录 ID 与正式守门；差异只在密度、核对位置与移动端组织；不重开首页或品牌竞赛。

## 与相邻任务的关系

- `CONTRACT-R1`：工具覆盖、DTO、**通用操作身份/回执**与附件引用；本设计预留接口映射建议，不冻结字段、不自定义恢复算法、不等待他方代码。
- `TECH0-R1`：runtime/存储/检索；本设计只给形态要求（单会话流、附件、历史投影、无第二状态源、tool part 取消不丢业务草稿）。
- 本设计不声称任何工具已可执行；回执与“进行中”语义中凡涉及通用 operation 的均为 [A]/依赖项。

## 证据标签

- **[C] 代码证据**：基线 SHA 上可核对的文件与行；**只证明现状**，且恢复类 [C] 仅覆盖现有“观察状态核对”子集，不是通用回执账本。
- **[A] 设计假设/依赖项**：合理但未验证，或依赖 CONTRACT-R1/TECH0-R1 的接口映射。
- **[U] 尚无教师实测**：本设计没有任何真实教师可用性测试；演示数据为合成。
- **[R1]** / **[R2]**：对应轮次修正新增或改变的口径。
