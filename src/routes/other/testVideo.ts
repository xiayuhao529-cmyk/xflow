import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
const router = express.Router();

// 检查语言模型
export default router.post(
  "/",
  validateFields({
    modelName: z.string().optional(),
    apiKey: z.string(),
    baseURL: z.string().optional(),
    manufacturer: z.string(),
  }),
  async (req, res) => {
    const { modelName, apiKey, baseURL, manufacturer } = req.body;
    try {
      const duration = manufacturer == "gemini" ? 4 : 5;
      const videoPath = await u.ai.video(
        {
          imageBase64: [],
          savePath: "test.mp4",
          prompt: "stickman Dances",
          duration: duration,
          resolution: "720p",
          aspectRatio: "16:9",
          audio: false,
          mode: "single",
          taskClass: "测试视频生成",
          name: "测试视频生成",
          describe: "测试视频生成",
          projectId: 0,
        },
        {
          model: modelName,
          apiKey,
          baseURL,
          manufacturer,
        },
      );
      const url = await u.oss.getFileUrl(videoPath);
      res.status(200).send(success(url));
    } catch (err: any) {
      const msg = u.error(err).message;
      console.error(msg);
      res.status(500).send(error(msg));
    }
  },
);
