---
name: storyboard_designer
description: Text-based storyboard creation from script analysis. Creates detailed shot-by-shot breakdowns for film, animation, or video production. Use when: (1) Given script analysis from script_analyzer (including character descriptions, scene environments, and AI image prompts), (2) Need to plan visual storytelling through camera shots, angles, and movement, (3) Creating production-ready storyboard documents for directors, cinematographers, or animators. **This skill outputs text-based storyboards only - NO image drawing or generation.**
---

# Storyboard Designer (Text-Based)

## Overview

The Storyboard Designer transforms script analysis and visual prompts into detailed, shot-by-shot storyboards. It plans visual storytelling through camera work, composition, lighting, and pacing—producing text-based storyboard documents suitable for production teams. **No image drawing or generation is involved; all outputs are textual descriptions and metadata.**

## 短剧分镜脚本格式 (Short Drama Storyboard Format)

针对短视频/短剧制作，本技能支持专业的分镜脚本格式，包含以下8个关键字段：

### 字段说明
1. **序号** - 镜头顺序编号 (1, 2, 3...)
2. **时长** - 镜头持续时间范围 (如"0-3秒"、"3-6秒")
3. **镜头类型** - 具体的镜头类别 (如"特写镜头"、"快速切镜"、"慢动作镜头")
4. **镜头内容** - 必须以三个前缀开头（可与后续画面描写连成一段）：**【场景】**写 §4 场景清单中的**具体地点/场名**（如「宁府书房·夜」），禁止只写「场景1」而无地点信息；**【人物】**写 §3 中的**真实姓名**（如「宁宸、宁兴」），禁止用「关键角色」「主角」「人物关系」等统称；**【道具/物品】**写画面中关键物件，无则写「无」。前缀之后继续写动作、表情、构图、光影等细节，须具体到可开拍。
5. **景别** - 拍摄距离和范围 (如"特写"、"近景"、"中景"、"全景")
6. **运镜方式** - 摄像机运动方式 (如"固定镜头"、"快速推镜"、"轻微拉镜+慢放")
7. **音效/台词** - 声音元素 (音乐、音效、角色对白)
8. **剪辑要点** - 编辑意图和效果说明 (如"聚焦手部动作，用细节强化紧张感")

### 格式示例（含【场景】【人物】【道具/物品】）
```
序号 时长 镜头类型 镜头内容 景别 运镜方式 音效/台词 剪辑要点
1 0-3秒 建立镜头 【场景】宁府正厅·日 【人物】宁宸、宁兴 【道具/物品】八仙桌、青瓷茶盏；全景建立厅堂纵深，宁宸坐主位，宁兴立于一侧，交代对峙空间关系 全景 缓慢推进 厅堂环境音、远处蝉鸣 用具体地名与人名锚定时空，禁止「场景1+空间关系」式空话
2 3-6秒 情绪特写 【场景】宁府正厅·日 【人物】宁宸 【道具/物品】茶盏；宁宸执盏的手指收紧，指节发白，目光沉冷 特写 固定镜头 宁宸（压低声音）：「你再说一遍。」 情绪压在细节，台词写清说话人姓名
3 6-9秒 冲突镜头 【场景】宁府正厅·日 【人物】宁宸、宁兴 【道具/物品】无；二人同框中景，宁兴上前半步与宁宸对视，构图左宁兴右宁宸 中景 轻微拉镜 配乐骤紧、衣料摩擦声 对峙关系写清谁在左/右，姓名与清单一致
```

### 反例（禁止输出）
- 「镜头内容」仅写「场景1 空间关系建立」「关键角色表情」「人物关系同框对峙」而无**具体场景名、真实姓名**。
- 「音效/台词」仅写「关键台词」而不写「角色名：对白」。

### 输出适配
本技能默认支持此格式输出，同时保持向后兼容性，可根据用户需求在传统故事板格式和短剧分镜格式间切换。

## Storyboard Workflow

### 1. Input Integration
- **Script Analysis**: Scene breakdown, character positions, action descriptions
- **Visual Prompts**: Character appearances, environment visuals, mood references
- **Directorial Notes**: Style preferences, pacing requirements, emphasis points

### 2. Shot Planning Process
For each scene:
1. **Break into beats**: Identify key moments that need separate shots
2. **Choose shot types**: Select appropriate camera framing for each beat
3. **Plan camera movement**: Decide on pans, tilts, zooms, or static shots
4. **Determine composition**: Frame characters, set depth, balance elements
5. **Specify lighting**: Match mood, highlight key elements
6. **Estimate timing**: Calculate shot duration based on action and dialogue

