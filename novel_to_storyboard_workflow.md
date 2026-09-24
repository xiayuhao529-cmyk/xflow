# ToonFlow：小说 → 资产抽取 → 提示词 → 剧本 → 分镜 → 出图/出视频 工作流梳理

本文基于当前代码实现梳理端到端流程，重点回答：

- 用户输入小说后，系统如何抽取 **人物/场景/物品**（项目里叫 **角色/场景/道具**）
- 如何生成/润色 **格式化提示词**
- 如何生成 **剧本**、再生成 **分镜脚本（镜头提示词）** 与 **分镜图片**
- 各个 **Agent** 与 **Prompt** 如何配合

---

## 项目里涉及的核心数据表（`src/types/database.d.ts`）

- **`t_project`**：项目元信息（`type` 小说类型、`artStyle` 画风、`videoRatio` 画幅等）
- **`t_novel`**：小说章节原文（按 `chapterIndex` 排序）
- **`t_storyline`**：故事线（由 `OutlineScript` 生成/维护）
- **`t_outline`**：结构化大纲（每一集/episode 一条；`data` 为 JSON，包含 characters/props/scenes 等）
- **`t_script`**：剧本文本（与 `t_outline` 通过 `outlineId` 关联）
- **`t_assets`**：资产库（类型：`角色/场景/道具/分镜`；含 `intro/prompt/filePath` 等）
- **`t_prompts`**：提示词模板中心（`code` 区分用途；支持 `customValue` 覆盖 `defaultValue`）
- **`t_image`**：图片生成记录（资产图、分镜图等的状态与文件路径）
- **`t_video`**：视频生成记录（分镜序列 + video prompt + 状态）
- **`t_config`** / **`t_aiModelMap`**：AI 模型配置与 key 映射（`getPromptAi` 会用到）

---

## 路由与入口：系统如何把 `src/routes` 挂载为接口

在开发环境下，`src/core.ts` 会扫描 `src/routes/**/*.ts` 自动生成 `src/router.ts`，并在 `src/app.ts` 启动时挂载到 Express：

- `src/core.ts`：把文件路径映射为路由路径（如 `routes/novel/addNovel.ts` → `/novel/addNovel`）
- `src/app.ts`：`await import("@/router"); await router.default(app);`

因此你看到的接口路径，基本都能在 `src/router.ts` 里找到对应的 `app.use()` 映射。

---

## 总览：端到端主流程（从小说到分镜图/视频）

下面是一条典型生产链路（括号内是主要入口文件/路由）：

1. **导入小说章节原文**（HTTP：`/novel/addNovel`）
2. **用 OutlineScript Agent 从原文生成故事线/大纲，并从大纲抽取资产**（WS：`/outline/agentsOutline`）
3. **资产提示词润色（把“描述”变成更可控的绘图 prompt）**（HTTP：`/assets/polishAssetsPrompt`）
4. **生成角色/场景/道具/分镜的图片资产**（HTTP：`/assets/generateAssets`）
5. **从结构化大纲 + 原文参考生成剧本，写入 `t_script.content`**（HTTP：`/script/generateScriptApi` → `src/utils/generateScript.ts`）
6. **Storyboard Agent：剧本 → 片段 → 分镜镜头提示词（shot prompts）→ 生成宫格分镜图并切图**（WS：`/storyboard/chatStoryboard`；必要时也可走 HTTP：`/storyboard/generateShotImage`）
7. **生成视频用 prompt，并触发视频生成任务**（HTTP：`/storyboard/generateVideoPrompt` → `/video/generateVideo`）

> 约定：本文所有“系统预设提示词”指 `t_prompts.code` 对应的模板；代码里统一用 `customValue ?? defaultValue` 取值。

---

## Step 1：用户输入小说原文（入库）

### 接口

- **`POST /novel/addNovel`**：批量插入章节到 `t_novel`

实现见 `src/routes/novel/addNovel.ts`：每条章节保存 `projectId/chapterIndex/reel/chapter/chapterData/createTime`。

这一步只是 **存原文**，不做抽取与生成。

### 本步骤涉及的系统预设提示词（`t_prompts.code`）

- **无**（纯入库，不调用 AI）

---

## Step 2：从原文生成故事线/大纲，并抽取人物/场景/物品（OutlineScript Agent）

