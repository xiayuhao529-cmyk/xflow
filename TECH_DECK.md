# Xflow 技术宣讲文档（合作沟通版）

## 1. 产品一句话
Xflow 是一个面向短剧/短视频创作的 轻量级AI 工作台：把“小说原文”自动拆解为“章节、结构化人物与场景、物品清单”，再进一步生成分镜提示词与画面资产提示词，从而实现从文字到影像资产的端到端半自动流程。

## 2. 为什么需要它（价值点）
1. **节省编剧与视觉沟通成本**：用结构化 JSON 贯穿人物/场景/提示词，使后续生成与编辑可程序化、可追溯。
2. **把“提示词工程”产品化**：将脚本分析技能（skill）作为可复用模板，统一输出字段，降低提示词漂移。
3. **支持人机协作**：前端提供“加载/编辑/保存/导出”，并可对已生成资产进行二次润色。
4. **多阶段 AI 管线**：阶段 1（剧本分析）结构化产出；阶段 2（分镜脚本）基于阶段 1 的结果继续生成。

## 3. 技术架构概览
### 3.1 后端（Node.js + Express）
- 服务启动：`server.js`
- 主要能力：
  - 路由：项目管理、章节拆分、大纲提取、资产生成、润色与保存
  - AI 调用：`callLlm()` 封装对外部大模型接口的调用
  - 数据持久化：将大纲/资产写入 `output/` 下的 JSON 文件
  - Prompt 约束：对阶段 1 产出的 `ai_image_prompt.chinese_prompt` 做净化与风格强制校正

### 3.2 前端（静态页面 + 原生 JS）
- 单页：`workspace.html` + `app.js`
- 功能：
  - 项目创建/切换/删除
  - 小说拆解为章节
  - 一键“提取选中章节大纲”（生成人物/场景卡片）
  - 一键“生成当前/选中/全部章节资产”（分镜 + 提示词）
  - 支持模块编辑与导出

## 4. AI 工作流（端到端）
### 4.1 基础流程
1. **创建项目**
2. **导入小说文本并拆解章节**：将原文切分为多个章节（`/api/projects/:projectId/novel/split`）
3. **提取章节大纲（阶段 1）**：对章节文本做剧本分析，输出：
   - `analysisJson`（结构化 JSON）
   - `charactersMd` / `scenesMd`（与 UI 兼容的 Markdown）
   - `characterCards` / `sceneCards`（前端直接渲染的结构化卡片数组）
   - 同时会对 `ai_image_prompt.chinese_prompt` 进行二次润色与净化
4. **生成章节资产（阶段 2）**：
   - 基于 `analysisJson/rawAnalysisMd` 与章节文本生成分镜脚本（stage2 director）
   - 根据分镜表生成逐镜提示词
   - 输出资产 JSON 并允许人工编辑/二次润色

### 4.2 阶段 1（剧本分析）核心产物
阶段 1 的目标是从剧本中提取：
- 人物（`characters[]`）：name、aliases、demographics、personality_traits、physical_description、relationships、dialogue_stats、character_arc、ai_image_prompt
- 场景（`scenes[]`）：scene_id、scene_number、location、time、characters_present、summary、key_actions、key_dialogues、emotional_tone、plot_significance、duration_estimate、props、atmosphere、ai_image_prompt

并在后处理阶段把 `ai_image_prompt.chinese_prompt` 变成“可直接复制到生图模型”的纯文本提示词。

### 4.3 Prompt 润色与风格强制校正（关键机制）
阶段 1 后的 prompt 处理包含三步：
1. **sanitizeChineseImagePrompt**：将模型误输出的模板标签/列表项/示例段落剔除，只保留可执行正文。
2. **二次润色（polishAnalysisImagePromptsWithLlm）**：
   - 人物：只依据人物 `physical_description` 生成一段可执行中文 prompt
   - 场景：依据场景类型（内/外）、环境描述、必含信息生成一段可执行中文 prompt
3. **enforcePromptByVisualStyle**：按用户的 `visualStyle` 对 prompt 做最终校正
   - 例如用户输入“日本动漫 2D 风格”时，会移除 `photorealistic/写实摄影/35mm/film grain/浅景深` 等明显冲突词
   - 使模型输出更贴近用户设定的风格锚点

