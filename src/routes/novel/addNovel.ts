import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 新增原文数据
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    data: z.array(
      z.object({
        index: z.number(),
        reel: z.string(),
        chapter: z.string(),
        chapterData: z.string(),
      })
    ),
  }),
  async (req, res) => {
    const { projectId, data } = req.body;

    for (const item of data) {
      await u.db("t_novel").insert({
        projectId,
        chapterIndex: item.index,
        reel: item.reel,
        chapter: item.chapter,
        chapterData: item.chapterData,
        createTime: Date.now(),
      });
    }

    res.status(200).send(success({ message: "新增原文成功" }));
  }
);
