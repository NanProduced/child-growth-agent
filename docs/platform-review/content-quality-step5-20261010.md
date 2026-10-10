# 生成质量与 Step 5 图片理解优化

日期：2026-10-10。基线：1280ae7b31e9f5cb60249926453de2cd47315bfb。
工作树：D:/CodexWorktrees/family-communication/child-growth-agent。
上轮状态：本地候选；未提交、未 push、未部署。原有未跟踪报告和输出均保留。

本次发布准备（用户已授权发布、线上真实浏览器与独立20次真实请求）：补修eslint规则作用域，与Next注册import插件的后缀列表一致；忽略既有临时诊断及输出目录，不关闭循环依赖规则、不新增依赖。标准 `pnpm lint:build`、`pnpm ts-check`、`pnpm lint:style` 均通过。历史失败结果仍保留在下方，不回写成此前已通过。

## 产品变化

- 家园分享：补充自然角、骑行、成人提醒三个少样本；根据实际行为组织科学、健康等发展角度，不按活动场景名称直接认定能力。去掉每段的日期开头，服务器把真实日期放在分组末尾。每条所选记录都必须出现；遗漏会拒绝并沿用原最多一次重试。正文长度、逐字依据、时间归属、其他幼儿姓名与发展性语言守门继续保留。
- 输入增加教师确认的领域、子领域作为参考，不把领域标签或指南当作新增事实。源字段可选，旧草稿来源快照与 fingerprint 兼容，不改旧草稿正文。
- 成长档案：保持原五字段与六类 strict schema 不变，在 development_clues 中组织“具体事实/逐字依据 → 发展解读 → 继续观察”。页面区分“观察摘要”和“行为与发展解读”，分析不冒充新增观察；未增加自动建记录或正式指南确认。
- 加入引文核对及单次观察的部分提升结论守门。提示词把“没有前后对照”集中到 recent_change，不在每个区块重复警告。不能据此承诺没有语义幻觉，教师仍须核对。
- StepFun：仅为已接入的 step-5-preview 放行授权图片字节，复用现有 data URI 消息映射、取消、usage、strict JSON。其他未接入模型仍在请求前拒绝；不静默回退。不迁移扣子对象存储，不改图片授权、变体或上传链路。
- .env.example 建议图片也走 stepfun；这不是生产配置变更。线上当前图片配置未切换，需发布本候选后才能切换，不能提前把旧线上适配器指向 StepFun 图片。

## 真实模型证据

本轮独立授权10次，实际派发10次，全部 StepFun，包含复测。未重置旧40/50/6次账本；无儿童照片、真实幼儿数据、生产业务写入或生产对象上传。凭证仅由现有设置读入测试进程，不打印、不写证据文件；没有读取 .env。

证据目录：logs/quality/step5-unify-fc381a9b-e0bc-4fe7-b22f-2bdd7bdd1961/。

- budget.json：10/10，各次请求状态均200。
- results.json：保留最初5项记录（4成功、1断言失败）。第1项裸图片测试未保存回答，不能据此认定识图失败；不回写原结果。
- vision-recheck.json：裸图片明确用英文识别两红方块/一蓝圆。真实芽芽内核在没有任务意图时先描述图片再澄清，原测试“必须 answered”断言失败；这是合法 clarified，不是图片不可用。AUTH/投影在该内核测试为合成依赖，不冒充真实登录或存储验收。
- vision-final.json：明确看图问题的原调用入口和真实芽芽内核均成功；strict action 验证通过。Step 5可用，未触发豆包复测或回退。
- 家园 A/B 使用同一 Step 5、同一两条虚构观察。新输出涵盖2/2，分开自然角科学探索与骑行健康片段；旧输出的“握稳车把”缺少输入依据，说明换模型不能替代提示词和教师核对。
- growth-final.json：最终提示词生成带逐字行为、支撑位置/稳定性解释和后续观察的分析，summary没有反复“只有一条/证据不足”的开场。一次记录仍不声称能力提升。

模型能力与协议支持：[Step Plan官方文档](https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api)、[严格结构化输出](https://platform.stepfun.com/docs/zh/guides/developer/json-mode)。真实图片烟测仅证明当前账号对合成PNG与这些任务可用，不等同任意儿童照片质量验收。

## 分层验收

| 检查 | 结果 |
| --- | --- |
| 新生成质量反例 | 起点4/10；最终10/10 |
| family pure/browser bundle | 37/37 |
| family隔离PG+AUTH+真实handler | 58/58，模型替身，精确清理 |
| family Chrome+Next HTTP+隔离PG | 两轮各41/41；模型协议替身，最终截图分科学/艺术/社会；cleanup verified |
| agent LLM | 9/9，六类strict schema哈希保持，旧不支持模型守门保留 |
| agent engine / contract / preflight | 29/29、68/68、15/15 |
| 图片消息/业务修复 | 12/12、20/20 |
| growth / agent-flow / teacher-clarify / activity-support | 13/13、30/30、13/13、19/19 |
| AI context / StepFun timeout | 14/14、3/3 |
| TypeScript / stylelint / Next webpack build | 通过 |
| Impeccable局部detector | []；未重新设计布局/全站tokens |
| git diff --check | 通过；harness blob仍6702f2ddf3b436e79f8c92ae8756c33f611a8503 |

最终浏览器证据：output/playwright/family-communication-copy2-629d3fab-8ead-46d2-9111-0f52dc9f8844/，1440/1024/768/390视口及错误、空数据、管理员只读、恢复、剪贴板拒绝等旧覆盖保留。仅家园分享本轮重跑浏览器；成长页只做标题/提示局部变化，未独立重跑其真实浏览器。

标准全仓库lint **未通过**：未改动的eslint.config.mjs启用import/no-cycle，但当前已安装配置未提供import插件。关闭这一条后全仓库仍会扫描既有gitignored .tmp CommonJS诊断产生89项错误，不删除别人的文件来制造全绿。全部变更文件已用 `pnpm exec eslint <精确清单> --quiet --rule 'import/no-cycle: off'` 通过；循环依赖规则本轮没有验证。package/lock、AUTH、数据库DDL与安全harness没有改动。

## NOT_RUN与交接

没有发布、生产配置变更、生产上传/真实桶读取、生产DB业务写入、真实儿童照片发送或家长消息。Coze生产图片路径与对象存储沿用上轮证据，本轮不占用未获批的上传额度。线上存量草稿/小结不会自动重写；发布后由教师重新生成。

发布前处理现有lint配置问题、固化精确候选，再把YAYA_CHAT_IMAGE_PROVIDER改为stepfun并做有额度的线上闭环。若真实线上StepFun图片不可用，明确改回coze，保留原因与账本；不自动重发未知的业务操作。

Impeccable读到design.json sidecar陈旧及未记录buildPath；按技能不在本轮修复设计元数据，未扩展为全站风格改造。