### 入口：WebSocket

- **`WS /outline/agentsOutline?projectId=...`**（`src/routes/outline/agentsOutline.ts`）

收到消息后，每次都会从 DB 取出该项目 `t_novel`（按章节号排序），调用：

- `agent = new OutlineScript(projectId)`
- `agent.setNovel(novelData)`
- `await agent.call(userPrompt)`

### OutlineScript 的职责

文件：`src/agents/outlineScript/index.ts`

它是一个“主 Agent + 3 个 Sub-Agent”的编排器：

- **主 Agent**：Prompt 代码 `outlineScript-main`
- **Sub-Agent（故事师）**：Prompt 代码 `outlineScript-a1`（工具权限：`getChapter/getStoryline/saveStoryline/getOutline/saveOutline/updateOutline`）
- **Sub-Agent（大纲师）**：Prompt 代码 `outlineScript-a2`
- **Sub-Agent（导演/审核）**：Prompt 代码 `outlineScript-director`

这些 Prompt 都从 `t_prompts` 读：优先 `customValue`，否则 `defaultValue`。

### 本步骤涉及的系统预设提示词（`t_prompts.code`）与代码路径

- **主控（main）**：`outlineScript-main`  
  - **使用位置**：`src/agents/outlineScript/index.ts` → `call()` 里读取并拼到 `system`
- **故事师（AI1）**：`outlineScript-a1`  
  - **使用位置**：`src/agents/outlineScript/index.ts` → `invokeSubAgent("AI1")`
- **大纲师（AI2）**：`outlineScript-a2`  
  - **使用位置**：`src/agents/outlineScript/index.ts` → `invokeSubAgent("AI2")`
- **导演（director）**：`outlineScript-director`  
  - **使用位置**：`src/agents/outlineScript/index.ts` → `invokeSubAgent("director")`

### 本步骤涉及的模型配置 key（`getPromptAi(key)`）

- **`outlineScriptAgent`**（文本模型）  
  - **使用位置**：`src/agents/outlineScript/index.ts`（main 与 sub-agent 都用它）

### 结构化大纲的“格式”（实体抽取的载体）

`OutlineScript` 通过 Zod Schema 约束每集大纲 `EpisodeData` 的 JSON 结构，核心字段包括：

- `chapterRange`：这集覆盖的章节号数组（后续生成剧本会按这个范围拼原文）
- `characters`：角色列表（每项 `name/description`）
- `scenes`：场景列表（每项 `name/description`）
- `props`：道具列表（每项 `name/description`）
- 以及 `outline/openingHook/keyEvents/emotionalCurve/visualHighlights/endingHook/classicQuotes` 等结构化剧情字段

保存动作是工具调用：

- **`saveStoryline`**：写入/更新 `t_storyline`
- **`saveOutline`**：写入 `t_outline.data`（JSON 字符串）并自动创建空 `t_script` 记录（`content=""`）

### 资产抽取（人物/场景/物品是怎么来的？）

在这个项目里，“抽取”实际发生在两个层面：

1. **LLM 先把实体写进结构化大纲**（`EpisodeData.characters/scenes/props`）
2. **再从所有大纲里汇总去重，写进资产库 `t_assets`**

第 2 步由 `OutlineScript` 的工具 **`generateAssets`** 完成：

- 它会遍历本项目全部 `t_outline.data`
- 把 `characters/props/scenes` 拉平汇总
- 按 `name` 去重
- 以 `type=角色/道具/场景` upsert 到 `t_assets`
  - `intro = description`
  - `prompt = description`（初始时直接用描述，后续可再“润色提示词”）

因此，项目里“人物/场景/物品”的主来源是：**大纲 JSON 里结构化的 name/description**，然后被同步到 `t_assets`。

---

## Step 3：资产提示词如何格式化与润色（Prompt 配合点）

### 资产提示词润色接口

`POST /assets/polishAssetsPrompt`（`src/routes/assets/polishAssetsPrompt.ts`）

用途：把“资产描述（describe）+ 原文片段 + 项目信息（风格/类型/背景）”交给文本模型，输出更适合绘图的 **`prompt`**。

关键点：

