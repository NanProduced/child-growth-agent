# 全平台 UI / 业务双线本地整合交付

日期：2026-10-08。状态：LOCAL_REVIEW_CANDIDATE，仍有 UI 尾项；不是全站 SHIP、真实模型验收或生产发布。

## 来源与权限

- 用户确认先固化聊天 v2，再同步两条线评审。聊天快照 `b6f20e6b1f1a55ece0fb7569f0efc4c02ff91d25`，共同基线 `ccf5998c20a4e8de6671f3938ec86a14f3ed545e`。
- UI 子代理 Halley：`ec5cb2b156f9d029317148eadc4230e0d7bc4a26`；业务子代理 Peirce：`4be03129d2a8a19583c825236e0c7e41cce1a0d5`。两来源正常 --no-ff 合入，无文本冲突，保留完整历史。
- 本地树 `D:/CodexWorktrees/platform-review-base/child-growth-agent`，分支 `codex/platform-review-integration`。运行代码组合提交 `2277c1d5812ba9baf783ca24cfc60f0fb49fc91e`，本交付再追加下列有限修正。没有写 main、来源树、线上库或生产桶；不 push、不部署。
- 冻结 Yaya types/API、schema/迁移、package/lock 不变；harness blob `6702f2ddf3b436e79f8c92ae8756c33f611a8503` 不变。RTK.md 不存在，仅记录；没有读取 .env、调用真实 provider、搜索、Coze/S3、托管库或重置旧模型账本。

## 已实施

- UI：36 个呈现文件统一普通页面的标题、正文、元数据、行距、数字与触控目标；保留批准的首页、聊天 v2、班级工作台与个人证据页方向，不换字体、不新增依赖。Impeccable 过程与逐项证据见 `ui-typeset-report.md`；其 14/20、0 primary /149 advisory 及开放项是该源候选的历史，不改写成全站通过。
- 业务：六类根因修复涵盖共享确定性上传身份的错误补偿、非法日历日期、图片 I/O 后身份/范围重核、锁等待及提交前会话到期、提案图片授权、原操作回执成功证明。复用现有 AUTH/DATA 与冻结判定；详见 `flow-delivery.md`。
- 父代理 B1：班级成员或观察读取失败时不渲染从初始空数组算出的零值统计/“还没有记录”；班级实体已读时仍保留管理员管理入口。真实空数据仍显示零值。既有 11 个 JSX 场景全部保留，新增两项正反对照。
- 父代理 E1：访客手机学段文字使用既有深绿色，实际计算对比度 5.94:1。
- 父代理 E3：档案“查看班级”最小宽度与不收缩；头部按内容换行，避免字号放大时被操作按钮挤成单字竖列。最终 768px / DOM 200% 字号：目标 112×88px，姓名 140.4×67.2px、48px 字号，单行。不是原生浏览器缩放证明。
- B5 旧媒体检查：父代理独立复现 24/25 后，以提交 `4fc04b01b1ba7717363547e264c2db6c10b02c77` 更新错误的“随机身份补偿”假设。失败/no metadata 原目的保留，并检查共享对象零删除、部分对象保留、相同确定性身份重试、无重复孤儿对象；25/25。原 24/25 历史没有改写。

## 父代理重新实跑的证据

| 检查 | 结果与分层 |
| --- | --- |
| 页面 fixture | `check-class-reports-pages` 13/13；JSX 页面调用、授权/查询替身，不是实库故障证明 |
| 业务独立关键复验 | client 10/10（纯判定）、guards 13/13（真实 AUTH/handler/隔离 PG）、media 并发真实 PG/local objects GREEN、media-r1 25/25；均清理核实 |
| 组合证据页 | `evidence-pages-48056c17` 118/118；保留原113，增加对比度/字号目标5项；五视口真实 Chrome+Next production HTTP+AUTH+隔离 PG，指定响应/DOM故障替身单列；错误0、原文不变、模型0、cleanup verified |
| 同一 E3 的限量收尾 | 最后头部换行后只跑 `PLATFORM_CLOSEOUT_ONLY=1`，`evidence-pages-499a795f` 8/8；标题及点击区实际截图/尺寸留存，不重复全站125张截图 |
| 最终聊天与保存组合 | `final-wire-a97b8c9e` 70/70 + Chrome24组，1440/1024/390，正式账号/CSRF、真实 Next production HTTP/PG/TOOLS/DATA/页面引用；本地协议模型替身18次、真实模型0，errors=[]、cleanup verified，生产HTML不含明文HttpOnly会话token |
| 静态与构建 | 整合版 pnpm validate 通过；最终头部微调再跑 Next build --webpack（含TS）+仓库tsup参数通过；git diff --check通过。next-env生成翻转已还原 |

第一次字号点击区虽通过，但人工截图发现标题竖排，未当作整体排版通过，随后修同一 flex 根因。新标题几何断言首次 6/7：三字姓名宽140.4px小于 `3×48px` 是字距导致的装置误判，调整为仍能拒绝原单字列的两字最小宽度，保存实际宽高与截图，再实跑8/8；未删原业务断言。失败 run `evidence-pages-c79cecf5` 保留且 cleanup verified。

本地证据在 `output/playwright/evidence-pages-48056c17/`、`evidence-pages-499a795f/`、`output/playwright/final-wiring/`，均为生成物，不额外提交。UI 子代理第二轮125张在其自有树 `docs/platform-review/ui-typeset/after/`，仅作该来源证据；首轮105张已在来源历史中，未删除或重复提交。每轮资源由现有装置按登记ID/标签/PID身份精准清理，生成物恢复，不清理其他任务资源。

## 未关闭与验收边界

1. E2：收起的芽芽悬浮入口在 class1024、home768、Review390等页面仍遮住部分链接；最终 DOM200% 档案截图亦与“记录一次观察”按钮相交，应优先收口。展开的侧栏已并排且不覆盖输入；不能据此称闭合入口全站无覆盖。未自行推翻用户固定右下角入口方向。
2. E4：CSS zoom 实验的横滚需用原生浏览器工具栏200%缩放核实；字号/viewport测试不代替原生zoom。
3. 真实模型质量/多模态、真实桶、托管库迁移、部署、生产安全/性能、Safari/iOS/真机软键盘、人工屏幕阅读器及完整键盘旅程 NOT_RUN。模型替身保存闭环不证明真实模型规划质量。
4. 旧 passcode 授权的 `check-guide-evidence-db.ts` 仍为过时装置，不硬改成假通过；旧自动首页视觉gate FAIL和人工裁定边界保持原样。

下一步应先处理上述明确 UI 尾项，再做用户本地人工验收；本交付不自动启动预览、真实模型或线上发布。
