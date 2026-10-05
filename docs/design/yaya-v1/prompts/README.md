# 图稿出稿 prompt 包（yaya-v1）

**本轮状态：NOT_RUN。** 本会话没有内置 ImageGen 工具，未生成任何图片，也未用 API Key、CLI、CSS 或 emoji 冒充插画。本目录只交付精确 prompt；在具备真实原生 ImageGen 的环境按下方清单逐张出稿。

## 出稿清单

| 文件 | 画幅 | 内容 | 输出 |
|---|---|---|---|
| `01-direction-a-desktop.md` | 1536×1024（3:2） | 方向 A·册页卡：班级页 + 右侧栏 + 观察草稿卡 | `../outputs/01-direction-a-desktop.png` |
| `02-direction-a-mobile.md` | 780×1688（≈390×844 逻辑） | 方向 A·册页卡：手机全屏卡流 + 软键盘 | `../outputs/02-direction-a-mobile.png` |
| `03-direction-b-desktop.md` | 1536×1024 | 方向 B·短句流：右侧栏逐步检查点 + 编辑抽屉 | `../outputs/03-direction-b-desktop.png` |
| `04-direction-b-mobile.md` | 780×1688 | 方向 B·短句流：全屏对话 + 底部核对抽屉 | `../outputs/04-direction-b-mobile.png` |
| `05-direction-c-desktop.md` | 1536×1024 | 方向 C·核查台：分栏工作区（对话 + 核对队列） | `../outputs/05-direction-c-desktop.png` |
| `06-direction-c-mobile.md` | 780×1688 | 方向 C·核查台：对话/核对双标签 | `../outputs/06-direction-c-mobile.png` |
| `07-yaya-states.md` | 1536×1024 | 小芽六姿态状态板（安静/响应中/待确认/保存中/成功/异常） | `../outputs/07-yaya-states.png` |

一次生成 7 张、同一风格；不做无限重试，出稿后按各文件验收清单批量检查一次、集中修正一次。

## 全局纪律（每张都适用）

- 只用**合成示例数据**：不出现真实幼儿姓名、面孔、园所；出现的中文姓名一律为化名（小满、阿依）。
- 人物只允许**平面插画/剪影**，不写实、不出现可识别儿童照片；助手“小芽”是简单绿色嫩芽拟人。
- 视觉沿用“轻量成长观察册”：暖白画布、芽叶绿、海军蓝墨、细分隔线；shadcn 风格控件；**不使用首页花园地图、不使用 KPI/图表/评分**。
- 图内文字为设计沟通用，实现一律 HTML；文字要少而准，避免大段生成文本（易错字）。
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