### 3. Storyboard Assembly
- Organize shots in sequence
- Add technical specifications
- Include production notes
- Format for readability

## Shot Types and Their Uses

### Standard Shot Sizes
1. **Extreme Wide Shot (EWS) / Establishing Shot**
   - **Purpose**: Show location, scale, environment
   - **Framing**: Very far from subject, shows full setting
   - **Use**: Scene openings, location transitions
   - **Example**: "EWS of cyberpunk city at night, neon skyscrapers towering over rain-slicked streets"

2. **Wide Shot (WS) / Full Shot**
   - **Purpose**: Show subject in environment
   - **Framing**: Entire subject visible with surroundings
   - **Use**: Character entrances, group scenes
   - **Example**: "WS of detective entering office, full body visible with desk and window behind"

3. **Medium Shot (MS)**
   - **Purpose**: Show subject from waist up
   - **Framing**: Waist to head, some environment
   - **Use**: Dialogue scenes, character interactions
   - **Example**: "MS of two characters at table, faces and upper bodies visible"

4. **Medium Close-Up (MCU)**
   - **Purpose**: Focus on subject with some context
   - **Framing**: Chest to head
   - **Use**: Emotional moments, important dialogue
   - **Example**: "MCU of character's face as they receive shocking news"

5. **Close-Up (CU)**
   - **Purpose**: Intimate view, emotional emphasis
   - **Framing**: Shoulders to head
   - **Use**: Emotional reactions, detail emphasis
   - **Example**: "CU of eyes widening in realization"

6. **Extreme Close-Up (ECU)**
   - **Purpose**: Dramatic emphasis, detail focus
   - **Framing**: Part of face or small object
   - **Use**: Tension, symbolism, important details
   - **Example**: "ECU of clock hands reaching midnight"

### Camera Angles
1. **Eye Level**
   - **Effect**: Neutral, natural perspective
   - **Use**: Standard storytelling, audience identification

2. **Low Angle**
   - **Effect**: Power, dominance, threat
   - **Use**: Making subject look powerful or intimidating

3. **High Angle**
   - **Effect**: Vulnerability, weakness, isolation
   - **Use**: Making subject look small or vulnerable

4. **Dutch Angle / Tilt**
   - **Effect**: Unease, tension, disorientation
   - **Use**: Psychological tension, action scenes

5. **Bird's Eye View**
   - **Effect**: Omniscient, detached, patterned
   - **Use**: Showing layouts, patterns, geography

6. **Worm's Eye View**
   - **Effect**: Dramatic, monumental, overwhelming
   - **Use**: Emphasizing height, scale, architecture

### Camera Movement
1. **Static / Fixed**
   - **Effect**: Stability, observation, classic
   - **Use**: Dialogue, straightforward storytelling

2. **Pan** (horizontal rotation)
   - **Effect**: Surveying, following, revealing
   - **Use**: Following action, showing landscape

3. **Tilt** (vertical rotation)
   - **Effect**: Revealing height, looking up/down
   - **Use**: Showing tall objects, character entrances

4. **Zoom** (lens focal length change)
   - **Effect**: Emphasis, surprise, intensity
   - **Use**: Focusing attention, dramatic reveals

5. **Dolly / Tracking** (camera physically moves)
   - **Effect**: Smooth following, immersion
   - **Use**: Following characters, exploring spaces

6. **Crane / Jib** (vertical movement)
   - **Effect**: Grand, sweeping, epic
   - **Use**: Large-scale reveals, transitions

7. **Handheld**
   - **Effect**: Urgent, realistic, documentary
   - **Use**: Action scenes, realism, tension

## Storyboard Entry Structure

### 短剧分镜脚本格式 (Short Drama Format)
针对短视频/短剧制作的优化格式，包含8个核心字段：

```
序号 时长 镜头类型 镜头内容 景别 运镜方式 音效/台词 剪辑要点
[Number] [Duration] [Shot Type] [Shot Content] [Frame Size] [Camera Movement] [Sound/Dialogue] [Editing Notes]
```

