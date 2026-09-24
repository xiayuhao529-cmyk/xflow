import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    configId: z.number(),
  }),
  async (req, res) => {
    const { id, configId } = req.body;
    if (id) {
      await u.db("t_aiModelMap").where("id", id).update({
        configId,
      });
    }
    res.status(200).send(success("配置成功"));
  },
);
