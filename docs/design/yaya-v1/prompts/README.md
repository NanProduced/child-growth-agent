# 图稿出稿 prompt 包（yaya-v1）— R1

**本轮状态：NOT_RUN。** 本会话没有内置 ImageGen 工具，未生成任何图片，也未用 API Key、CLI、CSS 或 emoji 冒充插画。本目录只交付精确 prompt；在具备真实原生 ImageGen 的环境按清单逐张出稿。

## 统一案例（R1，所有图稿共用）

- 幼儿：小满（化名，4岁2个月）、阿依（化名，4岁5个月）——**只此两名**，不得出现糖糖/小雨/小北。
- 班级/园所：星芽幼儿园（合成）· 中班 · 向日葵班（合成）。
- 日期/情境：10月8日（2026-10-08）· 上午区域活动 · 积木区——不得再出现 4月2日/娃娃家。
- 照片：共 2 张；①积木区全景（**共同**，两张卡都引用）②长桥特写（仅小满卡）。
- 原文逐字：`小满自己搭长桥，中间塌了三次，他换了更宽的底座，第四次搭稳了。`
- 阿依部分已知：发生提醒，随后她过去问了小满并参与；**未知：提醒的方式/内容**——不得画成“口头提醒”，不得写“主动去问”。 [R2]
- 指南条目：小满 `item.moe.science.math_cognition.3.4-5.1`（科学·数学认知·4-5岁）；阿依 `item.moe.social.interpersonal.2.4-5.1`（社会·人际交往·4-5岁）；两条 `adult_help: allowed`，帮助不自动降级。
- 长答规则：进度/工具摘要短；普通回答可多段、可“展开全文/展开来源”。
- 本组图稿均为“显式记录意图”场景；分析/咨询场景不画成记录卡。

详见 `../synthetic-example.md`。

## 出稿清单

| 文件 | 画幅 | 内容 | 输出 |
|---|---|---|---|
| `01-direction-a-desktop.md` | 1536×1024（3:2） | 方向 A·册页卡：班级页 + 右侧栏 + 观察草稿卡 | `../outputs/01-direction-a-desktop.png` |
| `02-direction-a-mobile.md` | 780×1688（≈390×844 逻辑） | 方向 A·册页卡：手机全屏卡流 + 软键盘 | `../outputs/02-direction-a-mobile.png` |
| `03-direction-b-desktop.md` | 1536×1024 | 方向 B·短句流：右侧栏逐步检查点 + 编辑抽屉 | `../outputs/03-direction-b-desktop.png` |
| `04-direction-b-mobile.md` | 780×1688 | 方向 B·短句流：全屏对话 + 底部核对抽屉 | `../outputs/04-direction-b-mobile.png` |
| `05-direction-c-desktop.md` | 1536×1024 | 方向 C·核查台：宽工作区分栏（对话 + 核对队列） | `../outputs/05-direction-c-desktop.png` |
| `06-direction-c-mobile.md` | 780×1688 | 方向 C·核查台：对话/核对双标签 | `../outputs/06-direction-c-mobile.png` |
| `07-yaya-states.md` | 1536×1024 | 小芽六姿态状态板 | `../outputs/07-yaya-states.png` |

一次生成 7 张、同一风格；出稿后按各文件验收清单批量检查一次、集中修正一次。

## 全局纪律（每张都适用）

- 只用**合成示例数据**：不出现真实幼儿姓名、面孔、园所；出现的姓名一律为化名（小满、阿依）。
- 人物只允许**平面插画/剪影**；助手“小芽”是简单绿色嫩芽拟人。
- 视觉沿用“轻量成长观察册”：暖白画布、芽叶绿、海军蓝墨、细分隔线；shadcn 风格控件；**不使用首页花园地图、不使用 KPI/图表/评分**。
- 图内文字为设计沟通用，实现一律 HTML；文字要少而准。
- 状态不只用颜色：至少一个文字徽章。
- 不画浏览器 chrome、水印、3D、玻璃拟态、重阴影。

## sidecar 规范（出稿后逐张填写）

`../outputs/<name>.meta.json`，未知写 `"unknown"`，不猜测：

```json
{
  "file": "01-direction-a-desktop.png",
  "tool": "unknown",
  "model": "unknown",
  "prompt_file": "../prompts/01-direction-a-desktop.md",
  "actual_size": "unknown",
  "generated_at": "unknown",
  "metadata_source": "unknown",
  "notes": ""
}
```

同时回填 `../outputs/README.md` 台账。图稿只证明设计意图，不证明交互、权限、真实模型或浏览器验收。