**字段映射说明**:
- **序号** ↔ SHOT [Number]
- **时长** ↔ TIME (格式化为"开始-结束秒")
- **镜头类型** ↔ TYPE (中文化，如"特写镜头"、"快速切镜")
- **镜头内容** ↔ ACTION + CHARACTERS + COMPOSITION 的综合描述
- **景别** ↔ Shot size 的中文对应 (特写/近景/中景/全景)
- **运镜方式** ↔ MOVEMENT 的中文描述
- **音效/台词** ↔ SOUND (包含音效和具体台词)
- **剪辑要点** ↔ NOTES 的剪辑专项说明

### Basic Shot Description (传统格式)
```
SHOT [Number]: [Scene].[Shot]
TYPE: [Shot size] from [Angle]
ACTION: [What happens in shot]
CHARACTERS: [Who is visible]
COMPOSITION: [Framing details]
MOVEMENT: [Camera movement]
LIGHTING: [Light quality and direction]
SOUND: [Audio elements]
TIME: [Estimated duration]
NOTES: [Production considerations]
```

### Detailed Example (传统格式)
```
SHOT 12: 3.4
TYPE: Medium Close-Up from low angle
ACTION: Detective confronts suspect, slams evidence folder on table
CHARACTERS: Detective Miller (foreground), Suspect (background slightly out of focus)
COMPOSITION: Miller dominates frame, suspect blurred behind him. Miller's face fills left 2/3, evidence folder in sharp focus on table.
MOVEMENT: Static for 2 seconds, then slow push-in as Miller leans forward
LIGHTING: Hard key light from top-left creates dramatic shadows on Miller's face. Backlight separates him from background.
SOUND: Folder slam, tense music swell, diegetic clock ticking
TIME: 5 seconds
NOTES: Key emotional beat. Miller's anger must read clearly. Lighting contrast emphasizes moral conflict.
```

### 短剧分镜示例 (Short Drama Format Example)
```
序号 时长 镜头类型 镜头内容 景别 运镜方式 音效/台词 剪辑要点
12 0-5秒 中近景镜头 侦探米勒正面低角度，与嫌犯对峙，将证据文件夹猛拍在桌上 中近景 静止2秒后缓慢推近 文件夹拍击声、紧张音乐渐强、时钟滴答声 关键情感爆发点，米勒的愤怒必须清晰传达，灯光对比强调道德冲突
13 5-8秒 特写镜头 嫌犯的反应，眼睛睁大，嘴唇微颤，额头渗出细汗 特写 固定镜头 时钟滴答声持续，背景音乐暂停 聚焦恐惧表情，与米勒的愤怒形成对比，营造紧张对峙氛围
14 8-12秒 全景镜头 两人对峙的完整画面，办公室环境，散乱的文件，雨滴打在窗户上 全景 缓慢拉远 雨声渐入，远处警笛声（微弱） 拉远展现人物与环境的孤独感，雨景强化忧郁氛围
```

### 5. 短剧分镜表格格式 (Short Drama Table Format)
专为短剧/短视频制作的表格格式，使用Markdown表格清晰展示8个字段：

**Markdown表格格式**：
```markdown
| 序号 | 时长 | 镜头类型 | 镜头内容 | 景别 | 运镜方式 | 音效/台词 | 剪辑要点 |
|------|------|----------|----------|------|----------|-----------|----------|
| 1 | 0-3秒 | 特写镜头 | 【场景】家中客厅·夜 【人物】南溪 【道具/物品】孕检单；南溪右手五指攥紧孕检单，指节泛白，纸面褶皱 | 特写 | 固定镜头 | 急促的心跳声（渐入） | 前缀后写清是谁的肢体与何物 |
| 2 | 3-6秒 | 快速切镜 | 【场景】家中客厅·夜 【人物】陆见深 【道具/物品】离婚协议；侧脸线条冷峻，捏协议，眼神无波 | 近景 | 快速推镜 | 纸张摩擦声；陆见深（冷嗓，低沉）：「签字，提前结束婚姻」 | 台词必须带角色名 |
| 3 | 6-9秒 | 全景镜头 | 【场景】家中客厅·夜 【人物】南溪、陆见深 【道具/物品】散落文件；二人对峙全景，窗外雨景 | 全景 | 缓慢拉远 | 雨声渐入，远处雷声（微弱） | 同框须列齐出镜人物姓名 |
```

**表格格式优势**：
- **直观清晰**：表格形式便于快速浏览和比较
- **对齐整齐**：所有字段对齐，便于观看
- **易于复制**：可直接复制到文档或演示文稿
- **可读性强**：比纯文本格式更易阅读和理解

