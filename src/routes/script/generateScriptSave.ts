import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { generateScript } from "@/utils/generateScript";
const router = express.Router();

// 生成剧本
export default router.post(
  "/",
  validateFields({
    outlineId: z.number(),
    scriptId: z.number(),
    content: z.string(),
  }),
  async (req, res) => {
    const { outlineId, scriptId, content } = req.body;

    await u.db("t_script").where("id", scriptId).update({
      content: content,
    });

    res.status(200).send(success({ message: "保存成功" }));
  },
);
