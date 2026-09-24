import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    type: z.enum(["text", "image", "video"]),
  }),
  async (req, res) => {
    const { type } = req.body;
    const sqlTableMap = {
      text: "t_textModel",
      image: "t_imageModel",
      video: "t_videoModel",
    };
    const modelLists = await u
      .db(sqlTableMap[type as "image" | "text" | "video"])
      .whereNot("manufacturer", "other")
      .select("id", "manufacturer", "model");

    const result: Record<string, any[]> = {};
    const modelCache: Record<string, Set<string>> = {};

    for (const row of modelLists) {
      if (!result[row.manufacturer]) {
        result[row.manufacturer] = [];
        modelCache[row.manufacturer] = new Set();
      }
      if (!modelCache[row.manufacturer].has(row.model)) {
        result[row.manufacturer].push({ label: row.model, value: row.model });
        modelCache[row.manufacturer].add(row.model);
      }
    }

    res.status(200).send(success(result));
  },
);

