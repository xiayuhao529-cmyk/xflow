import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 新增大纲
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    data: z.string(),
  }),
  async (req, res) => {
    const { projectId, data } = req.body;

    await u.db("t_outline").insert({
      data,
      projectId,
    });

    res.status(200).send(success({ message: "新增大纲成功" }));
  }
);
