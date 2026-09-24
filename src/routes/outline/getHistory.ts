import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 获取历史消息记录
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
  }),
  async (req, res) => {
    const { projectId } = req.body;

    const history = await u
      .db("t_chatHistory")
      .where({ projectId: Number(projectId), type: "outlineWebChat" })
      .first();
    if (!history) {
      await u.db("t_chatHistory").insert({
        projectId: Number(projectId),
        type: "outlineWebChat",
        data: "[]",
      });
    }

    res.status(200).send(success({ data: JSON.parse(history?.data || "[]") }));
  },
);
