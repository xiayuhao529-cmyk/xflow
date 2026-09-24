import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 更新大纲
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    data: z.string(),
  }),
  async (req, res) => {
    const { id, data } = req.body;

    await u.db("t_outline").where("id", id).update({
      data,
    });

    res.status(200).send(success({ message: "更新大纲成功" }));
  }
);