**输出示例**：
```
## 短剧分镜脚本 - 《雁城志》第一集

### 场景：萧惊鸿被驱逐

| 序号 | 时长 | 镜头类型 | 镜头内容 | 景别 | 运镜方式 | 音效/台词 | 剪辑要点 |
|------|------|----------|----------|------|----------|-----------|----------|
| 1 | 0-4秒 | 特写镜头 | 萧惊鸿的手紧紧握住剑柄，青筋暴起，关节发白 | 特写 | 轻微颤抖 | 急促呼吸声，剑鞘摩擦声 | 开篇聚焦手部细节，建立紧张感和力量感 |
| 2 | 4-8秒 | 快速切镜 | 萧惊鸿的面部特写，眼神震惊而愤怒，嘴角渗血 | 特写 | 快速推近 | 众人呵斥声（混响）：“逆贼！拿下！” | 推近镜头强化情感冲击，展现主角被背叛的瞬间 |
| 3 | 8-12秒 | 全景镜头 | 萧惊鸿站在大殿中央，周围围着一圈持刀侍卫，烛光摇曳 | 全景 | 缓慢旋转 | 脚步声围拢，金属碰撞声，低沉鼓点 | 展现空间关系和敌我对比，旋转镜头营造被包围的压迫感 |
```

**保存文件名**：`{场景ID}_短剧分镜表格_{时间戳}.md` 或 `{场景ID}_短剧分镜表格_{时间戳}.csv`

## Scene Breakdown Methodology

### 1. Beat Analysis
Identify key moments within a scene:
- **Dialogue beats**: Each significant line or exchange
- **Action beats**: Physical movements, gestures, reactions
- **Emotional beats**: Changes in mood, realization, tension shifts
- **Informational beats**: Exposition, reveals, plot points

### 2. Shot Assignment
Assign appropriate shots to beats:
- **One-shot beats**: Single important moment gets its own shot
- **Sequence beats**: Multiple related actions in shot series
- **Reaction beats**: Cutaways to character responses
- **Establishing/resetting**: Re-establish location or relationships

### 3. Continuity Planning
Ensure visual consistency:
- **Eye lines**: Direction characters look
- **Screen direction**: Movement continuity left/right
- **Position continuity**: Character/object placement
- **Temporal continuity**: Time progression clarity

### 4. Pacing Calculation
Estimate shot durations:
- **Dialogue shots**: 2-4 seconds per line
- **Reaction shots**: 1-3 seconds
- **Action shots**: Varies by complexity
- **Establishing shots**: 3-5 seconds
- **Total scene time**: Sum of all shots

## Integration with Previous Steps

### From Script Analyzer
**Input**: Scene breakdown with:
- Character positions and movements
- Dialogue lines and emotional beats
- Scene location and time
- Plot significance markers

**Processing**:
1. Map script action to visual beats
2. Assign shots based on emotional intensity
3. Plan coverage for dialogue exchanges
4. Consider location constraints

### From Script Analyzer
**Input**: Script analysis with:
- Character profiles with detailed appearance descriptions
- Scene environment descriptions and lighting cues
- AI image prompts for characters and scenes
- Visual style recommendations and color palettes

**Processing**:
1. Transform character and scene descriptions into shot specifications
2. Implement lighting setups based on scene analysis
3. Use suggested color palettes for scene consistency
4. Apply visual style references to camera work

## Storyboard Formats

### 格式选择指南
根据制作需求选择合适的格式：
- **短剧/短视频制作**: 使用 **短剧分镜脚本格式** (5号格式) 或 **短剧分镜表格格式** (6号格式)
- **快速参考/头脑风暴**: 使用 **Text-Only Storyboard** (1号格式)  
- **生产团队协作**: 使用 **Detailed Shot List** (2号格式) 或 **Production-Ready Document** (4号格式)
- **程序化处理/集成**: 使用 **JSON Storyboard** (3号格式)
- **表格形式观看**: 使用 **短剧分镜表格格式** (6号格式，Markdown表格)

### 0. 短剧分镜脚本格式 (Short Drama Format)
专为短视频/短剧优化的结构化格式：