## 5. 数据结构（合作对接重点）
### 5.1 Stage 1 输出 JSON（analysisJson）
顶层结构（概念示意）：
```json
{
  "search_summary": { "keywords": ["..."], "findings": "..." },
  "style_suggestions": { "visual_tone": "...", "color_palette": "...", "camera_language": "..." },
  "characters": [
    {
      "name": "CHARACTER_NAME",
      "aliases": ["..."],
      "demographics": { "age_range": "...", "gender": "...", "occupation": "..." },
      "personality_traits": ["..."],
      "physical_description": "...",
      "relationships": [{ "to": "OTHER_CHARACTER", "type": "friend|rival|family|..." }],
      "dialogue_stats": { "total_lines": 0, "total_words": 0, "scenes_appears_in": ["SCENE_1"] },
      "character_arc": { "starting_state": "...", "major_changes": ["..."], "ending_state": "..." },
      "ai_image_prompt": { "chinese_prompt": "...", "english_enhancements": ["..."], "example": "..." }
    }
  ],
  "scenes": [
    {
      "scene_id": "SCENE_1",
      "scene_number": 1,
      "location": { "type": "INT/EXT", "place": "...", "specific": "..." },
      "time": { "time_of_day": "...", "chronology": "..." },
      "characters_present": ["..."],
      "summary": "...",
      "key_actions": ["..."],
      "key_dialogues": ["..."],
      "emotional_tone": "...",
      "plot_significance": "1-5",
      "duration_estimate": "pages: ...",
      "props": ["..."],
      "atmosphere": "...",
      "ai_image_prompt": { "chinese_prompt": "...", "visual_style": "...", "lighting": "...", "example": "..." }
    }
  ],
  "relationship_summary": "...",
  "conclusion": "..."
}
```

### 5.2 前端卡片数据（characterCards / sceneCards）
为了保证 UI 展示稳定、避免 Markdown 解析偏差：
- 角色卡片：`{ title: "萧惊鸿", content: "身份/外貌/AI生图提示词(可执行文本)" }`
- 场景卡片：`{ title: "场景1", content: "场景类型/环境描述/AI生图提示词(可执行文本)" }`

## 6. API 清单（合作对接）
### 6.1 管线接口（pipeline）
- `POST /api/pipeline/init`
- `POST /api/pipeline/stage1`
- `POST /api/pipeline/stage2`
- `POST /api/pipeline/run-all`
- `POST /api/pipeline/save-edits`
- `GET  /api/pipeline/assets`

### 6.2 项目与工作台接口（projects）
- `GET  /api/projects/list`
- `POST /api/projects/create`
- `POST /api/projects/:projectId/delete`（带 `confirmToken=DELETE_OK`）
- `GET  /api/projects/:projectId/workspace`

### 6.3 章节、大纲与资产
- `POST /api/projects/:projectId/novel/split`（小说 -> 章节）
- `POST /api/projects/:projectId/chapters/extract-outline`（章节 -> 人物/场景大纲 + JSON）
- `GET  /api/projects/:projectId/chapters/:chapterId/outline`（读取 outline.json）
- `POST /api/projects/:projectId/chapters/:chapterId/outline/save`（保存编辑）
- `POST /api/projects/:projectId/chapters/:chapterId/audit-outline`（审核辅助）
- `POST /api/projects/:projectId/chapters/generate-assets`（章节 -> 资产）
- `GET  /api/projects/:projectId/chapters/:chapterId/assets`（读取 assets.json）
- `POST /api/projects/:projectId/chapters/:chapterId/assets/save`（保存编辑）
- `POST /api/projects/:projectId/chapters/:chapterId/assets/refine`（资产润色）

## 7. UI 交互与可体验效果
1. 选择项目与输入“视觉风格偏好”
2. 导入小说文本，拆分章节
3. 提取选中章节大纲：
   - 人物按钮：展示每个角色的身份、外貌描述、AI 生图提示词（Prompt）
   - 场景按钮：展示每个场景的场景类型、环境描述、AI 生图提示词（Prompt）
4. 生成资产：
   - 分镜脚本表 + 逐镜提示词（用于生图/视频生成）
5. 支持保存与导出：
   - 可把 `outline.json / assets.json` 与可读 Markdown 导出给团队协作

## 8. 合作落地点子（你可以怎么谈）
1. **作为“提示词生产平台”**：可对接任意图像生成服务（只要能消费 `ai_image_prompt.chinese_prompt`）。
2. **作为“创作流水线”**：把人物/场景/镜头的结构化数据输出为可复用资产，支持项目复刻与迭代。
3. **作为“团队协作工具”**：前端编辑 + JSON 保存，支持后续接入更多编辑模块（分镜微调/角色造型风格库等）。

## 9. 部署与运行方式（快速上手）
1. 依赖：Node.js
2. 设置环境变量：
   - `OPENAI_API_KEY`（必须）
   - `OPENAI_BASE_URL`（可选，默认 `https://api.openai.com`）
   - `OPENAI_MODEL`（可选）
3. 启动：
   - `node server.js`
4. 打开：
   - `http://localhost:3200`

## 10. 当前版本的关键注意点
1. **每次想改变视觉风格**，建议对章节执行“重新提取大纲/重新生成资产”，保证 prompt 处理链路使用新风格。
2. 已在服务端做了 prompt 净化与冲突词剔除，但仍建议用户在 `visualStyle` 输入里描述清晰的 2D/3D/写实/漫画等关键词作为锚点。

