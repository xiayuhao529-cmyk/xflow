import u from "@/utils";
import OutlineScript from "@/agents/outlineScript";
import Storyboard from "@/agents/storyboard";
import { generateScript, type Episode } from "@/utils/generateScript";

type PipelineResult = {
  outlinesInserted: number;
  outlinesUpdated: number;
  outlinesSkipped: number;

  assetsInserted: number;
  assetsUpdated: number;
  assetsSkipped: number;

  scriptsGenerated: number;
  scriptsSkipped: number;

  storyboardsWritten: number;
  storyboardsSkipped: number;

  warnings: Array<{ code: string; message: string; data?: any }>;
};

type RunFullAssetPipelineInput = {
  projectId: number;
  overwrite?: boolean;
};

type AssetType = "角色" | "道具" | "场景";

function safeParseJson<T>(s: any, fallback: T): T {
  try {
    return JSON.parse(String(s ?? ""));
  } catch {
    return fallback;
  }
}

function mergeNovelText(novelData: Array<{ chapter?: string | null; chapterData?: string | null }>): string {
  if (!Array.isArray(novelData)) return "";
  return novelData
    .map((chap) => `${String(chap.chapter || "").trim()}\n\n${String(chap.chapterData || "").trim().replace(/\r?\n/g, "\n")}\n`)
    .join("\n");
}

function uniqueByName(items: Array<{ name: string; description: string }>) {
  const m = new Map<string, { name: string; description: string }>();
  for (const it of items) {
    const key = String(it?.name || "").trim();
    if (!key) continue;
    if (!m.has(key)) m.set(key, { name: key, description: String(it.description || "").trim() });
  }
  return Array.from(m.values());
}

async function upsertAsset(projectId: number, type: AssetType, item: { name: string; description: string }) {
  const existing = await u.db("t_assets").where({ projectId, type, name: item.name }).first();
  if (!existing) {
    await u.db("t_assets").insert({
      projectId,
      type,
      name: item.name,
      intro: item.description,
      prompt: item.description,
    });
    return "inserted" as const;
  }
  if (String(existing.intro || "") !== item.description) {
    await u.db("t_assets").where({ id: existing.id }).update({ intro: item.description, prompt: item.description });
    return "updated" as const;
  }
  return "skipped" as const;
}

async function upsertAssetsFromOutlines(projectId: number) {
  const outlines = await u.db("t_outline").select("data").where({ projectId });
  const allChars: Array<{ name: string; description: string }> = [];
  const allProps: Array<{ name: string; description: string }> = [];
  const allScenes: Array<{ name: string; description: string }> = [];

  for (const row of outlines) {
    const data = safeParseJson<any>(row.data, {});
    if (Array.isArray(data.characters)) allChars.push(...data.characters.map((x: any) => ({ name: x.name, description: x.description })));
    if (Array.isArray(data.props)) allProps.push(...data.props.map((x: any) => ({ name: x.name, description: x.description })));
    if (Array.isArray(data.scenes)) allScenes.push(...data.scenes.map((x: any) => ({ name: x.name, description: x.description })));
  }

  const chars = uniqueByName(allChars);
  const props = uniqueByName(allProps);
  const scenes = uniqueByName(allScenes);

  const stats = { inserted: 0, updated: 0, skipped: 0 };
  for (const c of chars) stats[(await upsertAsset(projectId, "角色", c))]++;
  for (const p of props) stats[(await upsertAsset(projectId, "道具", p))]++;
  for (const s of scenes) stats[(await upsertAsset(projectId, "场景", s))]++;
  return stats;
}