```
序号 时长 镜头类型 镜头内容 景别 运镜方式 音效/台词 剪辑要点
1 0-3秒 特写镜头 南溪的右手，五指用力攥着孕检单，指节泛白，纸张被捏出褶皱 特写 固定镜头 急促的心跳声（渐入） 聚焦手部动作，用细节强化紧张感，开篇直接抓注意力
2 3-6秒 快速切镜 陆见深的侧脸，线条冷峻，手中捏着离婚协议，眼神无波无澜 近景 快速推镜 纸张摩擦声；陆见深（冷嗓，低沉）：“签字，提前结束婚姻” 推镜聚焦面部冷漠，与前一镜头的紧张感形成反差，5秒内抛出核心冲突
```

**字段说明**:
- **序号**: 镜头顺序 (连续编号)
- **时长**: 精确到秒的时间范围 (如"0-3秒")
- **镜头类型**: 具体镜头类别 (特写镜头、快速切镜、慢动作镜头等)
- **镜头内容**: 详细的视觉描述 (动作、表情、环境)
- **景别**: 拍摄范围 (特写、近景、中景、全景)
- **运镜方式**: 摄像机运动 (固定、推、拉、摇、移、跟)
- **音效/台词**: 声音元素 (音效、音乐、角色对白)
- **剪辑要点**: 编辑意图和效果说明

### 1. Text-Only Storyboard
Simple paragraph format for quick reference:

```
Scene 3: Office Confrontation
- Shot 3.1: WS establishing - Miller's office at night, rain on window
- Shot 3.2: MS two-shot - Miller and client facing each other across desk  
- Shot 3.3: CU Miller - Reacting to client's revelation
- Shot 3.4: CU client - Delivering key information
- Shot 3.5: MS - Miller stands, begins pacing
- Shot 3.6: EWS - Pull back to show isolation in large office
```

### 2. Detailed Shot List
Structured table format for production:

| Shot | Scene.Shot | Type | Action | Characters | Movement | Time | Notes |
|------|------------|------|--------|------------|----------|------|-------|
| 12 | 3.4 | MCU low angle | Miller slams folder | Miller, Suspect | Push-in | 5s | Key emotional beat |
| 13 | 3.5 | CU | Suspect's reaction | Suspect | Static | 3s | Fear must show |
| 14 | 3.6 | MS | Both in frame | Both | Pan left | 4s | Tension holds |

### 3. JSON Storyboard
Programmatic format for integration:

```json
{
  "storyboard": {
    "project": "Detective Noir",
    "scene": "Office Confrontation",
    "shots": [
      {
        "shot_id": "3.4",
        "shot_number": 12,
        "shot_type": "Medium Close-Up",
        "angle": "low angle",
        "action": "Detective confronts suspect, slams evidence folder",
        "characters": ["Detective Miller", "Suspect"],
        "composition": "Miller foreground dominant, suspect blurred background",
        "camera_movement": "static then slow push-in",
        "lighting": "hard key light top-left, dramatic shadows",
        "sound": ["folder slam", "tense music", "clock ticking"],
        "duration_seconds": 5,
        "notes": "Key emotional beat, lighting contrast for moral conflict"
      }
    ]
  }
}
```

### 4. Production-Ready Document
Comprehensive format for distribution:

```
STORYBOARD - SCENE 3: OFFICE CONFRONTATION

SHOT 3.1 (ESTABLISHING)
- TYPE: Extreme Wide Shot
- ACTION: Establish Miller's office at night
- COMPOSITION: Rain-streaked window, desk lamp pool of light
- MOVEMENT: Slow zoom out
- LIGHTING: High contrast, noir style
- SOUND: Rain, distant traffic, melancholy saxophone
- TIME: 4 seconds
- NOTES: Set moody atmosphere

SHOT 3.2 (TWO-SHOT)
- TYPE: Medium Shot
- ACTION: Miller and client face each other across desk
- COMPOSITION: Over-the-shoulder on Miller, client in background
- MOVEMENT: Static
- LIGHTING: Key light on Miller, client in partial shadow
- SOUND: Dialogue begins, tension in music
- TIME: 6 seconds
- NOTES: Eye contact must be clear
```

### 6. 短剧分镜表格格式 (Short Drama Table Format)
专为短剧/短视频制作的表格格式，使用Markdown表格清晰展示8个字段：

