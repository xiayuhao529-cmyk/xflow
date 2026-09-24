import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 删除资产图片
export default router.post(
  "/",
  validateFields({
    imageId: z.number().optional(),
    assetsId: z.number().optional(),
  }),
  async (req, res) => {
    const { imageId, assetsId } = req.body;
    if (assetsId) {
      await u.db("t_assets").where("id", assetsId).update({
        filePath: null,
      });
    }
    if (imageId) {
      await u.db("t_image").where("id", imageId).delete();
    }
    res.status(200).send(success({ message: "删除资产图片成功" }));
  },
);
