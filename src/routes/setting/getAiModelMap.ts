import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";

const router = express.Router();

export default router.post("/", async (req, res) => {
  const configData = await u
    .db("t_aiModelMap")
    .leftJoin("t_config", "t_aiModelMap.configId", "t_config.id")
    .select("t_aiModelMap.name", "t_config.model", "t_aiModelMap.id", "t_aiModelMap.key", "t_config.manufacturer");
  res.status(200).send(success(configData));
});
