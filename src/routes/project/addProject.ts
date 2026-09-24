import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 新增项目
export default router.post(
  "/",
  validateFields({
    projectType: z.string().optional(),
    name: z.string(),
    intro: z.string(),
    type: z.string(),
    artStyle: z.string(),
    videoRatio: z.string(),
  }),
  async (req, res) => {
    const { projectType, name, intro, type, artStyle, videoRatio } = req.body;

    await u.db("t_project").insert({
      name,
      intro,
      type,
      artStyle,
      videoRatio,
      userId: 1,
      createTime: Date.now(),
    });

    res.status(200).send(success({ message: "新增项目成功" }));
  },
);