- 它会扫描 **所有** `t_outline.data`，构建 “某个资产 name 出现在哪些 chapterRange” 的映射
- 针对 `role/scene/props`：
  - 根据该资产的 `chapterRange` 去 `t_novel` 抽取原文片段并合并
  - 将“原文片段 + 项目风格/类型/背景 + 资产 name/describe”写入 user prompt
- system prompt 来自 `t_prompts`：
  - `role-polish`
  - `scene-polish`
  - `tool-polish`
  - `storyboard-polish`
- 模型映射 key：`u.getPromptAi("assetsPrompt")`

输出为结构化 JSON：`{ prompt: string }`（由 `u.ai.text.invoke(..., output: { prompt: z.string() })` 约束）

### 本步骤涉及的系统预设提示词（`t_prompts.code`）与代码路径

- **角色润色**：`role-polish`  
  - **使用位置**：`src/routes/assets/polishAssetsPrompt.ts`（当 `type=="role"`）
- **场景润色**：`scene-polish`  
  - **使用位置**：`src/routes/assets/polishAssetsPrompt.ts`（当 `type=="scene"`）
- **道具润色**：`tool-polish`  
  - **使用位置**：`src/routes/assets/polishAssetsPrompt.ts`（当 `type=="props"`）
- **分镜润色**：`storyboard-polish`  
  - **使用位置**：`src/routes/assets/polishAssetsPrompt.ts`（当 `type=="storyboard"`）

### 本步骤涉及的模型配置 key（`getPromptAi(key)`）

- **`assetsPrompt`**（文本模型）  
  - **使用位置**：`src/routes/assets/polishAssetsPrompt.ts`

---

## Step 4：资产图片如何生成（角色/场景/道具/分镜）

`POST /assets/generateAssets`（`src/routes/assets/generateAssets.ts`）

用途：把某个资产的 `prompt`（通常是“润色后”）交给图片模型生成图片，写入 OSS，并更新 `t_image` 状态。

关键点：

- system prompt 来自 `t_prompts`：
  - `role-generateImage`
  - `scene-generateImage`
  - `tool-generateImage`
  - `storyboard-generateImage`
- 生成时会插入一条 `t_image`，`state="生成中"`，成功后更新为 `生成成功` 并写入 `filePath/type`
- 图片写入 OSS 的路径按类型分目录：
  - `/${projectId}/role/*.jpg`
  - `/${projectId}/scene/*.jpg`
  - `/${projectId}/props/*.jpg`
  - `/${projectId}/storyboard/*.jpg`
- 图片模型映射 key：`u.getPromptAi("assetsImage")`

### 本步骤涉及的系统预设提示词（`t_prompts.code`）与代码路径

- **角色出图 system**：`role-generateImage`  
  - **使用位置**：`src/routes/assets/generateAssets.ts`（当 `type=="role"`）
- **场景出图 system**：`scene-generateImage`  
  - **使用位置**：`src/routes/assets/generateAssets.ts`（当 `type=="scene"`）
- **道具出图 system**：`tool-generateImage`  
  - **使用位置**：`src/routes/assets/generateAssets.ts`（当 `type=="props"`）
- **分镜出图 system**：`storyboard-generateImage`  
  - **使用位置**：`src/routes/assets/generateAssets.ts`（当 `type=="storyboard"`）

### 本步骤涉及的模型配置 key（`getPromptAi(key)`）

- **`assetsImage`**（图片模型）  
  - **使用位置**：`src/routes/assets/generateAssets.ts`

---

## Step 5：剧本如何生成（结构化大纲 + 原文参考）

### 入口接口

`POST /script/generateScriptApi`（`src/routes/script/generateScriptApi.ts`）

输入：`outlineId`、`scriptId`

流程：

1. 读取 `t_outline.data`（该集大纲 JSON），拿到 `chapterRange`
2. 从 `t_novel` 按 `chapterRange` 抽取原文章节，合并为 `novelData` 文本
3. 调用 `src/utils/generateScript.ts` 的 `generateScript(episode, novelText)`
4. 将生成结果写入 `t_script.content`

### Prompt 如何配合

`src/utils/generateScript.ts`：

- system prompt：从 `t_prompts` 取 `code="script"`（customValue 优先）
- user prompt：由代码拼接，强调：
  - **剧情主干 `outline` 是最高优先级**
  - 镜头顺序/情绪曲线/金句/结尾等硬约束
  - 附上“结构化大纲数据”和“原文参考”
