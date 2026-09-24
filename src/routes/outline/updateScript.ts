import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 更新前要
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    content: z.string(),
  }),
  async (req, res) => {
    const { id, content } = req.body;

    await u.db("t_script").where("id", id).update({
      content,
    });

    res.status(200).send(success({ message: "更新前要成功" }));
  }
);