async function ensureOutlinesAndStoryline(projectId: number, overwrite: boolean, warnings: PipelineResult["warnings"]) {
  // 通过 outlineAgent 的主提示词调度：故事线 -> 大纲
  const agent = new OutlineScript(projectId);
  const novelData = await u.db("t_novel").where({ projectId }).orderBy("chapterIndex", "asc");
  agent.setNovel(novelData as any);

  const existed = await u.db("t_outline").where({ projectId }).count({ c: "*" }).first();
  const hasOutline = Number((existed as any)?.c || 0) > 0;
  if (hasOutline && !overwrite) {
    return { inserted: 0, updated: 0, skipped: 1 };
  }

  const task = [
    "请为当前项目生成故事线与剧集大纲，并在生成后立即提取资产。",
    "硬性要求：必须调用工具保存结果（saveStoryline/saveOutline），并在大纲生成后调用 generateAssets 提取资产。",
    overwrite ? "覆盖重跑：overwrite=true（清空旧大纲后重建）" : "断点续跑：若已有大纲则可补全缺失，但不要重复生成无必要内容",
  ].join("\n");

  try {
    await agent.call(task);
    return { inserted: 1, updated: 0, skipped: 0 };
  } catch (e: any) {
    warnings.push({ code: "OUTLINE_AGENT_FAILED", message: e?.message || "outline agent failed" });
    throw e;
  }
}

async function ensureScripts(projectId: number, overwrite: boolean) {
  // 基于 t_outline + 原文生成 t_script.content
  const outlines = await u.db("t_outline").select("id", "data").where({ projectId }).orderBy("episode", "asc");
  if (!outlines.length) return { generated: 0, skipped: 0 };

  const scripts = await u.db("t_script").select("id", "outlineId", "content").where({ projectId });
  const byOutlineId = new Map<number, any>();
  for (const s of scripts) if (s.outlineId != null) byOutlineId.set(Number(s.outlineId), s);

  let generated = 0;
  let skipped = 0;

  for (const o of outlines) {
    const episode = safeParseJson<Episode>(o.data, {} as any);
    const scriptRow = byOutlineId.get(Number(o.id));
    if (!scriptRow) {
      skipped++;
      continue;
    }
    if (!overwrite && String(scriptRow.content || "").trim()) {
      skipped++;
      continue;
    }
    const chapterRange = Array.isArray((episode as any)?.chapterRange) ? (episode as any).chapterRange : [];
    const novelData = await u.db("t_novel").where({ projectId }).whereIn("chapterIndex", chapterRange).select("*");
    const novelText = mergeNovelText(novelData as any);
    const content = await generateScript(episode as any, novelText);
    await u.db("t_script").where({ id: scriptRow.id, projectId }).update({ content });
    generated++;
  }

  return { generated, skipped };
}

