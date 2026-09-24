import express from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
const router = express.Router();

// 图片项schema
const imageItemSchema = z
  .object({
    id: z.number(),
    filePath: z.string(),
    prompt: z.string().optional(),
  })
  .nullable();

// 新增视频配置
export default router.post(
  "/",
  validateFields({
    scriptId: z.number(),
    projectId: z.number(),
    configId: z.number(),
    mode: z.enum(["startEnd", "multi", "single", "text", ""]),
    startFrame: imageItemSchema.optional(),
    endFrame: imageItemSchema.optional(),
    images: z
      .array(
        z.object({
          id: z.number(),
          filePath: z.string(),
          prompt: z.string().optional(),
        }),
      )
      .optional(),
    resolution: z.string(),
    duration: z.number(),
    prompt: z.string().optional(),
    audioEnabled: z.boolean(),
  }),
  async (req, res) => {
    const { scriptId, projectId, configId, mode, startFrame, endFrame, images, resolution, duration, prompt, audioEnabled } = req.body;

    // 生成新ID
    const maxIdResult: any = await u.db("t_videoConfig").max("id as maxId").first();
    const newId = (maxIdResult?.maxId || 0) + 1;
    const now = Date.now();
    const configData = await u.db("t_config").where("id", configId).first();
    if (!configData) return res.status(500).send(error("不存在的模型"));
    // 插入数据
    await u.db("t_videoConfig").insert({
      id: newId,
      scriptId,
      projectId,
      manufacturer: configData.manufacturer,
      aiConfigId: configId,
      mode,
      startFrame: startFrame ? JSON.stringify(startFrame) : null,
      endFrame: endFrame ? JSON.stringify(endFrame) : null,
      images: images ? JSON.stringify(images) : null,
      resolution,
      duration,
      prompt: prompt || "",
      selectedResultId: null,
      createTime: now,
      updateTime: now,
      audioEnabled: audioEnabled ? 1 : 0,
    });

    res.status(200).send(
      success({
        message: "新增视频配置成功",
        data: {
          id: newId,
          scriptId,
          projectId,
          manufacturer: configData.manufacturer,
          aiConfigId: configId,
          model: configData.model,
          mode,
          startFrame,
          endFrame,
          images: images || [],
          resolution,
          duration,
          prompt: prompt || "",
          selectedResultId: null,
          createdAt: new Date(now).toISOString(),
          audioEnabled: audioEnabled,
        },
      }),
    );
  },
);