**Markdown表格格式**：
```markdown
## 短剧分镜脚本 - 《雁城志》第一集

### 场景：萧惊鸿被驱逐

| 序号 | 时长 | 镜头类型 | 镜头内容 | 景别 | 运镜方式 | 音效/台词 | 剪辑要点 |
|------|------|----------|----------|------|----------|-----------|----------|
| 1 | 0-4秒 | 特写镜头 | 萧惊鸿的手紧紧握住剑柄，青筋暴起，关节发白 | 特写 | 轻微颤抖 | 急促呼吸声，剑鞘摩擦声 | 开篇聚焦手部细节，建立紧张感和力量感 |
| 2 | 4-8秒 | 快速切镜 | 萧惊鸿的面部特写，眼神震惊而愤怒，嘴角渗血 | 特写 | 快速推近 | 众人呵斥声（混响）：“逆贼！拿下！” | 推近镜头强化情感冲击，展现主角被背叛的瞬间 |
| 3 | 8-12秒 | 全景镜头 | 萧惊鸿站在大殿中央，周围围着一圈持刀侍卫，烛光摇曳 | 全景 | 缓慢旋转 | 脚步声围拢，金属碰撞声，低沉鼓点 | 展现空间关系和敌我对比，旋转镜头营造被包围的压迫感 |
| 4 | 12-16秒 | 中景镜头 | 萧惊鸿缓缓抬头，目光扫过周围的敌人，眼神从愤怒转为坚定 | 中景 | 缓慢上摇 | 众人窃窃私语声，烛火噼啪声 | 展现主角心理转变，上摇镜头暗示内心的崛起 |
| 5 | 16-20秒 | 慢动作镜头 | 萧惊鸿突然拔剑，剑光一闪，周围的侍卫后退半步 | 中近景 | 慢动作处理 | 剑出鞘的金属长鸣，风声呼啸 | 慢动作强化关键动作，剑光作为视觉焦点 |
```

**表格格式优势**：
- **直观清晰**：表格形式便于快速浏览和比较
- **对齐整齐**：所有字段对齐，便于观看
- **易于复制**：可直接复制到文档或演示文稿
- **可读性强**：比纯文本格式更易阅读和理解
- **结构规范**：强制8个字段的完整性，避免遗漏
- **便于整理**：可作为生产文档直接使用

**保存文件名**：
- `{场景ID}_短剧分镜表格_{时间戳}.md` - Markdown表格格式
- `{场景ID}_短剧分镜表格_{时间戳}.csv` - CSV表格格式（可用Excel打开）

**与其他格式的关系**：
- 本格式是 **0. 短剧分镜脚本格式** 的表格化版本
- 数据与JSON格式兼容，可相互转换
- 可作为 **2. Detailed Shot List** 的中文短剧专用版本
- 适合生成生产就绪的短剧分镜文档

## Directorial Considerations

### Style Implementation
- **Noir**: High contrast, dramatic shadows, Dutch angles
- **Action**: Dynamic camera, quick cuts, handheld movement
- **Romance**: Soft focus, gentle moves, warm lighting
- **Horror**: Unsettling angles, slow reveals, shadow play
- **Comedy**: Wide shots for physical humor, reaction shots

### Pacing Strategies
- **Fast pace**: Short shots (1-3 seconds), quick cuts, handheld
- **Slow pace**: Longer shots (5-10+ seconds), slow moves, static
- **Building tension**: Gradually shorter shots as climax approaches
- **Release**: Longer shot after climax for emotional processing

### Emotional Guidance
- **Intimacy**: Close-ups, shallow focus, soft lighting
- **Conflict**: Dutch angles, tight framing, harsh lighting
- **Revelation**: Push-in, light change, sound design emphasis
- **Isolation**: Wide shots, empty space around subject

## Technical Specifications

### Aspect Ratio Considerations
- **Cinematic (2.35:1)**: Epic landscapes, negative space for composition
- **TV (16:9)**: Standard framing, safe areas for titles
- **Square (1:1)**: Intimate, focused, artistic
- **Vertical (9:16)**: Mobile-first, close-ups work well

### Frame Rate Implications
- **24fps (film)**: Cinematic motion blur, traditional
- **30fps (video)**: Smooth motion, TV standard
- **60fps+**: Ultra-smooth, action/sports, slow-motion potential

### Color Space Notes
- **Black and white**: Focus on contrast, texture, composition
- **Limited palette**: Emphasize specific colors for mood
- **High saturation**: Vibrant, energetic, stylized
- **Desaturated**: Realistic, gritty, somber

## Quality Assurance Checklist

### Storyboard Completeness
- [ ] Every scene beat has appropriate shot coverage
- [ ] Shot transitions are logical and smooth
- [ ] Continuity is maintained (eye lines, screen direction)
- [ ] Pacing matches scene emotional arc
- [ ] Technical notes are clear for production team