async function writeStoryboardPromptsAsAssets(projectId: number, overwrite: boolean, warnings: PipelineResult["warnings"]) {
  // 用 storyboardAgent 生成片段+分镜提示词，并将“提示词”落入 t_assets(type=分镜)（不生成图片）
  const scripts = await u.db("t_script").select("id", "name", "content").where({ projectId });
  let written = 0;
  let skipped = 0;

  for (const s of scripts) {
    const scriptId = Number(s.id);
    const hasContent = String(s.content || "").trim().length > 0;
    if (!hasContent) {
      warnings.push({ code: "SCRIPT_EMPTY", message: `scriptId=${scriptId} 内容为空，跳过分镜生成` });
      skipped++;
      continue;
    }

    if (overwrite) {
      // 仅删除自动生成且没有图片的分镜提示词（避免误删用户已生成的分镜图）
      await u
        .db("t_assets")
        .where({ projectId, scriptId, type: "分镜" })
        .andWhere((qb: any) => qb.whereNull("filePath").orWhere("filePath", ""))
        .andWhere("remark", "auto_chat")
        .delete();
    }

    // 如果已经存在自动生成的 prompts 且不覆盖，则跳过
    if (!overwrite) {
      const existingCount = await u
        .db("t_assets")
        .where({ projectId, scriptId, type: "分镜", remark: "auto_chat" })
        .count({ c: "*" })
        .first();
      if (Number((existingCount as any)?.c || 0) > 0) {
        skipped++;
        continue;
      }
    }

    const agent = new Storyboard(projectId, scriptId);
    try {
      await agent.call("生成片段，并为所有片段生成4格分镜提示词；严格基于剧本与资产名称；生成后必须保存分镜结果。");
    } catch (e: any) {
      warnings.push({ code: "STORYBOARD_AGENT_FAILED", message: `scriptId=${scriptId} 分镜生成失败：${e?.message || e}` });
      skipped++;
      continue;
    }

    const segments = agent.getSegmentsData();
    const shots = agent.getShotsData();

    if (!Array.isArray(shots) || shots.length === 0) {
      warnings.push({ code: "STORYBOARD_EMPTY", message: `scriptId=${scriptId} 分镜结果为空，跳过写入` });
      skipped++;
      continue;
    }

    const segMap = new Map<number, any>();
    for (const seg of segments || []) segMap.set(Number((seg as any).index), seg);

    const rows: any[] = [];
    for (const shot of shots) {
      const segmentId = Number((shot as any).segmentId || 0);
      const seg = segMap.get(segmentId);
      const segDesc = String(seg?.description || (shot as any).fragmentContent || "").trim();
      const cells = Array.isArray((shot as any).cells) ? (shot as any).cells : [];
      for (let i = 0; i < cells.length; i += 1) {
        const cell = cells[i];
        const prompt = String(cell?.prompt || "").trim();
        if (!prompt) continue;
        rows.push({
          projectId,
          scriptId,
          type: "分镜",
          name: `${String(s.name || "剧本").trim()}-片段${segmentId}-镜头${i + 1}`,
          intro: segDesc,
          prompt,
          videoPrompt: "",
          duration: "",
          filePath: "",
          segmentId,
          shotIndex: i + 1,
          remark: "auto_chat",
        });
      }
    }

    if (rows.length) {
      await u.db("t_assets").insert(rows);
      written++;
    } else {
      warnings.push({ code: "STORYBOARD_PROMPTS_EMPTY", message: `scriptId=${scriptId} 没有可写入的 prompt` });
      skipped++;
    }
  }

  return { written, skipped };
}

export async function runFullAssetPipeline(input: RunFullAssetPipelineInput): Promise<PipelineResult> {
  const projectId = Number(input.projectId);
  const overwrite = Boolean(input.overwrite);
  const warnings: PipelineResult["warnings"] = [];

  const result: PipelineResult = {
    outlinesInserted: 0,
    outlinesUpdated: 0,
    outlinesSkipped: 0,
    assetsInserted: 0,
    assetsUpdated: 0,
    assetsSkipped: 0,
    scriptsGenerated: 0,
    scriptsSkipped: 0,
    storyboardsWritten: 0,
    storyboardsSkipped: 0,
    warnings,
  };

  // 1) Outline + Storyline（用 agent 生成）
  const outlineStats = await ensureOutlinesAndStoryline(projectId, overwrite, warnings);
  result.outlinesInserted += outlineStats.inserted;
  result.outlinesUpdated += outlineStats.updated;
  result.outlinesSkipped += outlineStats.skipped;

  // 2) Assets from outlines（落库到 t_assets：角色/场景/道具）
  const assetsStats = await upsertAssetsFromOutlines(projectId);
  result.assetsInserted = assetsStats.inserted;
  result.assetsUpdated = assetsStats.updated;
  result.assetsSkipped = assetsStats.skipped;

  // 3) Scripts（t_script.content）
  const scriptsStats = await ensureScripts(projectId, overwrite);
  result.scriptsGenerated = scriptsStats.generated;
  result.scriptsSkipped = scriptsStats.skipped;

  // 4) Storyboard prompts（落库到 t_assets(type=分镜)，不生成图片）
  const sbStats = await writeStoryboardPromptsAsAssets(projectId, overwrite, warnings);
  result.storyboardsWritten = sbStats.written;
  result.storyboardsSkipped = sbStats.skipped;

  return result;
}

