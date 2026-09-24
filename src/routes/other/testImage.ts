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
      const image = await u.ai.image(
        {
          prompt:
            "一张16:9比例的图片，完美等分为2x2四宫格布局，各区域无缝衔接：\n左上宫格：一只可爱的猫，毛发蓬松，眼睛明亮，姿态俏皮\n右上宫格：一只友善的狗，金毛犬，表情愉悦，摇着尾巴\n左下宫格：一头健壮的牛，田园背景，目光温和，皮毛光泽\n右下宫格：一匹骏马，姿态优雅，鬃毛飘逸，肌肉健美\n风格要求：四个宫格风格统一，色彩鲜艳饱和，高清画质，细节清晰锐利，专业插画风格，线条干净，统一的左上方光源，柔和阴影，和谐配色，卡通/半写实风格，宫格间用白色或浅灰细线分隔",
          imageBase64: [],
          aspectRatio: "9:16",
          size: "4K",
          taskClass: "测试任务",
          name: "测试图片生成",
          describe: "测试语言模型生成图片",
          projectId: 0,
        },
        {
          model: modelName,
          apiKey,
          baseURL,
          manufacturer,
        },
      );
      res.status(200).send(success(image));
    } catch (err) {
      console.log("%c Line:41 🍖 err", "background:#fca650", err);
      const msg = u.error(err).message;
      console.error(msg);
      res.status(500).send(error(msg));
    }
  },
);
