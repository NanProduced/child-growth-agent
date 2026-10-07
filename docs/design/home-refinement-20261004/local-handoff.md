# 本地候选交接（历史首页交付 + CLOSE-QA1 整合）

本文件原为首页 v2 本地候选交接；现区分两段，避免把历史交付口径当作本次整合状态。

## 历史：首页 v2 交付（已归档口径，不再代表当前候选）

- 范围：按 2026-10-04 批准的四态设计图实现首页（未登录/教师/管理员/教师移动端），真实角色与授权链路。
- 当时分支 `codex/home-v2-craft`，工作树 `D:/CodexWorktrees/guide-local-preview/child-growth-agent`；其 HEAD `d8825e6` 后来成为 CLOSE-QA1 的共同基线 B0。
- 首页验收分层、截图与自动视觉 gate FAIL/人工裁定边界见 `docs/design/home-refinement-20261004/` 各文件；这些是历史记录，未改写。

## 本次：CLOSE-QA1 整合候选（当前状态）

- 分支 `codex/flow-close-integration`，工作树 `C:\Users\nanpr\AppData\Local\Temp\opencode\child-growth-flow-close`（从 B0 新建）。
- 来源：B0 `d8825e6` + AUTH-UX1-R1 `a6ba329` + G6-WRITE1-R1 `a7e8a12` + TEST-DATE1 `13bf116`，按序 `--no-ff` 合并（`00614ab`/`35ce6d7`/`47a7935`）；最终候选 SHA 见 `docs/guide-evidence-v1/close-qa1-integration.md` 与交付消息。
- 完整整合记录、组合检查实测、联合浏览器验收与兼容修改：`docs/guide-evidence-v1/close-qa1-integration.md`。
- 业务状态：指南前端写闭环已接入本地整合候选；**真实模型质量、托管库迁移、生产发布均未验收**；活动实施反馈与学期快照仍未实现。历史自动视觉 gate FAIL 与人工裁定边界保留。

## 实际预览

- 地址：`http://127.0.0.1:5020/`（若被占用则使用交付消息中报告的空闲端口）。
- 账号：管理员/任教教师/其他班教师/未分配教师；凭证仅通过受控本地文件 `logs/home-review/local-credentials.json` 交付，不提交、不在聊天或日志中打印。
- 数据：仅本轮隔离合成数据（6 班/94 名幼儿、预置草稿与已确认记录）；预览种子不作为端到端验收证明。
- 模型出口保持守门，不能宣称可真实生成 AI；真实 provider 请求为 0。
- 保留 4 小时自动清理：监督脚本启动后 4 小时按身份与标签清理隔离库、服务与临时凭证。
- 主动停止：在本工作树执行 `pnpm exec tsx scripts/stop-home-review.ts`，不按端口杀其他服务。
- 预览资源是明确保留的自有运行资源，与已清理的验收测试资源分别记录。

## NOT_RUN

真实 StepFun/Coze 调用与质量、LLM Judge、托管库迁移/写入、部署、生产安全认证、非 Windows 浏览器、稀有动态姓名跨系统排版未执行；AI 预算保持原边界。
