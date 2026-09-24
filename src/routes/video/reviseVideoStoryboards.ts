import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 修改视频分镜参数
export default router.post(
  "/",
  validateFields({
    storyboardId: z.number(),
    prompt: z.string(),
    duration: z.string(),
  }),
  async (req, res) => {
    const { storyboardId, prompt, duration } = req.body;

    await u.db("t_assets").where("id", storyboardId).update({
      prompt,
      duration,
    });
    res.status(200).send({ message: "修改成功" });
  }
);