- 模型映射 key：`u.getPromptAi("generateScript")`

### 本步骤涉及的系统预设提示词（`t_prompts.code`）与代码路径

- **剧本 system**：`script`  
  - **使用位置**：`src/utils/generateScript.ts`（`u.db("t_prompts").where("code","script")`）

### 本步骤涉及的模型配置 key（`getPromptAi(key)`）

- **`generateScript`**（文本模型）  
  - **使用位置**：`src/utils/generateScript.ts`

---

## Step 6：分镜脚本与分镜图如何生成（Storyboard Agent）

### 入口：WebSocket

- **`WS /storyboard/chatStoryboard?projectId=...&scriptId=...`**（`src/routes/storyboard/chatStoryboard.ts`）

它创建 `new Storyboard(projectId, scriptId)`，然后把前端消息转发给 `agent.call(...)`，并通过 emitter 回传：

- `data`（流式 token）
- `toolCall`
- `subAgentStream/subAgentEnd`
- `refresh` 等

### Storyboard 的子代理与工具分工

文件：`src/agents/storyboard/index.ts`

Storyboard 本身维护两份关键状态：

- `segments[]`：片段（segmentAgent 输出）
- `shots[]`：分镜（shotAgent 输出；每个 shot 有多个 cell，每个 cell 对应一个镜头 prompt）

它用两个 Sub-Agent 来完成“剧本→分镜”的拆解：

- **segmentAgent（片段师）**：Prompt code `storyboard-segment`
  - 可用工具：`getScript`、`getAssets`、`updateSegments`
  - 目标：把整集剧本拆成若干片段，并调用 `updateSegments` 保存

- **shotAgent（分镜师）**：Prompt code `storyboard-shot`
  - 可用工具：`getScript`、`getAssets`、`getSegments`、`addShots/updateShots/deleteShots`、`generateShotImage`
  - 目标：为每个片段生成镜头提示词（中文），写入 `shots[].cells[].prompt`

主 Agent 的总控 prompt code：`storyboard-main`

模型映射 key：`u.getPromptAi("storyboardAgent")`

### 本步骤涉及的系统预设提示词（`t_prompts.code`）与代码路径

- **Storyboard 主控（main）**：`storyboard-main`  
  - **使用位置**：`src/agents/storyboard/index.ts` → `call()` 里读取并拼到 `system`
- **片段师（segmentAgent）**：`storyboard-segment`  
  - **使用位置**：`src/agents/storyboard/index.ts` → `invokeSubAgent("segmentAgent")`
- **分镜师（shotAgent）**：`storyboard-shot`  
  - **使用位置**：`src/agents/storyboard/index.ts` → `invokeSubAgent("shotAgent")`

### 本步骤涉及的模型配置 key（`getPromptAi(key)`）

- **`storyboardAgent`**（文本模型，用于：分段、分镜、资产相关性筛选等）  
  - **使用位置**：`src/agents/storyboard/index.ts`、`src/agents/storyboard/generateImageTool.ts`

### “资产一致性”是如何保证的？

Storyboard 提供了工具 **`getAssets`**，它不是直接读 `t_assets`，而是读该剧本对应的大纲 `t_outline.data`，并生成一个强约束文本：

- 以 `<资产列表>...</资产列表>` 输出角色/道具/场景的 **name + description**
- 附带硬规则：
  1) 必须原封不动使用资产名称  
  2) 禁止加前后缀修饰  
  3) 禁止捏造列表外资产

因此，shotAgent 生成镜头 prompt 时，理论上会被迫对齐 `OutlineScript` 抽取出来的资产命名。

---

## Step 7：分镜“出图”具体是怎么做的（宫格图 → 切图）

### 生成入口（两种）

1. **Agent 内部工具**：`Storyboard.generateShotImage`  
   - 由 shotAgent 通过工具调用触发（建议的主路径）
2. **HTTP 直接调用**：`POST /storyboard/generateShotImage`（`src/routes/storyboard/generateShotImage.ts`）  
   - 直接调用 `generateImageTool(cells, scriptId, projectId)` 返回 buffer

### 核心实现：`generateImageTool`

文件：`src/agents/storyboard/generateImageTool.ts`

