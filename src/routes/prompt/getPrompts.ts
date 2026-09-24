import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { v4 as uuid } from "uuid";
const router = express.Router();

// 获取提示词
export default router.get("/", async (req, res) => {
  const data = await u.db("t_prompts");
  res.status(200).send(success(data));
});
