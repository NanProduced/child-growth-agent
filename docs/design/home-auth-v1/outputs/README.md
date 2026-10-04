# 设计输出目录（home-auth-v1 · R1）

图片保存于此目录。**本轮状态：NOT_RUN（无可用内置 ImageGen，未生成任何图片）。** 未用 API Key、CLI、CSS 或 emoji 冒充插画；目录内没有伪造文件。

## 预期产出与链接

| 文件 | 内容 | 预期画幅 | 图片链接 |
|---|---|---|---|
| `01-unlogged-desktop.png` | 未登录桌面稿 | 1536×1024 | NOT_RUN（尚无文件） |
| `02-teacher-desktop.png` | 教师桌面稿 | 1536×1024 | NOT_RUN（尚无文件） |
| `03-admin-desktop.png` | 管理员桌面稿 | 1536×1024 | NOT_RUN（尚无文件） |
| `04-teacher-mobile-390.png` | 教师 390 窄屏稿 | 780×1688 | NOT_RUN（尚无文件） |
| `hero-teacher-children.png` | 独立无文字主插画 | 1536×768 | NOT_RUN（尚无文件） |

对应 prompt：`../prompts/01`–`../prompts/05`。

## sidecar 规范（出稿后逐张填写）

`<name>.meta.json`，字段未知时写 `"unknown"`，不猜测：

```json
{
  "file": "01-unlogged-desktop.png",
  "tool": "unknown",
  "model": "unknown",
  "prompt_file": "../prompts/01-unlogged-desktop.md",
  "actual_size": "unknown",
  "generated_at": "unknown",
  "metadata_source": "unknown",
  "notes": ""
}
```

## 生成台账

| 文件 | 工具/模型 | 实际尺寸 | 生成时间 | 状态 |
|---|---|---|---|---|
| 01-unlogged-desktop.png | 未知 | — | — | NOT_RUN |
| 02-teacher-desktop.png | 未知 | — | — | NOT_RUN |
| 03-admin-desktop.png | 未知 | — | — | NOT_RUN |
| 04-teacher-mobile-390.png | 未知 | — | — | NOT_RUN |
| hero-teacher-children.png | 未知 | — | — | NOT_RUN |

## 来源纪律

- 自带素材：本目录生成图需保留实际 prompt、工具、尺寸与可获得的元数据；模型未知写未知。
- 复用既有素材（`public/assets/illustrations/homepage-classroom.png`、`observation-notebook.png`）仅作过渡候选；**其来源 sidecar 缺失，上线前必须补齐，不得伪造来源**。
- 出稿后执行 `../handoff-r1.md` 的批量检查（一致性、数量、文案、布局、人物遮挡），必要时只做一次集中修正。