### Visual Storytelling Effectiveness
- [ ] Shot choices support emotional intent
- [ ] Composition guides viewer attention appropriately
- [ ] Camera movement enhances rather than distracts
- [ ] Lighting supports mood and time of day
- [ ] Style consistency throughout sequence

### Production Practicality
- [ ] Shots are achievable with described resources
- [ ] Lighting setups are realistically specified
- [ ] Camera movements are physically possible
- [ ] Timing estimates are accurate
- [ ] Special requirements are clearly noted

## Quick Start Examples

### Example 1: Dialogue Scene
```
Input: Two characters arguing in kitchen from script analysis

Process:
1. Break argument into emotional beats
2. Assign shot-reverse-shot for dialogue
3. Add reaction shots for key moments
4. Plan camera movement for intensity shifts
5. Specify lighting to match emotional tone
6. Calculate timing based on dialogue length
```

### Example 2: Action Sequence
```
Input: Car chase scene with fast pacing

Process:
1. Identify key action beats (start, pursuit, close call, resolution)
2. Use dynamic camera movements (handheld, quick pans)
3. Vary shot sizes for rhythm (wide establishing, close-up details)
4. Plan continuity for spatial clarity
5. Add technical notes for special effects/safety
```

### Example 3: Emotional Reveal
```
Input: Character discovering truth in quiet moment

Process:
1. Start wide to establish isolation
2. Slow push-in as realization dawns
3. Extreme close-up for emotional peak
4. Hold on reaction for emotional processing
5. Pull back to show changed perspective
```

## References

For detailed cinematography principles and shot planning:
- `references/cinematography_basics.md` - Camera work fundamentals
- `references/visual_storytelling.md` - Using shots to tell stories
- `references/production_planning.md` - From storyboard to production

## Scripts

- `scripts/generate_storyboard.py` - Core storyboard generation from inputs
- `scripts/calculate_pacing.py` - Timing and rhythm calculations
- `scripts/validate_storyboard.py` - Consistency and completeness checks

## Assets

- `assets/templates/storyboard_json.json` - JSON template for storyboard data
- `assets/templates/shot_list.csv` - CSV template for production shot lists
- `assets/examples/storyboard_samples.md` - Example storyboards by genre

## 输出保存规则

### 自动保存系统
Storyboard Designer 集成自动输出保存系统，根据剧本项目目录保存所有故事板文件。

### 保存目录结构
```
/root/.openclaw/workspace/projects/
└── {剧本名}_项目/                    # 剧本分析创建的目录
    ├── storyboarding/              # 故事板输出
    │   ├── scenes/                 # 按场景组织
    │   │   ├── {场景ID}_故事板.json  # JSON格式故事板数据
    │   │   ├── {场景ID}_故事板.md    # Markdown格式故事板
    │   │   ├── {场景ID}_镜头列表.csv  # CSV格式镜头列表
    │   │   └── {场景ID}_生产文档.md   # 生产团队专用文档
    │   ├── shot_lists/             # 镜头列表
    │   │   └── {场景ID}_镜头详情.csv  # 详细镜头数据
    │   ├── exports/                # 导出格式
    │   │   ├── {场景ID}_故事板.pdf    # PDF格式（如生成）
    │   │   └── {场景ID}_简报.pptx     # 演示文稿（如生成）
    │   └── storyboard_master.json  # 完整故事板主文件
    └── project_metadata.json       # 项目元数据（自动更新）
```

### 文件名生成规则
1. **继承项目目录**: 使用script_analyzer创建的同一项目目录
2. **场景故事板命名**: `{场景ID}_故事板_{版本}_{时间戳}.{格式}`
   - 示例: `SCENE_1_故事板_v1_20240316_1130.json`
   - 示例: `办公室对峙_故事板_final_20240316_1145.md`
3. **镜头列表命名**: `{场景ID}_镜头列表_{时间戳}.csv`
   - 示例: `SCENE_1_镜头列表_20240316_1130.csv`
4. **生产文档命名**: `{场景ID}_生产文档_{时间戳}.md`
   - 示例: `SCENE_1_生产文档_20240316_1130.md`

### 保存内容清单
每次生成自动保存以下文件：