关键步骤：

- **输入**：多个镜头 prompt（cells）
- **读取**：
  - `t_script`（找到 `outlineId`）
  - `t_outline.data`（得到当前集的 `characters/props/scenes`）
  - `t_assets`（按上述 name 列表取到有 `filePath` 的资产图：角色/场景/道具）
- **过滤相关资产（AI 选择参考图）**：
  - 调用文本模型（key：`storyboardAgent`）让 AI 从“可用资产列表”筛选出与本次镜头 prompts 直接相关的资产
  - 避免把所有资产图塞给绘图模型（有大小/数量限制）
- **生成“绘图用最终 prompt”**：
  - 调用 `generateImagePromptsTool(...)`（内部会产出宫格布局与最终 prompt 文本）
  - 组合 project 的 `type/artStyle/videoRatio` 进入 style 参数
- **喂给图片模型生成宫格图**：
  - `u.ai.image({ systemPrompt: assetsName=图片1... 的对照映射, prompt: 最终prompt, imageBase64: 参考图 }, apiConfig)`
  - 图片模型映射 key：`u.getPromptAi("storyboardImage")`
- **输出**：返回宫格图的二进制 buffer（PNG/JPG base64 解码而来）

### 本步骤涉及的系统预设提示词（`t_prompts.code`）与代码路径

- **宫格分镜提示词优化（把多格镜头 prompt 组织成“可直接喂给图片模型”的最终 prompt）**：`generateImagePrompts`  
  - **使用位置**：`src/agents/storyboard/generateImagePromptsTool.ts`（`u.db("t_prompts").where("code","generateImagePrompts")`）  
  - **调用链**：`src/agents/storyboard/generateImageTool.ts` → `generateImagePromptsTool(...)` → 读取 `generateImagePrompts` 并调用文本模型生成最终 prompt

### 本步骤涉及的模型配置 key（`getPromptAi(key)`）

- **`storyboardAgent`**（文本模型，用于：把多格镜头 prompts 优化为“宫格图最终绘图 prompt”）  
  - **使用位置**：`src/agents/storyboard/generateImagePromptsTool.ts`
- **`storyboardImage`**（图片模型，生成宫格分镜图）  
  - **使用位置**：`src/agents/storyboard/generateImageTool.ts`

### 切图与保存（Agent 内部）

文件：`src/agents/storyboard/index.ts`

在 `generateShotImage` 的后台任务里：

- 先用 `generateImageTool` 生成一张“宫格分镜图”
- 再用 `imageSplitting(gridImage, prompts.length)` 切成单张镜头图
- 保存到 OSS：
  - `${projectId}/chat/${scriptId}/storyboard/shot_${shotId}_take_${i}_${timestamp}.png`
- 把每个 cell 的 `src` 更新为 OSS 的可访问 URL，并触发事件：
  - `shotImageGenerateProgress`
  - `shotImageGenerateComplete`
  - `shotsUpdated`

---

## Step 8：从分镜图生成视频提示词 & 生成视频

项目里视频生成分两段：

1. **生成视频提示词**（对单张分镜/镜头图做 video prompt）  
   - 路由：`POST /storyboard/generateVideoPrompt`（`src/routes/storyboard/generateVideoPrompt.ts`）
   - 会读取 `t_script.content`（整集剧本）与传入的 `storyboardPrompt + ossPath(src)`
   - 产出：`videoPrompt / duration / name` 等字段（返回给前端/后续保存）

2. **异步生成视频文件**  
   - 路由：`POST /video/generateVideo`（`src/routes/video/generateVideo.ts`）
   - 先插入 `t_video`（`state=0`），立即返回 `videoId`
   - 后台异步 `generateVideoAsync(...)` 执行真正的视频生成与落盘（并更新 `t_video` 状态/错误原因等）

### 本步骤涉及的系统预设提示词（`t_prompts.code`）

- **视频 Motion Prompt system**：当前 **硬编码在代码里**，不走 `t_prompts`  
  - **使用位置**：`src/routes/storyboard/generateVideoPrompt.ts`（常量 `prompt`，作为 system message）
  - **建议（便于复用到新项目）**：把这段 prompt 下沉到 `t_prompts.code`（例如 `videoMotionPrompt`），并在 `generateSingleVideoPrompt` 里按统一模式读取 `customValue ?? defaultValue`

