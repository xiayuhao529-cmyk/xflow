import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 保存历史消息记录
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    data: z.string(),
  }),
  async (req, res) => {
    const { projectId, data } = req.body;

    const history = await u
      .db("t_chatHistory")
      .where({ projectId: Number(projectId), type: "outlineWebChat" })
      .first();
    if (!history) {
      await u.db("t_chatHistory").insert({
        projectId: Number(projectId),
        type: "outlineWebChat",
        data: data,
      });
    } else {
      await u
        .db("t_chatHistory")
        .where({ projectId: Number(projectId), type: "outlineWebChat" })
        .update({
          data: data,
        });
    }

    res.status(200).send(success("保存成功"));
  },
);
