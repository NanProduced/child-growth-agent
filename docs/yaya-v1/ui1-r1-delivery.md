# YAYA-UI1-R1 交付记录

## 基线与边界

- 固定起点：3455d9fd99f5610a033e8965606b7f2870ee6c94
- 来源分支：codex/yaya-ui1
- 自有分支：codex/yaya-ui1-r1
- 当前提交：本文件不自引用提交 SHA；最终 Git 输出提供完整 SHA。
- harness safety blob：6702f2ddf3b436e79f8c92ae8756c33f611a8503
- RTK.md：不存在；本轮仅记录，未创建、未安装。
- 未操作 main、未 reset 来源、未 push、未部署；未读 .env，未连接托管库、真实模型、搜索或真实桶；未使用新增真实模型额度。

## RED → GREEN

基线复核证据：

- REVIEW：C:\Users\nanpr\AppData\Local\Temp\opencode\yaya-ui1-review-20261006\REVIEW.md
- 独立浏览器 brief：C:\Users\nanpr\AppData\Local\Temp\opencode\yaya-ui-browser-review1-20261007-004708-e25533f6\brief.md
- 基线网络：上述目录 network.json（runs/operations POST 的 CSRF 缺失；cancel POST 为 0；错 operation 仍显示 saved）
- 基线纯反例：上述目录 pure-counterexamples.json（私域答案来源约束丢失）

修复结果：

- 39/39：pnpm exec tsx scripts/yaya/check-ui1-client.ts
- 通过：pnpm ts-check
- 通过：pnpm lint:build
- 通过：pnpm lint:style
- 通过：pnpm exec next build
- 通过：git diff --check
- 通过：fixture 浏览器 38/38，证据目录 C:\Users\nanpr\AppData\Local\Temp\yaya-ui1-r1-browser2
- fixture acceptance-run.json：route_cleaned=true、server_cleaned=true、check_exit=0

本轮纯检查和 fixture 浏览器均不等于正式 AUTH、HTTP+DB、真实模型或生产验收。

## 精确文件表

- docs/yaya-v1/ui1-r1-competitor-brief.md
- docs/yaya-v1/ui1-r1-delivery.md
- scripts/yaya/__fixtures__/yaya-ui-fixtures.json
- scripts/yaya/check-ui1-client.ts
- src/components/yaya/client/actions.ts
- src/components/yaya/client/adapters.ts
- src/components/yaya/client/mapping.ts
- src/components/yaya/yaya-attachment.tsx
- src/components/yaya/yaya-composer.tsx
- src/components/yaya/yaya-message.tsx
- src/components/yaya/yaya-proposal.tsx

## 根因修复

- runs 与 operations POST 改用 fetchWithAccountAuth；run 流仍保留 NDJSON、AbortSignal 和稳定 client_request_id。
- 停止时优先使用已收到的 run_id；首响应丢失按原 client_request_id 只读查找后请求正式 cancel。取消不承诺回滚已提交业务或物理取消上游。
- 原 operation 查询拒绝错 operation_id；有原计划时逐项核对 batch/proposal/item/target/actor；未知继续锁定，不自动重发。
- 执行批准后网络失败、响应缺项或语义核验失败均保留原项未知锁。
- 历史提案/运行错误保留原 proposal/client_request 标记；不执行历史、不使用 unstable_resume。
- 回执持久化只有通过 receiptProvesSuccess 才进入 executed；未证明成功继续按原操作核对。
- 附件失败重试复用同一 client_upload_id；超过 8 张明确提示，运行适配器不再静默截断。
- 空的终态助手消息不再渲染“正在想…”；输入区保持多行、内部滚动、移动端 16px 输入文字和安全区。
- 批准卡完整展示当前 payload 可提供的原文/草稿/确认稿/指南依据/成人帮助/备注/转班/教师管理字段；目标名称或实际写入内容缺失时不可批准，UUID 只在审计折叠区出现。

## 截图与网络证据

- 新 fixture 截图：C:\Users\nanpr\AppData\Local\Temp\yaya-ui1-r1-browser2\1440-panel-proposal-saved.png、390-panel.png、1440-workspace.png
- 基线截图：C:\Users\nanpr\AppData\Local\Temp\opencode\yaya-ui-browser-review1-20261007-004708-e25533f6\screenshots
- 新 fixture results.json 记录 1440、768、390；390 输入框 70px、发送/返回 44px、无横向溢出。
- post-fix 正式 AUTH/HTTP+DB 网络捕获：NOT_RUN；只保留基线脱敏 network.json，并以源码复核 fetchWithAccountAuth 出口。

## Impeccable

- 已完整读取 Impeccable 技能。
- 已针对 src/components/yaya/yaya-panel.tsx 成功加载 context；项目没有匹配的自动 surface brief，使用仓库 ui1-surface-brief.md 作为表面真相。
- 已按 Operate/Read、harden、adapt playbook 复核信息层级、错误/权限/长文本/移动端和安全区；UI 编辑前已读取 craft-floor。
- detector 已运行一次：只发现已有的 10px/11px 次要文字字体 advisory；未为清除 advisory 擅改全站 DESIGN。
- 已完成一批 1440/768/390 fixture 检查与一次视觉确认；最后按 polish 清理状态、可读目标和审计信息层级，不再做无限视觉迭代。

## 接口未闭合项与 NOT_RUN

- CHAT-BIND / DATA 尚未提供把 run 的可信来源依赖绑定到消息片段的最小 DTO；UI 不能凭模型最终 sources=[] 声称私域答案 independently_readable。该项保持 PARTIAL，不自行 fork 冻结协议。
- CHAT-BIND / DATA 尚未提供 proposal/operation/run 的持久化绑定与 finished 终态内容恢复字段；当前只保留不授权的文字标记，历史不自动执行，正式跨设备恢复保持 PARTIAL。
- AGENT-APP1 的 runs start/lookup/cancel 正式路由与运行持久化未装配；TOOLS1 的 operations POST 正式事务未装配。客户端已接正式路径和取消语义，但真实链路为 NOT_RUN。
- 正式 AUTH、真实 HTTP+DB、真实模型/搜索、对象存储、真实业务事务、部署/生产回归、真机软键盘、屏幕阅读器人工走查均 NOT_RUN。
- fixture 的匿名浮动登录入口/叠加 provider 仍属于验收装置问题，不外推为生产 /assistant 回归；未使用 force click 作为成功证据。

## 清理证明

- 新 runner acceptance-run.json：临时 route 与服务进程均已按 runner 身份清理。
- 首轮因 fixture 缺少可读目标名在勾选处停止的运行也已由 runner 清理；随后补齐合成 fixture label 后 38/38 通过。
- 未清理他人端口、进程或工作树；证据与凭证未入库。

完成后停止于主评审，不自行整合或进入下一阶段。
