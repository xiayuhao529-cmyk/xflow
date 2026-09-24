import logger from "@/logger";
import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post("/", async (req, res) => {
  const { id } = (req as any).user;

  if (id !== 1) return res.status(400).send(error("无权限查看，仅管理员USERID=1可见"));

  const logs = logger.exportLogs();

  res.status(200).send(success(logs));
});
