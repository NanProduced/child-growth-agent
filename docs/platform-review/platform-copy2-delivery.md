# PLATFORM-COPY2 — 教师工作文案与阅读排版

2026-10-09。本轮在 `D:/CodexWorktrees/family-communication/child-growth-agent`、分支 `codex/family-communication-v1` 实施。HEAD 为 `49f819e46bce5a98e880b7252448946c1f8cbc4c`，不是完整候选快照：家园沟通、UX-FIX1 与本轮内容仍是未提交增量。保留既有脏文件，未提交、合并、push、部署或修改主工作树。

## 改写范围

只改静态界面文案与最小排版，不改教师输入、观察原文、指南原文、确认稿、模型生成内容或提示词。

| 场景 | 原表达 | 本轮表达/处理 |
| --- | --- | --- |
| 原文输入 | 不可改写的追溯依据等重复说明 | 请先核对内容，原文保存后不能修改。 |
| 已保存草稿 | 已保存 · 待判断 | 已保存 · 待整理；列表筛选同步 |
| 修改复核 | Agent 修改审核、原文金句 | 修改内容核对、原文摘录；字段与引用不变 |
| 保存结果不确定 | 回执/执行前提/运行终态等技术表述 | 保存结果待核对、核对保存结果、核对上次结果 |
| 家园分享 | 核对并复制 | 我已核对，复制文字；不声称自动核对或已发送 |

活动列表的前置说明只在分组处出现，不在每名幼儿下重复。观察列表、成长档案、成长回顾删除重复的流程尾注。模型名称和整理时间收进默认折叠的“整理信息”，确认时间仍直接可见；原操作身份也保留在折叠详情里，便于核查。

必要信息不删：AI 草稿标记、确认后归档、原文不可修改、管理员只读、账号不可核验、保存结果未知、停止回答不撤销已保存内容。读取失败不显示成空数据；成功仍由原回执与原计划核验，不由文案判定。

产品改动为23个界面文件：观察录入/列表/Review、档案建立/列表/详情、班级列表/详情、成长回顾、活动支持、通用错误/状态/重试提示、转班说明、指南引用按钮标签、芽芽消息/提案/回执/恢复卡、家园沟通。未修改班级指南与个人证据册的目录原文或统计算法。

## 排版取舍

使用 Impeccable clarify/typeset 与 humanizer-zh。独立启发式复核与机械检查分开，不把检测器或编辑判断称为教师可用性测试。沿用现有暖白、芽叶绿、系统中文字体及家园页面本地字体；不新增字体、依赖、token 或排版框架。

仅补两处：同班同名幼儿在观察选择器中显示生日，选择值仍是原 UUID；家园分享编辑区限制为70ch，保留16px正文和既有行高。长班名使用已有换行能力，不再截去必要区分信息。

## 验证

最终代码上实际执行：

- `pnpm validate`：类型、eslint、stylelint全部通过。
- 正式 Next production `build --webpack`及tsup服务入口打包通过；`git diff --check`通过。
- 新静态文案护栏34/34；角色入口21/21；班级/成长回顾页面13/13；聊天客户端语义56/56；指南写流123/123；家园沟通纯检查37/37。
- COPY2真实Next生产HTTP、真实AUTH、隔离PG、Chrome：1440×900、1024×900、768×1024、390×844，教师/管理员/访客52格全部PASS，1280/1280，faults与advisories均为空。包含长班名、同班同名生日区分、原文/确认稿显示、诊断折叠、常规点击与键盘、入口避让、401只读、管理员入口与手机文字放大压力。
- 手机文字放大使用DOM根字号200%，不是浏览器原生缩放、真机或软键盘证据。
- 家园生成后专项41/41：原37项保留，增加四视口编辑区字号、行高、行宽检查。真实Next HTTP/AUTH/隔离PG；模型是本地StepFun协议替身（3次替身HTTP请求），真实provider请求0。生成、编辑、核对、复制、空数据、权限、服务失败与原请求恢复通过。

COPY2对话入口按现有adapter创建私人会话元数据，该POST单列在 `conversation_initializations`，不声称零数据库写入。观察、消息及家园业务事实前后对照不变；长名称及同名场景数据只写本轮自有隔离库。家园专项业务写入也只发生在其自有隔离库。

### 失败历史与最终证据

旧报告不回写，不把多轮结果伪装成首轮全过：

1. `output/playwright/platform-copy2-b7ef6062-8614-4353-b168-32873085e313/`：1111/1120，52格中10格FAIL。8格是装置把16px单选圆点误作有效点击区域；2格是访客录入提示无页面标题导致非模态点击探针超时。装置改测关联的44px标签，并为提示补语义标题。首轮同时发现活动列表重复解释，批量删去后只做一次确认。
2. `output/playwright/platform-copy2-b5583897-315a-476f-bd69-7ba763581867/`：最终52/52、1280/1280；截图人工复核，未继续追加视觉改动。
3. `output/playwright/family-communication-copy2-ad37a57c-6661-4d11-80a2-d34d83000dde/`：测试模块路径配置不符，浏览器未启动；cleanup通过。改用该检查要求的已安装playwright-core包路径，不改产品。
4. `output/playwright/family-communication-copy2-5fc2f2b8-1daa-4bf2-b732-8c3919bdbdbe/`：最终41/41，桌面与手机生成后截图已检视，cleanup通过。

```powershell
# 全页面静态文案/排版确认
$env:PLAYWRIGHT_CORE_DIR='C:/Users/nanpr/AppData/Local/Temp/opencode/g4-pw-core/node_modules'
pnpm exec tsx scripts/acceptance/run-platform-ux-fixes.ts --copy-review
# 复用同一当前production构建，独立家园流程（参数为包路径）
$env:PLAYWRIGHT_CORE_DIR='C:/Users/nanpr/AppData/Local/Temp/opencode/g4-pw-core/node_modules/playwright-core'
pnpm exec tsx scripts/check-family-communication-browser.ts
```

## 不变量、清理与未跑项

与本轮开始前的166个文件逐项SHA-256比较，业务lib、API、storage、package/lock和harness全部未变。Git中schema等差异属于开始时已有家园沟通工作，不归本轮修改。harness blob仍为 `6702f2ddf3b436e79f8c92ae8756c33f611a8503`。RTK.md不存在，仅记录。

全部自有测试容器、服务进程、对象/凭证目录按身份清理；最终COPY2标签残留0、目录不存在、原进程身份不存活，家园专项cleanup_ok=true。构建生成物已恢复，next-env.d.ts无差异。证据作为本地生成物保留，不提交；未读.env、未连接托管库或扣子桶、未消耗或重置真实模型账本。

NOT_RUN：真实教师可用性实测、真实模型文案质量、聊天提案/回执的新增真实浏览器故障注入（本轮沿用56项纯语义回归）、真机/软键盘、浏览器原生缩放、Safari/iOS、人工屏幕阅读器、线上部署。本轮完成静态UX文案与局部阅读排版，不宣称全平台业务或生产验收通过。