| 文件类型 | 文件名模式 | 内容描述 | 目标用户 |
|----------|------------|----------|----------|
| JSON故事板 | `{场景ID}_故事板.json` | 完整故事板数据结构 | 程序化处理 |
| Markdown故事板 | `{场景ID}_故事板.md` | 人类可读的故事板描述 | 导演/团队 |
| CSV镜头列表 | `{场景ID}_镜头列表.csv` | 表格格式的镜头数据 | 制片/调度 |
| 生产文档 | `{场景ID}_生产文档.md` | 详细的生产要求和说明 | 各部门 |
| 短剧分镜表格 | `{场景ID}_短剧分镜表格.md` | Markdown表格格式的短剧分镜脚本 | 导演/制片/观看 |
| 主故事板 | `storyboard_master.json` | 所有场景的整合故事板 | 项目管理 |

### 多格式输出
每个场景生成4种格式的文件：

1. **JSON格式**: 完整的结构化数据，包含所有元数据
   ```json
   {
     "scene": "SCENE_1",
     "shots": [...],
     "metadata": {...},
     "timing": {...}
   }
   ```

2. **Markdown格式**: 人类可读的描述，适合阅读和分享
   ```markdown
   # 场景: SCENE_1 - 办公室对峙
   
   ## 镜头 1.1
   - 类型: 宽镜头
   - 角度: 水平视角
   - 动作: 侦探进入办公室
   - 时长: 5秒
   ```

3. **CSV格式**: 表格数据，适合导入到制片软件
   ```csv
   镜头号,类型,角度,动作,角色,时长,备注
   1.1,宽镜头,水平,进入办公室,侦探米勒,5,建立场景
   ```

4. **生产文档**: 详细的技术要求和说明
   ```markdown
   ## 技术需求
   - 灯光: 硬光顶灯，创造阴影
   - 设备: 轨道车用于推近镜头
   - 道具: 旧式台灯、散乱文件
   ```

### 使用方法
在Python脚本中集成输出管理器：

```python
# 导入输出管理器
sys.path.append('/root/.openclaw/workspace/projects')
from output_manager import ScriptOutputManager

# 使用现有项目目录
script_path = "/path/to/侦探故事.txt"
output_mgr = ScriptOutputManager(script_path)

# 保存故事板数据
storyboard_data = {
    "scene": "SCENE_1",
    "shots": [...],
    "total_duration": 120
}
output_mgr.save_storyboard("SCENE_1", storyboard_data)

# 保存镜头列表（CSV格式）
shot_list = [
    {"shot_id": "1.1", "shot_type": "WIDE", "duration": 5},
    {"shot_id": "1.2", "shot_type": "CLOSEUP", "duration": 3}
]
output_mgr.save_shot_list("SCENE_1", shot_list)

# 获取项目摘要
output_mgr.print_summary()
```

### 版本管理
支持故事板的多版本迭代：
- **v1**: 初版故事板（基本镜头规划）
- **v2**: 修订版（调整节奏和构图）
- **v3**: 技术版（添加生产细节）
- **final**: 最终批准版本
- **production**: 生产版本（包含所有技术规格）

### 与前置步骤集成
1. **输入来源**: 读取script_analysis目录下的场景分析
2. **视觉参考**: 读取asset_generation目录下的提示词
3. **文件关联**: 通过场景ID关联所有相关文件
4. **版本追溯**: 可追溯到生成该故事板的原始分析数据

### 生产就绪检查
每个故事板文件包含生产就绪检查清单：

```markdown
## 生产就绪检查
- [ ] 所有镜头有明确的类型和角度
- [ ] 镜头时长估算合理
- [ ] 连续性检查通过（眼线、屏幕方向）
- [ ] 技术需求明确（灯光、设备、道具）
- [ ] 安全注意事项已标注
- [ ] 预算影响已评估
```

### 批量处理支持
支持批量生成和保存：
1. 读取所有场景分析，批量生成故事板
2. 为每个场景生成全套格式文件
3. 创建统一的主故事板文件
4. 生成项目整体的时长和资源汇总

### 协作与生产流程
- **导演**: 查看Markdown故事板，提出修改意见
- **摄影指导**: 查看技术细节，规划拍摄方案
- **制片**: 使用CSV镜头列表进行日程安排
- **美术部门**: 根据生产文档准备道具和布景
- **后期制作**: 使用JSON数据规划剪辑流程

### 导出与共享
- 所有文件按标准格式保存，便于团队共享
- 支持导出为PDF、PPT等演示格式
- 可与制片管理软件（如ShotGrid、F-track）集成
- 提供清晰的文件命名和版本管理，避免生产混乱