### 本步骤涉及的模型配置 key（`getPromptAi(key)`）

- **`videoPrompt`**（文本模型，用于：结合“剧本 + 分镜图 + 分镜提示词”生成 Motion Prompt JSON）  
  - **使用位置**：`src/routes/storyboard/generateVideoPrompt.ts`
- **视频生成所用视频模型 key**：由 `/video/generateVideo` 的配置选择逻辑决定（不在本文档这次读取范围内；入口在 `src/routes/video/generateVideo.ts` 的 `generateVideoAsync`）

---

## Prompt 与模型配置是如何被选中的？

### Prompt（模板）来源：`t_prompts`

全项目统一模式：

- 通过 `code` 找到提示词记录
- 优先使用 `customValue`，否则使用 `defaultValue`
- 找不到时会回退到“AI配置异常/Agent配置异常”的兜底字符串

本流程涉及的关键 `code`（非穷举）：

- **OutlineScript**：
  - `outlineScript-main`
  - `outlineScript-a1`
  - `outlineScript-a2`
  - `outlineScript-director`
- **剧本**：
  - `script`
- **资产提示词润色**：
  - `role-polish` / `scene-polish` / `tool-polish` / `storyboard-polish`
- **资产图片生成 system prompt**：
  - `role-generateImage` / `scene-generateImage` / `tool-generateImage` / `storyboard-generateImage`
- **Storyboard**：
  - `storyboard-main`
  - `storyboard-segment`
  - `storyboard-shot`

### 模型配置来源：`getPromptAi`

文件：`src/utils/getPromptAi.ts`

- 传入一个 key（例如：`outlineScriptAgent` / `storyboardAgent` / `generateScript` / `assetsImage` 等）
- 优先走内置 `modelList`（通过环境变量 `AI_{MANUFACTURER}_KEY/URL` 取 key 与 baseURL）
- 否则从数据库 `t_aiModelMap` → `t_config` 左连接取模型配置

因此，**Prompt（内容）与模型（厂商/Key/BaseURL/Model）是两套可配置系统**：  
Prompt 在 `t_prompts`，模型映射在 `t_aiModelMap/t_config` 或 `.env`。

---

## 一个“最常见”的实践顺序（建议 UI/产品操作）

- **导入章节**：`/novel/addNovel`
- **打开大纲 Agent（WS）**：让 AI1 生成故事线 → AI2 生成大纲 → director 审核 → `generateAssets` 生成资产库
- **资产 prompt 润色**：对角色/场景/道具分别调用 `/assets/polishAssetsPrompt`
- **生成资产图**：调用 `/assets/generateAssets`（角色/场景/道具）
- **生成剧本**：`/script/generateScriptApi`（每集/每条 outline 对应一个 script）
- **打开分镜 Agent（WS）**：segmentAgent 生成片段 → shotAgent 生成镜头 prompts → generateShotImage 出图
- **（可选）保存分镜图到资产**：`/storyboard/saveStoryboard`（把 filePath/prompt 写回 `t_assets`）
- **生成视频提示词/视频**：`/storyboard/generateVideoPrompt` → `/video/generateVideo`

---

## 关键文件索引（按链路）

- **小说入库**：`src/routes/novel/addNovel.ts`
- **大纲 Agent（WS）**：`src/routes/outline/agentsOutline.ts` → `src/agents/outlineScript/index.ts`
- **资产 prompt 润色**：`src/routes/assets/polishAssetsPrompt.ts`
- **资产图生成**：`src/routes/assets/generateAssets.ts`
- **剧本生成**：`src/routes/script/generateScriptApi.ts` → `src/utils/generateScript.ts`
- **分镜 Agent（WS）**：`src/routes/storyboard/chatStoryboard.ts` → `src/agents/storyboard/index.ts`
- **分镜图生成核心**：`src/agents/storyboard/generateImageTool.ts`（参考资产过滤 + 最终绘图 prompt + 出宫格图）
- **分镜图保存**：`src/routes/storyboard/saveStoryboard.ts`
- **视频提示词**：`src/routes/storyboard/generateVideoPrompt.ts`
- **视频生成**：`src/routes/video/generateVideo.ts`

