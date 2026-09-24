import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 获取资产分镜
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
  }),
  async (req, res) => {
    const { projectId } = req.body;

    const data = await u.db("t_script").where("projectId", projectId).select("name", "id").distinct("id", "name").orderBy("name", "asc");

    res.status(200).send(success(data));
  },
);
