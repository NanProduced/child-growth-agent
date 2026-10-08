---
primary_target: src/app/globals.css
related_targets: [src/app/classes/page.tsx, src/app/children/page.tsx, src/app/children/new/page.tsx, src/app/observations/page.tsx, src/app/observations/new/new-observation-client.tsx, src/app/observations/[id]/review/review-client.tsx, src/app/reports/page.tsx, src/app/activities/page.tsx, src/components/accounts/teacher-management.tsx]
mode: Operate
---

# 平台排版角色 — 局部候选扩展

继承“轻量成长观察册”、暖白芽绿与现有中文无衬线栈。个人 V4 单列、班级第三稿工作台、A 默认聊天 / C 宽屏批量的布局与业务语义均保留。仅由 `data-platform-surface` / `data-platform-chat` 选择呈现范围，不把首页 home-* 色板或构图推广到业务页，不创建新的品牌或字体家族。

候选角色：页面标题24px / 600 / 1.4，区块18px / 600 / 1.5，普通正文16px / 1.75 / 70ch上限，标签与元数据14px / 1.5，数字tabular-nums。首页 display 与证据册现有局部引用行距继续属于各自 brief。共享输入16px，核心控件至少44px；正文、标签、未知与授权说明不为首屏容量压缩。

范围内辅助文字采用现有中性色的较深亮度 `oklch(0.49 0 0)`；个人证据册复用班级页已有 `oklch(0.47 0.012 88)` 辅助文字。它们是本轮候选映射，不是用户批准的全站新token；DESIGN / sidecar / config未修改。

共同比较基线 `ccf5998c20a4e8de6671f3938ec86a14f3ed545e`；f371首轮截图保留原历史，聊天旧实现不能作为v2修复前契约。交付、覆盖、问题与NOT_RUN见 `docs/platform-review/ui-typeset-report.md`，精确文件见 `ui-typeset-files.json`。

两轮证据为105 / 125张截图；第二轮有一次装置中断，清理核验后只补未完成场景。正文/控件修正成立，普通四视口无横滚；访客小班/中班/大班小字对比、闭合助手入口遮挡、200%字号的查看班级窄目标仍开放。CSS zoom替身不是原生工具栏缩放认证。状态 IMPLEMENTED_REVIEW_REQUIRED，不是全站SHIP、生产安全、真实模型或部署认证。
