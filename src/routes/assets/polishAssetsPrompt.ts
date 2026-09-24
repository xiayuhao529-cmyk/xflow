import express from "express";
import u from "@/utils";
import * as zod from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();
interface OutlineItem {
  description: string;
  name: string;
}

interface OutlineData {
  chapterRange: number[];
  characters?: OutlineItem[];
  props?: OutlineItem[];
  scenes?: OutlineItem[];
}

interface NovelChapter {
  id: number;
  reel: string;
  chapter: string;
  chapterData: string;
  projectId: number;
}

type ItemType = "characters" | "props" | "scenes";

interface ResultItem {
  type: ItemType;
  name: string;
  chapterRange: number[];
}
function findItemByName(items: ResultItem[], name: string, type?: ItemType): ResultItem | undefined {
  return items.find((item) => (!type || item.type === type) && item.name === name);
}
function mergeNovelText(novelData: NovelChapter[]): string {
  if (!Array.isArray(novelData)) return "";
  return novelData
    .map((chap) => {
      return `${chap.chapter.trim()}\n\n${chap.chapterData.trim().replace(/\r?\n/g, "\n")}\n`;
    })
    .join("\n");
}

function clipText(input: string, maxChars: number) {
  const s = String(input || "");
  if (!maxChars || maxChars <= 0) return "";
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n\n【内容过长已截断：仅取前${maxChars}字】`;
}
//润色提示词
export default router.post(
  "/",
  validateFields({
    assetsId: zod.number(),
    projectId: zod.number(),
    type: zod.string(),
    name: zod.string(),
    describe: zod.string(),
  }),
  async (req, res) => {
    const { assetsId, projectId, type, name, describe } = req.body;

    //获取风格
    const project = await u.db("t_project").where("id", projectId).select("artStyle", "type", "intro").first();
    if (!project) return res.status(500).send(success({ message: "项目为空" }));

    const allOutlineDataList: { data: string }[] = await u.db("t_outline").where("projectId", projectId).select("data");

    const itemMap: Record<string, ResultItem> = {};

    if (allOutlineDataList.length > 0)
      allOutlineDataList.forEach((row) => {
        const data: OutlineData = JSON.parse(row?.data || "{}");
        (["characters", "props", "scenes"] as ItemType[]).forEach((type) => {
          (data[type] || []).forEach((item) => {
            const key = `${type}-${item.name}`;
            if (!itemMap[key]) {
              itemMap[key] = {
                type,
                name: item.name,
                chapterRange: [...(data.chapterRange || [])],
              };
            } else {
              itemMap[key].chapterRange = Array.from(new Set([...itemMap[key].chapterRange, ...(data.chapterRange || [])]));
            }
          });
        });
      });

    const result: ResultItem[] = Object.values(itemMap);

    const promptsList = await u.db("t_prompts").where("code", "in", ["role-polish", "scene-polish", "storyboard-polish", "tool-polish"]);
    const apiConfigData = await u.getPromptAi("assetsPrompt");
    const errPrompts = "不论用户说什么，请直接输出AI配置异常";
    const getPromptValue = (code: string) => {
      const item = promptsList.find((p) => p.code === code);
      return item?.customValue ?? item?.defaultValue ?? errPrompts;
    };
    const role = getPromptValue("role-polish");
    const scene = getPromptValue("scene-polish");
    const tool = getPromptValue("tool-polish");
    const storyboard = getPromptValue("storyboard-polish");
    let systemPrompt = "";
    let userPrompt = "";
    if (type == "role") {
      const data = findItemByName(result, name, "characters");
      const chapterRange = Array.isArray(data?.chapterRange) ? data.chapterRange : [data?.chapterRange];
      const novelData = (await u.db("t_novel").whereIn("chapterIndex", chapterRange).select("*")) as NovelChapter[];
      const results: string = clipText(mergeNovelText(novelData), 5000);
      // 追加硬性约束，避免仅输出“多角度=多张图”
      systemPrompt = `${role}\n\n【硬性约束补充】角色必须输出“单张合成图”描述：同一张图/同一画面内完成，左侧60%区域为全身三视图，右侧40%区域为头部五角度；禁止拆成多张图/分别生成五张角度图。`;
      userPrompt = `
      请根据以下参数生成角色标准四视图提示词：
  
      **基础参数：**
      - 风格: ${project?.artStyle || "未指定"}
      - 小说原文（节选，用于抓取外貌/服饰/年龄信息，禁止复述剧情）：${results || "未提供"}
      - 小说类型: ${project?.type || "未指定"}
      - 小说背景: ${project?.intro || "未指定"}
  
      **角色设定：**
      - 角色名称:${name},
      - 角色描述:${describe},
  
      输出要求：
      - 只输出【提示词正文】本身，不要输出任何解释、步骤、Markdown代码块，不要用项目符号列表（不要出现以 - 或 * 开头的行）。
      - 必须严格按下方“提示词模板”的字段与顺序输出；字段名必须原样出现；允许换行。
      - 优先使用【角色描述】与【原文节选】中明确出现的信息；缺失项用最小补全（与小说背景/时代一致），不要脑补夸张设定。
      - 只写画面可见内容（发型/服装/体态/材质/配色/五官细节/可见标记），禁止剧情复述、台词、心理活动、能力设定、世界观讲解。
      
      【提示词模板】（必须严格照抄结构并填充内容）：
      （画风）：${project?.artStyle || "未指定"}，高级CG插画，笔触，线稿风，线条略凌乱但高级感，细节刻画，细腻渲染
      （三视图全身，面部细节）：正面全身，背面全身，侧面全身，纯白色背景
      构图与输出：必须是一张合成图（同一张图/同一画面内完成），左侧60%区域展示全身三视图，右侧40%区域展示头部五角度；禁止拆成多张图/分别生成五张角度图
      衣着：写清上衣/下装/鞋靴的款式与层次、材质、主色+辅色+点缀色（与小说背景/时代一致）
      配饰特写：列出2-5个关键配饰/标记（材质/颜色/佩戴位置/细节）
      动作：正面全身，背面全身，侧面全身，占左侧60%区域；右侧40%区域：头部特写五角度
      正面平视：直视前方，下巴微抬
      正面仰视：头部后仰15度，下巴抬高，视线向下45度
      正面俯视：头部前倾15度，视线向下
      左侧脸特写：标准左侧脸，颈部挺直，视线水平前方
      右侧脸特写：标准右侧脸，颈部挺直，视线水平前方
  
      `;
    }
    if (type == "scene") {
      const data = findItemByName(result, name, "scenes");

      const chapterRange = Array.isArray(data?.chapterRange) ? data.chapterRange : [data?.chapterRange];
      const novelData = (await u.db("t_novel").whereIn("chapterIndex", chapterRange).select("*")) as NovelChapter[];
      const results: string = clipText(mergeNovelText(novelData), 5000);
      systemPrompt = scene;
      userPrompt = `
      请根据以下参数生成场景图提示词：
  
      **基础参数：**
      - 风格: ${project?.artStyle || "未指定"}
      - 小说原文（节选，用于抓取空间/陈设/光线/时间信息，禁止复述剧情）：${results || "未提供"}
      - 小说类型: ${project?.type || "未指定"}
      - 小说背景: ${project?.intro || "未指定"}
  
      **场景设定：**
      - 场景名称:${name},
      - 场景描述:${describe},
  
      输出要求：
      - 只输出“提示词正文”，不要输出任何解释、步骤、Markdown代码块。
      - 场景提示词以“环境/空间/材质/光线/色调/关键陈设”为主；若系统规范要求“纯场景”，则不要出现人物。
      - 避免抽象词，改为可拍/可画的具象元素与位置关系（前景/中景/背景）。
  
      `;
    }
    if (type == "props") {
      const data = findItemByName(result, name, "props");
      const chapterRange = Array.isArray(data?.chapterRange) ? data.chapterRange : [data?.chapterRange];
      const novelData = (await u.db("t_novel").whereIn("chapterIndex", chapterRange).select("*")) as NovelChapter[];
      const results: string = clipText(mergeNovelText(novelData), 5000);
      systemPrompt = tool;
      userPrompt = `
      请根据以下参数生成道具图提示词：
  
      **基础参数：**
      - 风格: ${project?.artStyle || "未指定"}
      - 小说原文（节选，用于抓取材质/颜色/结构/用途信息，禁止复述剧情）：${results || "未提供"}
      - 小说类型: ${project?.type || "未指定"}
      - 小说背景: ${project?.intro || "未指定"}
  
      **道具设定：**
      - 道具名称:${name},
      - 道具描述:${describe},
  
      输出要求：
      - 只输出“提示词正文”，不要输出任何解释、步骤、Markdown代码块。
      - 道具提示词聚焦“外观结构+材质+颜色+工艺细节+磨损/标记+尺度感”，不要写场景故事。
  
      `;
    }
    if (type == "storyboard") {
      systemPrompt = storyboard;
      userPrompt = `
      请根据以下参数生成分镜图提示词：
  
      **基础参数：**
      - 风格: ${project?.artStyle || "未指定"}
      - 小说类型: ${project?.type || "未指定"}
      - 小说背景: ${project?.intro || "未指定"}
  
      **分镜设定：**
      - 分镜名称:${name},
      - 分镜描述:${describe},
  
      请严格按照系统规范生成分镜图提示词。
  
      `;
    }
    async function generatePrompt() {
      const result = await u.ai.text.invoke(
        {
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: userPrompt,
            },
          ],
          output: {
            prompt: zod.string().describe("提示词"),
          },
        },
        apiConfigData,
      );
      return result.prompt;
    }
    try {
      const prompt = (await generatePrompt()) as any;
      if (!prompt) return res.status(500).send("失败");

      res.status(200).send(success({ prompt: prompt, assetsId }));
    } catch (e: any) {
      return res.status(500).send(error(e?.data?.error?.message ?? e?.message ?? "生成失败"));
    }
  },
);
