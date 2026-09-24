import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 获取项目
export default router.post("/", async (req, res) => {
  const data = await u.db("t_project").select("*");
  res.status(200).send(success(data));
});
